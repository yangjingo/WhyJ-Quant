import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations } from "../../../src/storage/index.ts";

test("actual list CLI returns unmodified trading limits and independent WhyJ streaks", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-trading-limits-cli-"));
  const path = join(root, "list.json");
  const previous = process.env.OHQUANT_DIR;
  const symbol = "600000.SH", sessions = ["2025-03-06", "2025-03-07"] as const;
  const tradeDate = sessions[1], observedAt = "2025-03-08T00:00:00Z";
  const requested = { startDate: sessions[0], endDate: tradeDate };
  const coverage = "unknown";
  async function run(action: string, input: unknown) {
    writeFileSync(path, JSON.stringify(input));
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", "observation", action, "--manifest", path], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  try {
    process.env.OHQUANT_DIR = root;
    const meta = { tradeDate, observedAt, coverage } as const;
    const market = await archiveMarketCrossSection({
      market: "A", source: "tushare", tradeDate,
      universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
        members: [{ symbol, name: "Example stock", listedOn: null, industry: null }] },
      bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [] },
      basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
        marketValueUnit: "CNY-ten-thousand", rows: [] },
    });
    const limits = await archiveDailyTradingLimits({
      symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt, coverage, requested, priceUnit: "CNY",
      rows: sessions.map(date => ({ tradeDate: date, previousClose: 10, limitUp: 11, limitDown: 9 })),
    });
    const daily = await archiveTradingDateObservations(sessions.map((date, index) => ({
      schemaVersion: 2, kind: "trading_date_daily_bar", tradeDate: date, symbol, market: "A", assetType: "stock",
      source: "tushare", endpoint: "daily", interval: "1d", calendarTimeZone: "Asia/Shanghai", sourceTimestamp: null,
      observedAt, requested, adjustment: "none", volumeUnit: "hand", amountUnit: "CNY-thousand", coverage,
      values: { open: 10 + index, high: 10 + index, low: 10 + index, close: 10 + index, volume: 100, amount: null },
    })));
    const calendar = { revision: "fixture-cn-exchange", sessions };
    const history = { symbol, dailyRevision: daily.revision, limitsRevision: limits.revision };
    const manifest = { version: 1, marketRevision: market.revision, adjustment: "none", stocks: [history], limitCalendar: calendar };
    const replay = await run("replay-list-rows", manifest);
    expect(replay).toMatchObject({ code: 0, output: { ok: true, data: {
      limitCalendar: { ...calendar, zone: "Asia/Shanghai" },
      rows: [{ observations: { tradingLimits: { ref: limits, priceUnit: "CNY", source: "tushare", endpoint: "stk_limit",
        row: { tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 } } },
      metrics: { limitStreaks: { producer: "whyj", formula: { id: "tsp_limit_streaks" }, consecutiveLimitUps: 1, consecutiveLimitDowns: 0 } } }],
    } } });
    expect(await run("read-list-quotes", manifest)).toMatchObject({ code: 0, output: { ok: true, data: {
      fixed: replay.output.data, quotes: { status: "outside-current-day" },
    } } });
    expect(replay.output.data.rows[0].observations).not.toHaveProperty("dailyCandles");
    const candleManifest = { ...manifest, stocks: [{ ...history, candleBars: 5 }] };
    const candles = await run("replay-list-rows", candleManifest);
    expect(candles).toMatchObject({ code: 0, output: { ok: true, data: {
      rows: [{ observations: { dailyCandles: { ref: daily, requestedBars: 5, source: "tushare",
        volumeUnit: "hand", amountUnit: "CNY-thousand", adjustment: "none",
        rows: sessions.map((date, index) => ({ tradeDate: date, close: 10 + index, volume: 100, amount: null, sourceTimestamp: null })),
      } } }],
    } } });
    expect(await run("read-list-quotes", candleManifest)).toMatchObject({ code: 0, output: { ok: true, data: {
      fixed: candles.output.data, quotes: { status: "outside-current-day" },
    } } });
    for (const stock of [{ symbol, candleBars: 5 }, { ...history, candleBars: 4 }, { ...history, candleBars: "12" }]) {
      expect(await run("replay-list-rows", { ...manifest, stocks: [stock] })).toMatchObject({
        code: 1, output: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
    expect(await run("replay-list-rows", { ...candleManifest, stocks: [{ symbol, dailyRevision: "e".repeat(64), candleBars: 5 }] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    const sourceOnly = await run("replay-list-rows", { ...manifest, stocks: [{ symbol, tradingLimitsRevision: limits.revision }] });
    expect(sourceOnly.output.data.rows[0].observations.tradingLimits).toEqual(replay.output.data.rows[0].observations.tradingLimits);
    expect(sourceOnly.output.data.rows[0].metrics.limitStreaks).toMatchObject({ consecutiveLimitUps: null, consecutiveLimitDowns: null });
    const legacy = await run("replay-list-rows", { ...manifest, stocks: [{ symbol }], limitCalendar: undefined });
    expect(legacy).toMatchObject({ code: 0, output: { ok: true } });
    expect(legacy.output.data).not.toHaveProperty("limitCalendar");
    expect(legacy.output.data.rows[0].observations).not.toHaveProperty("tradingLimits");
    for (const patch of [{ limitCalendar: { ...calendar, sessions: sessions.toReversed() } },
      { limitCalendar: { ...calendar, sessions: [...sessions, tradeDate] } },
      { limitCalendar: { ...calendar, inferred: true } }, { stocks: [{ ...history, tradingLimitsRevision: limits.revision }] }]) {
      expect(await run("replay-list-rows", { ...manifest, ...patch })).toMatchObject({
        code: 1, output: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
    expect(await run("replay-list-rows", { ...manifest, stocks: [{ symbol, tradingLimitsRevision: "e".repeat(64) }] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

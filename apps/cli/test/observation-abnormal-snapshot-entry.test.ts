import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";

test("CLI rebuilds the dated abnormal snapshot with exact local archive revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-abnormal-cli-"));
  const manifest = join(root, "scope.json");
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const symbol = "600001.SH", tradeDate = "2024-03-04", before = "2024-03-01", observedAt = "2024-03-05T00:00:00Z";
  const metadata = { tradeDate, observedAt, coverage: "unknown" } as const;
  const market: StoredMarketCrossSection = {
    market: "A", source: "tushare", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "fixture", listedOn: null, industry: null }] },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: 9.09,
        changeCny: 0.91, returnPct: 10, volume: 1, amount: 100 }] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    const sessions = [before, tradeDate], requested = { startDate: before, endDate: tradeDate };
    const [marketRef, daily, limits] = await Promise.all([
      archiveMarketCrossSection(market),
      archiveTradingDateObservations(sessions.map((date): StoredTradingDateBarObservation => ({
        schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate: date, market: "A", assetType: "stock",
        calendarTimeZone: "Asia/Shanghai", interval: "1d", source: "tickflow", endpoint: "/v1/klines", adjustment: "none",
        sourceTimestamp: Date.parse(date + "T15:00:00+08:00"), observedAt, requested,
        volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
        values: { open: 10, high: 10, low: 10, close: 10, volume: 100, amount: null },
      }))),
      archiveDailyTradingLimits({
        symbol, source: "tushare", endpoint: "stk_limit", market: "A", observedAt, requested, priceUnit: "CNY", coverage: "unknown",
        rows: [{ tradeDate: before, previousClose: 10, limitUp: 11, limitDown: 9 },
          { tradeDate, previousClose: 9.09, limitUp: 10, limitDown: 8.18 }],
      }),
    ]);
    const input = { version: 1, marketRevision: marketRef.revision, sessions, adjustment: "none",
      histories: [{ symbol, dailyRevision: daily.revision, limitsRevision: limits.revision }] };
    const original = JSON.stringify(input);
    writeFileSync(manifest, original);
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation replay-abnormal-snapshot");
    const command = ["observation", "replay-abnormal-snapshot", "--manifest", manifest];
    const result = await run(...command);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", market: { ref: marketRef, tradeDate, source: "tushare" },
      histories: [{ daily: { ref: daily }, exchange: { limits: { ref: limits } } }],
      counts: { limit_up: 1 }, unknown: { new_high: 1 },
      rows: [{ symbol, signals: ["limit_up"], changeFraction: 0.1, derived: { consecutiveLimitUps: 1 } }],
    } } });
    expect(await run(...command)).toEqual(result);
    expect(readFileSync(manifest, "utf8")).toBe(original);
    writeFileSync(manifest, JSON.stringify({ ...input, limit: 2001 }));
    expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    writeFileSync(manifest, JSON.stringify({ ...input, marketRevision: "f".repeat(64) }));
    expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

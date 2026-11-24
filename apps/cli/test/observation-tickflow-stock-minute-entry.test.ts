import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveDatedStockMinutes, archiveMarketCrossSection } from "../../../src/storage/index.ts";

const first = "2024-04-08", second = "2024-04-09", symbol = "600001.SH";
const stamp = (date: string, time: string) => Date.parse(date + "T" + time + "+08:00");
const times = ["09:30:00", "09:30:59.123", "09:31:00", "09:32:00"].map(time => stamp(first, time));

test("CLI replays fixed intraday chart evidence from stock-list manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-intraday-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const manifestPath = join(root, "stock minute.json");
  async function invoke(action: string, value: unknown) {
    writeFileSync(manifestPath, JSON.stringify(value));
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", "observation", action, "--manifest", manifestPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }

  process.env.OHQUANT_DIR = root;
  try {
    const batch = {
      source: "tickflow", endpoint: "/v1/klines", market: "A", symbol, assetType: "stock", tradeDate: first,
      observedAt: "2024-04-10T01:00:00Z", coverage: "unknown", interval: "1m", adjustment: "none",
      priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native",
      timeZone: "Asia/Shanghai", timestampLabel: "provider-native", finality: "unknown",
    } as const;
    const rows = [99, 88, 9, 11].map((close, index) => ({
      sourceTimestamp: times[index]!, open: close, high: close, low: close, close, volume: 1, amount: close / 10,
    }));
    const refs = await Promise.all([archiveDatedStockMinutes({ ...batch, rows }),
      archiveDatedStockMinutes({ ...batch, tradeDate: second, rows: [] })]);
    const closeRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit",
      observedAt: batch.observedAt, requested: { startDate: first, endDate: second }, coverage: "unknown", priceUnit: "CNY",
      rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const priceBasis = "caller-confirmed-same-basis" as const;
    const interpretation = { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY",
      volumeUnit: "hand", amountUnit: "CNY-thousand" } as const;
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const listMeta = { tradeDate: first, observedAt: "2024-04-10T01:00:00Z", coverage: "unknown" } as const;
    const marketRef = await archiveMarketCrossSection({
      market: "A", source: "tushare", tradeDate: first,
      universe: { ...listMeta, endpoint: "bak_basic", universe: "provider-dated-stocks",
        members: [{ symbol, name: "Fixture", listedOn: null, industry: null }] },
      bars: { ...listMeta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
        amountUnit: "CNY-thousand", rows: [] },
      basics: { ...listMeta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
        marketValueUnit: "CNY-ten-thousand", rows: [] },
    });
    const intraday = { minuteRevision: refs[0].revision, interpretation, previousClose: { revision: closeRef.revision, priceBasis } };
    const list = { version: 1, marketRevision: marketRef.revision, adjustment: "none", stocks: [{ symbol, intraday }] };
    const fixed = await invoke("replay-list-rows", list);
    expect(fixed).toMatchObject({ code: 0, output: { ok: true, data: { rows: [{
      observations: { intraday: { ref: refs[0], tradeDate: first, volumeUnit: "provider-native", interpretation } },
      metrics: { intraday: { producer: "whyj", latestReturnFraction: 11 / 10 - 1,
        plotBaseline: { kind: "previous-close", value: 10 },
        points: [{ minute: "09:30", sourceTimestamp: times[2], close: 9, averageClose: 9 },
          { minute: "09:31", sourceTimestamp: times[3], close: 11, averageClose: 10 }] } },
    }] } } });
    expect(await invoke("read-list-quotes", list)).toMatchObject({ code: 0, output: { ok: true,
      data: { fixed: fixed.output.data, quotes: { status: "outside-current-day" } } } });
    const legacy = await invoke("replay-list-rows", { ...list, stocks: [{ symbol }] });
    expect(legacy.code).toBe(0);
    expect(legacy.output.data.rows[0].observations).not.toHaveProperty("intraday");
    for (const entry of [{ ...intraday, minuteRevision: undefined }, { ...intraday, date: first },
      { ...intraday, interpretation: { ...interpretation, amountUnit: "unknown" } }]) {
      expect(await invoke("replay-list-rows", { ...list, stocks: [{ symbol, intraday: entry }] })).toMatchObject(invalid);
    }
    for (const minuteRevision of [refs[1].revision, "e".repeat(64)]) {
      expect(await invoke("replay-list-rows", { ...list, stocks: [{ symbol, intraday: { ...intraday, minuteRevision } }] }))
        .toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    }
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

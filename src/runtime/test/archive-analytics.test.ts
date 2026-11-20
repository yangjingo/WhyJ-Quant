import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTradingDateObservations, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { deriveTspArchiveAnalytics } from "../data/archive-analytics.ts";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-archive-analytics-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const dates = Array.from({ length: 130 }, (_, i) => new Date(Date.UTC(2024, 0, i + 2)).toISOString().slice(0, 10));
const requested = { startDate: dates[0]!, endDate: dates.at(-1)! };
function bars(source: "tickflow" | "tushare"): StoredTradingDateBarObservation[] {
  return dates.map((tradeDate, i) => {
    const close = 10 + 0.2 * i;
    return {
      schemaVersion: 2, kind: "trading_date_daily_bar", symbol: "600000.SH", tradeDate, requested,
      market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source,
      observedAt: "2024-06-01T01:00:00Z", interval: "1d", adjustment: "none", coverage: "unknown",
      ...(source === "tushare" ? { endpoint: "daily", volumeUnit: "hand", amountUnit: "CNY-thousand", sourceTimestamp: null } :
        { endpoint: "/v1/klines", volumeUnit: "unknown", amountUnit: "unknown", sourceTimestamp: Date.parse(`${tradeDate}T00:00:00+08:00`) }),
      values: { open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100, amount: 275 },
    };
  });
}

test("fixed archives produce all research and chart groups with exact source units and no provider access", async () => {
  const [known, unknown] = await Promise.all([
    archiveTradingDateObservations(bars("tushare").toReversed()), archiveTradingDateObservations(bars("tickflow")),
  ]);
  const fetcher = spyOn(globalThis, "fetch");
  try {
    const tushare = await deriveTspArchiveAnalytics(known);
    const tickflow = await deriveTspArchiveAnalytics(unknown);
    expect(await deriveTspArchiveAnalytics(known)).toEqual(tushare);
    expect(tushare.archiveRef).toEqual(known);
    expect(tushare.input).toMatchObject({ source: "tushare", endpoint: "daily", adjustment: "none", usableCnyAmounts: 130,
      volumeUnit: "hand", amountUnit: "CNY-thousand", rowCount: 130, firstTradeDate: dates[0], lastTradeDate: dates.at(-1) });
    expect(tickflow.input).toMatchObject({ source: "tickflow", usableCnyAmounts: 0, volumeUnit: "unknown", amountUnit: "unknown" });
    for (const result of [tushare, tickflow]) {
      expect(result.researchFactors).toMatchObject({ producer: "whyj", formula: { id: "tsp_research_factors", version: 1 }, asOf: dates.at(-1) });
      expect(Object.keys(result.researchFactors.values)).toHaveLength(77);
      expect(result.priceLevels).toMatchObject({ producer: "whyj", formula: { id: "tsp_price_levels", version: 1 },
        asOf: dates.at(-1), volumeProfileBasis: "volume-only" });
      expect(Object.keys(result.priceLevels.levels)).toHaveLength(11);
      expect(result.priceLevels.levels.keltner_l).toHaveLength(2);
      expect(result.researchFactors.values).toMatchObject({ turnover_rate: null, limit_up_count_20d: null, roe_latest: null });
    }
    expect(tushare.researchFactors.values.log_amount).toBeCloseTo(Math.log1p(275_000), 10);
    expect(tushare.researchFactors.values.vwap_bias).toBeCloseTo(35.8 / 27.5 - 1, 10);
    expect(tushare.researchFactors.values.amihud_20d).toBeGreaterThan(0);
    expect(tickflow.researchFactors.values).toMatchObject({ log_amount: null, vwap_bias: null, amihud_20d: null });
    expect(tickflow.researchFactors.values.ma20_bias).toBe(tushare.researchFactors.values.ma20_bias);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

test("missing, damaged and cancelled reads fail without a fallback archive", async () => {
  const ref = await archiveTradingDateObservations(bars("tushare"));
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(deriveTspArchiveAnalytics(ref, cancelled.signal)).rejects.toThrow();
  await expect(deriveTspArchiveAnalytics({ version: 2, revision: "a".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(root, "data", "observation-archives-v2", `${ref.revision}.json`), "{}");
  await expect(deriveTspArchiveAnalytics(ref)).rejects.toThrow("damaged");
});

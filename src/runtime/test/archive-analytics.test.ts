import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../storage/index.ts";
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

const marketSection = (tradeDate: string, value: number | null, symbol = "600000.SH"): StoredMarketCrossSection => {
  const metadata = { tradeDate, observedAt: "2024-06-01T02:00:00Z", coverage: "unknown" } as const;
  return {
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [] },
    bars: { ...metadata, endpoint: "daily", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", adjustment: "none", rows: [] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY",
      shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [{
        symbol, close: null, turnoverPct: value, freeFloatTurnoverPct: 99, providerVolumeRatio: null,
        totalShares: null, floatShares: null, freeFloatShares: null, pe: null, peTtm: null, pb: null,
        totalMarketValue: null, circulatingMarketValue: null,
      }],
    },
  };
};

test("joins percentage-point turnover by exact dates and reuses native analytics", async () => {
  const rows = bars("tushare").slice(-25);
  const series = await archiveTradingDateObservations(rows);
  const inputs = await Promise.all(rows.map(({ tradeDate }, index) =>
    archiveMarketCrossSection(marketSection(tradeDate, index === 24 ? 4 : index === 19 ? 0 : 2))));
  const http = spyOn(globalThis, "fetch");
  try {
    const result = await deriveTspArchiveAnalytics(series, undefined, { turnoverArchives: inputs.toReversed() });
    expect(await deriveTspArchiveAnalytics(series, undefined, { turnoverArchives: inputs })).toEqual(result);
    const { turnover_rate, turnover_ratio_5d, turnover_mean_20d, log_float_mv } = result.researchFactors.values;
    expect(turnover_rate).toBe(4);
    expect(turnover_ratio_5d).toBeCloseTo(4 / 1.6 - 1, 10);
    expect(turnover_mean_20d).toBeCloseTo(2, 10);
    expect(log_float_mv).toBeCloseTo(Math.log(35.8 * 10000 / 0.04 / 10000), 10);
    expect(result.priceLevels.volumeProfileBasis).toBe("turnover-decay");
    expect(result.input.turnoverInputs).toHaveLength(25);
    expect(result.input.turnoverInputs?.[19]).toMatchObject({ archiveRef: inputs[19], tradeDate: rows[19]!.tradeDate,
      source: "tushare", endpoint: "daily_basic", observedAt: "2024-06-01T02:00:00Z", unit: "percentage-point",
      availability: "reported", value: 0, coverage: "unknown" });
    const baseReplay = await deriveTspArchiveAnalytics(series);
    expect(baseReplay.input.turnoverInputs).toBeUndefined();
    expect(baseReplay.researchFactors.values.turnover_rate).toBeNull();
    expect(baseReplay.priceLevels.volumeProfileBasis).toBe("volume-only");
    expect(result.priceLevels.levels.sr).not.toEqual(baseReplay.priceLevels.levels.sr);
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

test("keeps unavailable histories separate and refuses conflicting or damaged references", async () => {
  const rows = bars("tushare").slice(-8);
  const series = await archiveTradingDateObservations(rows);
  const date = rows.at(-1)!.tradeDate;
  const zero = await archiveMarketCrossSection(marketSection(rows.at(-3)!.tradeDate, 0));
  const unreported = await archiveMarketCrossSection(marketSection(rows.at(-2)!.tradeDate, null));
  const missing = await archiveMarketCrossSection(marketSection(date, 5, "600001.SH"));
  const partial = await deriveTspArchiveAnalytics(series, undefined, { turnoverArchives: [missing, zero, unreported] });
  expect(partial.input.turnoverInputs?.map(input => [input.availability, input.value])).toEqual([
    ["reported", 0], ["unreported", null], ["missing-symbol", null],
  ]);
  expect(partial.priceLevels.volumeProfileBasis).toBe("partial-turnover");
  expect(partial.researchFactors.values.turnover_rate).toBeNull();
  expect(partial.researchFactors.values.turnover_ratio_5d).toBeNull();
  const corrected = await archiveMarketCrossSection(marketSection(date, 6));
  const foreign = await archiveMarketCrossSection(marketSection(dates[0]!, 2));
  for (const refs of [[missing, corrected], [zero, zero], [foreign]]) {
    await expect(deriveTspArchiveAnalytics(series, undefined, { turnoverArchives: refs })).rejects.toThrow("date or market");
  }
  await expect(deriveTspArchiveAnalytics(series, AbortSignal.abort(), { turnoverArchives: [zero] })).rejects.toThrow();
  await expect(deriveTspArchiveAnalytics(series, undefined, { turnoverArchives: [{ ...zero, revision: "f".repeat(64) }] }))
    .rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(root, "data", "market-cross-section-archives-v1", zero.revision + ".json"), "{}");
  await expect(deriveTspArchiveAnalytics(series, undefined, { turnoverArchives: [zero] })).rejects.toThrow("damaged");
});

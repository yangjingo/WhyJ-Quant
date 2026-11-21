import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveBenchmarkIndexObservations, archiveDailyTradingLimits, archiveFinancialObservations, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredTradingDateBarObservation,
} from "../../storage/index.ts";
import { replayTspFactorEvaluation, type FactorEvaluationReplayRequest } from "../data/factor-evaluation-replay.ts";

const A = "600001.SH", B = "000001.SZ", C = "300001.SZ";
const sessions = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14"];
const observedAt = "2026-03-04T08:00:00Z";
const observed = { market: "A", source: "tushare", coverage: "unknown" } as const;
const noCosts = { groupCount: 3, feesFraction: 0, slippageBps: 0 };

function archivePrices(symbol: string, dates: readonly string[], closes: readonly number[], forward = false) {
  const prices: StoredTradingDateBarObservation[] = dates.map((tradeDate, i) => {
    const close = closes[i]!;
    return {
      ...observed, schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate,
      observedAt, sourceTimestamp: forward ? Date.parse(tradeDate + "T15:00:00+08:00") : null,
      requested: { startDate: dates[0]!, endDate: dates.at(-1)! }, assetType: "stock", calendarTimeZone: "Asia/Shanghai",
      source: forward ? "tickflow" : "tushare", endpoint: forward ? "/v1/klines" : "daily", interval: "1d",
      adjustment: forward ? "forward" : "none", volumeUnit: forward ? "unknown" : "hand",
      amountUnit: forward ? "unknown" : "CNY-thousand",
      values: { open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, amount: close * 10 },
    };
  });
  return archiveTradingDateObservations(prices);
}

function turnoverArchive(tradeDate: string) {
  const stamp = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({
    source: "tushare", market: "A", tradeDate,
    universe: { ...stamp, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [] },
    bars: { ...stamp, endpoint: "daily", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", adjustment: "none", rows: [] },
    basics: { ...stamp, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand",
      rows: [{ symbol: A, close: 12, turnoverPct: 2.5, freeFloatTurnoverPct: null, providerVolumeRatio: null,
        totalShares: null, floatShares: null, freeFloatShares: null, pe: null, peTtm: null, pb: null,
        totalMarketValue: null, circulatingMarketValue: null }] },
  });
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-factor-evaluation-replay-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("uses exact composite price revisions and keeps warm-up outside the diagnostic sample", async () => {
  const warm = await archivePrices(A, sessions.slice(0, 5), [10, 11, 12, 13, 14]);
  const late = await archivePrices(A, sessions.slice(5), [15, 16, 17]);
  const down = await archivePrices(B, sessions, [20, 19, 18, 17, 16, 15, 14, 13]);
  const flat = await archivePrices(C, sessions, Array(8).fill(10));
  const request: FactorEvaluationReplayRequest = {
    factorId: "momentum_5d", rebalance: "daily", sessions, evaluationStart: sessions[5], groups: noCosts,
    symbols: [{ symbol: A, dailyRefs: [late, warm] }, { symbol: B, dailyRefs: [down] }, { symbol: C, dailyRefs: [flat] }],
  };
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  try {
    const result = await replayTspFactorEvaluation(request);
    expect(result.panel.sessions).toEqual(sessions.slice(5));
    expect(result.panel.rows).toHaveLength(9);
    expect(result.panel.rows[0]).toEqual({ symbol: A, tradeDate: sessions[5]!, close: 15, factor: 0.5 });
    expect(result.information.series).toEqual([
      { tradeDate: sessions[5]!, outcomeDate: sessions[6]!, pairCount: 3, ic: 1 },
      { tradeDate: sessions[6]!, outcomeDate: sessions[7]!, pairCount: 3, ic: 1 },
    ]);
    expect(result.grouping.groupStats.at(-1)).toMatchObject({ label: "Q3", totalReturn: 0.1333 });
    expect(result.grouping.longShort).toMatchObject({ topGroup: "Q3", bottomGroup: "Q1", executableShort: false });
    expect(result.input.symbols[0]?.daily.map(item => [item.ref, item.rowsUsed])).toEqual([[late, 3], [warm, 5]]);
    expect(await replayTspFactorEvaluation(request)).toEqual(result);
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

test("attaches dated turnover and verified unadjusted closing-limit observations", async () => {
  const dates = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10));
  const raw = await archivePrices(A, dates, Array(21).fill(10));
  const limits = await archiveDailyTradingLimits({
    ...observed, symbol: A, endpoint: "stk_limit", observedAt, priceUnit: "CNY",
    requested: { startDate: dates[0]!, endDate: dates.at(-1)! },
    rows: dates.map((tradeDate, i) => ({ tradeDate, previousClose: 10, limitUp: i === 0 ? 10 : 11, limitDown: 9 })),
  });
  const turnover = await turnoverArchive(dates[19]!);
  const request: FactorEvaluationReplayRequest = {
    factorId: "limit_up_count_20d", rebalance: "daily", sessions: dates, evaluationStart: dates[18],
    symbols: [{ symbol: A, dailyRefs: [raw], exchange: { limitRefs: [limits] } }], turnoverRefs: [turnover],
  };
  const result = await replayTspFactorEvaluation(request);
  expect(result.panel.rows.map(row => row.factor)).toEqual([null, 1, 0]);
  expect(result.input.symbols[0]?.exchange?.limits[0]?.ref).toEqual(limits);
  const turnoverResult = await replayTspFactorEvaluation({ ...request, factorId: "turnover_rate" });
  expect(turnoverResult.panel.rows.map(row => row.factor)).toEqual([null, 2.5, null]);
  expect(turnoverResult.input.turnover[0]).toMatchObject({ ref: turnover, tradeDate: dates[19], observedAt, endpoint: "daily_basic" });
});

test("resolves financial evidence per date and needs explicit PB basis for each eligible revision", async () => {
  const prices = await archivePrices(A, sessions, [10, 11, 12, 13, 14, 15, 16, 17]);
  const periodEnd = "2025-12-31", actualDisclosureDate = "2026-01-05";
  const report = (captureTime: string, bps: number, roe: number) => archiveFinancialObservations({
    ...observed, symbol: A, endpoint: "fina_indicator", observedAt: captureTime, requested: { startPeriod: periodEnd, endPeriod: periodEnd },
    rows: [{ periodEnd, announcementDate: actualDisclosureDate, updateFlag: "1", bookValuePerShare: bps, bookValueCurrency: "unknown",
      roe, grossProfitMargin: 0, netProfitMargin: null, operatingRevenueYoyPct: 4, totalOperatingRevenueYoyPct: 5,
      parentNetProfitYoyPct: 6, debtToAssets: 71, ratioUnit: "provider-native" }],
  });
  const first = await report("2026-01-06T01:00:00Z", 4, 7);
  const revision = await report("2026-01-08T01:00:00Z", 8, 9);
  const disclosure = await archiveFinancialObservations({
    ...observed, symbol: A, endpoint: "disclosure_date", requested: { periodEnd }, observedAt: "2026-01-06T01:05:00Z",
    rows: [{ periodEnd, actualDisclosureDate, planAnnouncementDate: null, plannedDisclosureDate: null, modificationRecord: null }],
  });
  const request: FactorEvaluationReplayRequest = {
    factorId: "roe_latest", rebalance: "daily", sessions,
    symbols: [{ symbol: A, dailyRefs: [prices], financialRefs: [revision, disclosure, first],
      bookValueBasis: [{ reportRevision: first.revision, periodEnd, basis: "caller-confirmed-unadjusted-CNY" }] }],
  };
  const result = await replayTspFactorEvaluation(request);
  expect(result.panel.rows.map(row => row.factor)).toEqual([null, null, 7, 7, 9, 9, 9, 9]);
  const pb = await replayTspFactorEvaluation({ ...request, factorId: "pb_latest" });
  expect(pb.panel.rows.map(row => row.factor)).toEqual([null, null, 3, 3.25, null, null, null, null]);
  expect(result.input.symbols[0]?.financial[4]).toMatchObject({ status: "available",
    reportEvidence: [{ ref: revision }], disclosureEvidence: [{ ref: disclosure }] });
});

test("rejects unknown keys, mixed adjustment bases, duplicate and off-calendar observations", async () => {
  const first = await archivePrices(A, sessions, Array(8).fill(10));
  const mixed = await archivePrices(B, sessions, Array(8).fill(12), true);
  const base: FactorEvaluationReplayRequest = {
    factorId: "amplitude", rebalance: "daily", sessions, symbols: [{ symbol: A, dailyRefs: [first] }],
  };
  await expect(replayTspFactorEvaluation({ ...base, factorId: "toString" })).rejects.toThrow("Unknown TSP research factor");
  await expect(replayTspFactorEvaluation({ ...base, symbols: [{ symbol: A, dailyRefs: [first, first] }] }))
    .rejects.toThrow("Ambiguous factor evaluation price date");
  await expect(replayTspFactorEvaluation({ ...base, sessions: sessions.filter(date => date !== sessions[1]) }))
    .rejects.toThrow("off-calendar");
  await expect(replayTspFactorEvaluation({ ...base, symbols: [...base.symbols, { symbol: B, dailyRefs: [mixed] }] }))
    .rejects.toThrow("Incompatible factor evaluation price basis");
  await expect(replayTspFactorEvaluation(base, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("replays earlier market environment from fixed references with exact calendar alignment", async () => {
  const daily = await archivePrices(A, sessions, [10, 11, 12, 13, 14, 15, 16, 17]);
  const environmentSessions = sessions.slice(4);
  const observedSessions = environmentSessions.slice(0, -1);
  const marketRefs = await Promise.all(observedSessions.map(turnoverArchive));
  const benchmark = await archiveBenchmarkIndexObservations({
    symbol: "000001.SH", ...observed, endpoint: "index_daily", observedAt, priceUnit: "index-points",
    returnUnit: "percentage-points", requested: { start: environmentSessions[0]!, end: environmentSessions.at(-1)! },
    rows: observedSessions.map((tradeDate, i) => {
      const change = i === 0 ? 3 : -3;
      return { tradeDate, closePoints: 100 + change, previousClosePoints: 100, changePoints: change, returnPct: change };
    }),
  });
  const request: FactorEvaluationReplayRequest = {
    factorId: "momentum_5d", rebalance: "daily", sessions, evaluationStart: sessions[5],
    symbols: [{ symbol: A, dailyRefs: [daily] }],
    marketEnvironment: { sessions: environmentSessions, marketRefs, limitRefs: [], priceHistory: [],
      benchmark: { symbol: "000001.SH", refs: [benchmark] } },
  };
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  try {
    const result = await replayTspFactorEvaluation(request);
    expect(result.input.marketEnvironment).toMatchObject({
      scope: { phaseMode: "causal", marketRefs, benchmark: { refs: [benchmark] } }, precedingSession: environmentSessions[0],
    });
    expect(result.input.marketEnvironment?.observations.map(row => row.tradeDate)).toEqual(observedSessions);
    expect(result.information.marketRegime?.assignments.map(row => [row.tradeDate, row.previousTradeDate]))
      .toEqual([[sessions[5]!, sessions[4]!], [sessions[6]!, sessions[5]!], [sessions[7]!, sessions[6]!]]);
    expect(result.information.marketRegime?.assignments.map(row => row.score)).toEqual([53, 43, 43]);
    expect(result.information.marketRegime?.buckets).toMatchObject([
      { state: "range", meanScore: 53, nDates: 1, nIcDates: 0 },
      { state: "weak", meanScore: 43, nDates: 2, nIcDates: 0 },
    ]);
    const env = request.marketEnvironment!;
    await expect(replayTspFactorEvaluation({ ...request, marketEnvironment: { ...env, sessions: environmentSessions.slice(1) } }))
      .rejects.toThrow("Market environment calendar does not match factor evaluation");
    await expect(replayTspFactorEvaluation({ ...request, marketEnvironment: { ...env, marketRefs: [marketRefs[0]!, marketRefs[2]!] } }))
      .rejects.toThrow("Missing previous-session factor regime " + sessions[5]!);
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

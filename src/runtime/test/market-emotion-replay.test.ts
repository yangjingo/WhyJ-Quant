import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveBenchmarkIndexObservations, archiveDailyTradingLimits, archiveDepthSnapshot, archiveMarketCrossSection, archiveRiskWarningObservations, archiveSectorObservations,
  archiveTradingDateObservations, type StoredTradingDateBarObservation,
} from "../../storage/index.ts";
import { replayTspMarketEmotion } from "../data/market-emotion-replay.ts";

const sessions = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09"] as const;
const previousDate = sessions[4], target = sessions[5], observedAt = "2025-01-10T00:00:00Z";
const symbols = ["600001.SH", "600002.SH"] as const;
const [leader, other] = symbols;

function market(tradeDate: string, otherDown = false) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({ source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, industry: null, listedOn: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.map(symbol => {
        const sealed = symbol === leader && tradeDate >= previousDate;
        const broke = symbol === other && tradeDate === target;
        const close = sealed ? 11 : otherDown && broke ? 9 : 10;
        return { symbol, open: 10, high: sealed || broke ? 11 : 10, low: Math.min(10, close), close,
          exRightsPreviousClose: 10, changeCny: close - 10, returnPct: (close - 10) * 10,
          volume: symbol === leader && tradeDate === target ? 200 : 100, amount: 1 };
      }) },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

function adjusted(symbol: string, close: number, priorDate: string = previousDate) {
  return archiveTradingDateObservations([priorDate, target].map<StoredTradingDateBarObservation>((tradeDate, index) => {
    const price = index ? close : 100;
    return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, observedAt,
      sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00"), requested: { startDate: priorDate, endDate: target },
      source: "tickflow", endpoint: "/v1/klines", market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
      interval: "1d", adjustment: "forward", volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
      values: { open: price, high: price, low: price, close: price, volume: 100, amount: null },
    };
  }));
}

function benchmark(symbol: string, closePoints: number, tradeDate: string = target) {
  return archiveBenchmarkIndexObservations({ source: "tushare", market: "A", endpoint: "index_daily", observedAt,
    coverage: "unknown", symbol, priceUnit: "index-points", returnUnit: "percentage-points",
    requested: { start: previousDate, end: target },
    rows: [{ tradeDate, closePoints, previousClosePoints: 1000, changePoints: closePoints - 1000, returnPct: null }],
  });
}

function tickflowBenchmark(symbol: string, previous: number, current: number, priorDate: string = previousDate) {
  return archiveBenchmarkIndexObservations({ symbol, source: "tickflow", market: "A",
    endpoint: "/v1/klines", observedAt, coverage: "unknown", priceUnit: "index-points", returnUnit: "percentage-points",
    requested: { start: priorDate, end: target },
    rows: [priorDate, target].map((tradeDate, index) => ({ tradeDate,
      closePoints: index === 0 ? previous : current, sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00"),
      previousClosePoints: null, changePoints: null, returnPct: null })),
  });
}

async function sector(kind: "concept" | "industry") {
  const meta = { market: "A", source: "tushare", tradeDate: target, observedAt, coverage: "unknown", taxonomy: "eastmoney" } as const;
  const sectorCode = "BK1000.DC";
  const catalogRef = await archiveSectorObservations({ ...meta, endpoint: "dc_index", kind, providerType: kind === "concept" ? "概念板块" : "行业板块",
    groups: [{ code: sectorCode, name: kind === "concept" ? "Leader" : "I-Shared-X", level: null },
      { code: "BK2000.DC", name: "Uncollected", level: null }] });
  const memberRef = await archiveSectorObservations({ ...meta, endpoint: "dc_member", sectorCode,
    members: (kind === "concept" ? [leader] : symbols).map(symbol => ({ symbol, name: null })) });
  return { catalogRef, memberRefs: [memberRef] };
}

const unrelated = "600003.SH";
function depthArchive(tradeDate: string = target) {
  const timestamp = Date.parse(tradeDate + "T15:00:00+08:00");
  return archiveDepthSnapshot({ source: "tickflow", endpoint: "/v1/depth", market: "A", tradeDate,
    observedAt: new Date(timestamp + 10_000).toISOString(), coverage: "unknown", volumeUnit: "unknown",
    requestedSymbols: [leader, other, unrelated], rows: [
      { symbol: leader, timestamp, bids: [{ price: 11, volume: 200 }], asks: [{ price: 11.01, volume: 500 }] },
      { symbol: other, timestamp: timestamp + 5_000, bids: [{ price: 0, volume: 0 }], asks: [{ price: 9, volume: 500 }] },
      { symbol: unrelated, timestamp, bids: [], asks: [] },
    ],
  });
}

async function fixture() {
  const marketRefs = await Promise.all(sessions.map(tradeDate => market(tradeDate)));
  const limitRefs = await Promise.all(symbols.map(symbol => archiveDailyTradingLimits({ source: "tushare", market: "A", endpoint: "stk_limit",
    symbol, observedAt, coverage: "unknown", priceUnit: "CNY", requested: { startDate: sessions[0], endDate: target },
    rows: sessions.map(tradeDate => ({ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 })),
  })));
  const priceRefs = await Promise.all([adjusted(leader, 104), adjusted(other, 96)]);
  const indexRefs = await Promise.all([benchmark("000001.SH", 1010), benchmark("399001.SZ", 970),
    benchmark("000680.SH", 1040), benchmark("399006.SZ", 1050, previousDate)]);
  return { sessions, marketRefs, limitRefs, priceRefs, indexRefs, sectors: { concept: await sector("concept"), industry: await sector("industry") } };
}

let root: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-market-emotion-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("replays the six-dimensional dashboard from the exact archive revisions without calling providers", async () => {
  const request = await fixture();
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Archive replay must stay offline"));
  try {
    const result = await replayTspMarketEmotion(request);
    expect(result).toMatchObject({
      status: "computed", tradingDate: target, producer: "whyj", calendar: { sessions },
      input: { market: { ref: request.marketRefs[5] }, prices: [{ archiveRef: request.priceRefs[0], adjacent: true },
        { archiveRef: request.priceRefs[1], adjacent: true }],
      sectors: [{ kind: "concept", coverage: { archivedGroups: 1, uncollectedGroupIds: ["BK2000.DC"] } },
        { kind: "industry", coverage: { archivedGroups: 1, uncollectedGroupIds: ["BK2000.DC"] } }] },
      dashboard: { metrics: { up_pct: 50, down_pct: 50, strong_diff_pct: 0, avg_vol_ratio: 1.5, high_vol_pct: 50,
        limit_up: 1, seal_rate: 50, max_boards: 2, tier2_count: 1, mainline_cover_pct: 100 },
      emotion: { observedDimensions: 6 } },
    });
    expect(result.input.volumes.map(row => row.archiveRef)).toEqual(request.marketRefs.slice(0, 5));
    expect(result.input.indices.find(row => row.symbol === "399006.SZ")?.row).toBeNull();
    expect(result.dashboard?.evidence.indexEvidence.find(row => row.symbol === "399006.SZ")?.present).toBe(false);
    expect(result.dashboard?.metrics.avg_index_pct).toBeCloseTo(2 / 3, 12);
    expect(result.dashboard?.metrics.median_pct).toBeCloseTo(0.04, 12);
    expect(result.dashboard?.metrics.mainline_avg).toBeCloseTo(0.04, 12);
    expect(await replayTspMarketEmotion(request)).toEqual(result);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

test("reports adjacent price, volume, index and risk gaps without substituting an earlier target", async () => {
  const request = await fixture();
  const partial = await replayTspMarketEmotion({ ...request,
    marketRefs: request.marketRefs.slice(1), priceRefs: [await adjusted(leader, 110, sessions[3])], indexRefs: request.indexRefs.slice(-1),
  });
  expect(partial.input.prices).toMatchObject([{ previousBarDate: sessions[3], adjacent: false }]);
  expect(partial.input.volumes).toHaveLength(4);
  expect(partial.dashboard?.metrics).toMatchObject({ avg_pct: null, avg_vol_ratio: null, avg_index_pct: null });
  expect(partial.dashboard?.metrics).not.toHaveProperty("mainline_avg");
  expect(await replayTspMarketEmotion({ ...request, marketRefs: request.marketRefs.slice(0, -1) }))
    .toMatchObject({ status: "missing-market", tradingDate: target, dashboard: null });
  expect(await replayTspMarketEmotion({ ...request, riskWarningRefs: [] }))
    .toMatchObject({ status: "missing-risk-warnings", input: { riskWarnings: { status: "missing" } }, dashboard: null });
});

test("uses only adjacent TickFlow index closes and retains observed zero and original null fields", async () => {
  const request = await fixture();
  const indexRefs = await Promise.all([tickflowBenchmark("000001.SH", 1000, 1050), tickflowBenchmark("399001.SZ", 2000, 1940),
    tickflowBenchmark("399006.SZ", 1500, 1500), tickflowBenchmark("000680.SH", 1200, 1320, sessions[3])]);
  const result = await replayTspMarketEmotion({ ...request, indexRefs });
  expect(result.dashboard?.metrics.avg_index_pct).toBeCloseTo(2 / 3, 12);
  expect(result.dashboard?.evidence.indexEvidence).toEqual([
    { symbol: "000001.SH", present: true, returnPct: 5 },
    { symbol: "399001.SZ", present: true, returnPct: -3 },
    { symbol: "399006.SZ", present: true, returnPct: 0 },
    { symbol: "000680.SH", present: true, returnPct: null },
  ]);
  expect(result.input.indices[0]).toMatchObject({
    ref: indexRefs[0], row: { tradeDate: target, closePoints: 1050, previousClosePoints: null, returnPct: null },
    derivedReturn: { tradeDate: target, previousTradingDate: previousDate, previousClosePoints: 1000, returnPct: 5, producer: "whyj" },
  });
  expect(result.input.indices[3]).toMatchObject({
    ref: indexRefs[3], derivedReturn: { basis: "missing-adjacent-close", previousTradingDate: previousDate, returnPct: null },
  });
});

test("rejects unrelated or conflicting fixed references and respects cancellation", async () => {
  const request = await fixture();
  await expect(replayTspMarketEmotion({ ...request, indexRefs: [await benchmark("000300.SH", 1010)] }))
    .rejects.toThrow("unrelated market emotion core index archive");
  await expect(replayTspMarketEmotion({ ...request, priceRefs: [request.priceRefs[0]!, request.priceRefs[0]!] }))
    .rejects.toThrow("Incompatible market environment price archive");
  await expect(replayTspMarketEmotion({ ...request, sectors: { industry: request.sectors.concept } }))
    .rejects.toThrow("Incompatible market emotion sector kind");
  await expect(replayTspMarketEmotion(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("binds exact depth to eligible limit hits and retains raw streaks, excluded members and stale evidence", async () => {
  const request = await fixture();
  const marketRefs = [...request.marketRefs.slice(0, -1), await market(target, true)];
  const depth = { ref: await depthArchive(), asOf: Date.parse(target + "T15:00:10+08:00"), maxAgeMs: 10_000 };
  const corrected = await replayTspMarketEmotion({ ...request, marketRefs, depth });
  expect(corrected.dashboard?.metrics).toMatchObject({ limit_up: 0, seal_rate: 0, max_boards: 2, tier2_count: 1 });
  expect(corrected.dashboard?.evidence.exchange).toMatchObject({
    seal: { observedLimitUps: 1, observedBrokenLimits: 1, denominator: 2 },
    depthCorrection: {
      coverage: "complete", up: { priceLimitCount: 1, correctedCount: 0 }, down: { priceLimitCount: 1, observedSealed: 1, correctedCount: 1 },
    },
  });
  expect(corrected.input.depth).toMatchObject({ ref: depth.ref, source: "tickflow", endpoint: "/v1/depth",
    requestedSymbols: [leader, other, unrelated], returnedSymbols: [leader, other, unrelated], usedSymbols: [leader, other] });
  expect(corrected).toMatchObject({ depthQueue: { volumeUnitBasis: "archive", volumeUnit: "unknown", observedCandidates: 2, rows: [
    { symbol: leader, side: "up", nativeVolume: 200, queueAmountCny: null, triggered: null },
    { symbol: other, side: "down", nativeVolume: 500, queueAmountCny: null, triggered: null },
  ] } });
  const normalized = await replayTspMarketEmotion({ ...request, marketRefs, depth: {
    ...depth, queue: { volumeUnit: "share", rule: { metric: "sealed_amount", threshold: 2200 } },
  } });
  expect(normalized).toMatchObject({ input: { depth: { ref: depth.ref, volumeUnit: "unknown" } },
    depthQueue: { volumeUnitBasis: "caller-declared", volumeUnit: "share", rows: [
      { symbol: leader, closeCny: 11, queueHands: 2, queueAmountCny: 2200, triggered: true },
      { symbol: other, closeCny: 9, queueHands: 5, queueAmountCny: 4500, triggered: false },
    ] } });
  expect(normalized.dashboard).toEqual(corrected.dashboard);
  const stale = await replayTspMarketEmotion({ ...request, marketRefs, depth: { ...depth, maxAgeMs: 5_000 } });
  expect(stale.dashboard?.metrics).toMatchObject({ limit_up: 1, seal_rate: 50 });
  expect(stale.dashboard?.evidence.exchange.depthCorrection).toMatchObject({
    coverage: "partial", rows: [{ symbol: leader, availability: "stale", sealed: null }, { symbol: other, availability: "observed", sealed: true }],
  });
  expect(stale).toMatchObject({ depthQueue: { observedCandidates: 1, rows: [
    { symbol: leader, availability: "stale", nativeVolume: 200, queueAmountCny: null },
    { symbol: other, availability: "observed", nativeVolume: 500 },
  ] } });
  const risk = await archiveRiskWarningObservations({ source: "tushare", market: "A", tradeDate: target,
    observedAt, endpoint: "stock_st", coverage: "unknown",
    rows: [{ symbol: leader, name: "ST fixture", type: "ST", typeName: "风险警示板" }] });
  const filtered = await replayTspMarketEmotion({ ...request, marketRefs, depth, riskWarningRefs: [risk] });
  expect(filtered.input.depth?.usedSymbols).toEqual([other]);
  expect(filtered).toMatchObject({ depthQueue: { rows: [{ symbol: other, side: "down" }] } });
  expect(filtered.dashboard?.evidence.exchange.depthCorrection).toMatchObject({
    up: { priceLimitCount: 0, observedUnsealed: 0 }, down: { priceLimitCount: 1, observedSealed: 1 },
  });
});

test("rejects depth captured under a different session or after the requested cutoff", async () => {
  const request = await fixture();
  const asOf = Date.parse(target + "T15:00:09+08:00");
  await expect(replayTspMarketEmotion({ ...request, depth: { ref: await depthArchive(), asOf, maxAgeMs: 10_000 } }))
    .rejects.toThrow("Incompatible market emotion depth capture date or cutoff");
  await expect(replayTspMarketEmotion({ ...request, depth: { ref: await depthArchive(previousDate), asOf, maxAgeMs: 10_000 } }))
    .rejects.toThrow("Incompatible market emotion depth capture date or cutoff");
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveRiskWarningObservations, type StoredMarketCrossSection } from "../../storage/index.ts";
import { replayTspMarketLadders } from "../data/market-ladder-replay.ts";

const sessions = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09"] as const;
const symbols = Array.from({ length: 13 }, (_, index) => `${600001 + index}.SH`);
const observedAt = "2025-02-01T02:00:00Z";

function market(tradeDate: string, closesAtLimit: number, broken = 0, missingLast = false) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  const rows: StoredMarketCrossSection["bars"]["rows"] = symbols.slice(0, missingLast ? -1 : undefined).map((symbol, index) => {
    const close = index < closesAtLimit ? 11 : 10;
    return { symbol, open: 10, low: 10, high: index < closesAtLimit + broken ? 11 : 10, close,
      exRightsPreviousClose: 10, changeCny: close - 10, returnPct: close === 11 ? 10 : 0, volume: 100, amount: index + 1 };
  });
  return archiveMarketCrossSection({ source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, industry: null, listedOn: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

function limits(symbol: string, missingFinalUpper = false) {
  return archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
    coverage: "unknown", priceUnit: "CNY", requested: { startDate: sessions[0], endDate: sessions[5] },
    rows: sessions.map(tradeDate => ({ tradeDate, previousClose: 10,
      limitUp: missingFinalUpper && tradeDate === sessions[5] ? null : 11, limitDown: 9 })),
  });
}

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-market-ladder-replay-"));
  process.env.OHQUANT_DIR = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

test("replays complete market ladders from fixed raw closes and adjacent stock limits, even when input refs are reordered", async () => {
  const marketRefs = await Promise.all([market(sessions[0], 0), market(sessions[1], 12), market(sessions[2], 4, 3)]);
  const limitRefs = await Promise.all(symbols.map(symbol => limits(symbol)));
  const net = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected market I/O"));
  try {
    const request = { sessions: sessions.slice(0, 3), marketRefs, limitRefs };
    const result = await replayTspMarketLadders(request);
    expect(result.calendar).toEqual({ zone: "Asia/Shanghai", sessions: request.sessions });
    expect(result.rows[0]!.metrics?.seal).toMatchObject({ denominator: 0, fraction: null, regimeFraction: 0.5 });
    expect(result.rows[1]!.metrics?.ladder).toMatchObject({ height: 1, firstBoardCount: 12 });
    expect(result.rows[2]).toMatchObject({ tradingDate: sessions[2], previousTradingDate: sessions[1],
      market: { ref: marketRefs[2], source: "tushare", barsEndpoint: "daily", barsObservedAt: observedAt, amountUnit: "CNY-thousand" },
      metrics: { producer: "whyj", coverage: { roster: 13, streaksKnown: 13 }, ladder: { height: 2, twoOrMoreCount: 4 },
        promotion: { observedPromotions: 4, observedCandidates: 12, fraction: 0.3333 }, seal: { denominator: 7, fraction: 0.5714 },
      },
    });
    expect(result.rows[2]!.metrics?.tiers[0]?.stocks[0]).toEqual({ symbol: symbols[3]!, name: symbols[3]!, amountCny: 4_000 });
    expect(result.input.tradingLimits[0]).toMatchObject({ ref: limitRefs[0], symbol: symbols[0], endpoint: "stk_limit", observedAt });
    expect(await replayTspMarketLadders({ ...request, marketRefs: marketRefs.toReversed(), limitRefs: limitRefs.toReversed() })).toEqual(result);
    expect(net).not.toHaveBeenCalled();
  } finally { net.mockRestore(); }
});

test("missing sessions, raw prices and upper limits preserve gaps until an observed reset", async () => {
  const marketRefs = await Promise.all([market(sessions[0], 0), market(sessions[1], 2), market(sessions[2], 2),
    market(sessions[4], 2, 0, true), market(sessions[5], 1)]);
  const limitRefs = await Promise.all(symbols.map((symbol, index) => limits(symbol, index === 0)));
  const request = { sessions, marketRefs, limitRefs };
  const result = await replayTspMarketLadders(request);
  expect(result.rows[3]).toEqual({ tradingDate: sessions[3], previousTradingDate: sessions[2], market: null, metrics: null });
  expect(result.rows[4]!.metrics).toMatchObject({ ladder: null, observedLadder: { height: 0 }, coverage: { streaksKnown: 10 },
    promotion: { basis: "partial-pool", fraction: null }, seal: { fraction: null, observedLimitUps: 2, denominator: null } });
  expect(result.rows[5]!.metrics).toMatchObject({ ladder: null, observedLadder: { height: 0 }, coverage: { streaksKnown: 12 },
    seal: { fraction: null, observedLimitUps: 0 } });
  await expect(replayTspMarketLadders({ ...request, sessions: [...sessions, sessions[5]] })).rejects.toThrow("ordered unique exchange sessions");
  await expect(replayTspMarketLadders({ ...request, marketRefs: [...marketRefs, marketRefs[0]!] })).rejects.toThrow("Duplicate or off-calendar");
  await expect(replayTspMarketLadders({ ...request, sessions: sessions.slice(1) })).rejects.toThrow("Duplicate or off-calendar");
  await expect(replayTspMarketLadders({ ...request, limitRefs: [...limitRefs, await limits("600800.SH")] })).rejects.toThrow("Duplicate or off-roster");
  await expect(replayTspMarketLadders({ ...request, limitRefs: [...limitRefs, limitRefs[0]!] })).rejects.toThrow("Duplicate or off-roster");
  await expect(replayTspMarketLadders(request, AbortSignal.abort(new Error("Ladder cancelled")))).rejects.toThrow("Ladder cancelled");
});

test("applies each day's risk-warning roster to counts while preserving actual exchange streak histories", async () => {
  const lookback = sessions.slice(0, 3);
  const marketRefs = await Promise.all([market(sessions[0], 0), market(sessions[1], 12), market(sessions[2], 4, 3)]);
  const limitRefs = await Promise.all(symbols.map(symbol => limits(symbol)));
  const riskWarningRefs = await Promise.all(lookback.map((tradeDate, index) => archiveRiskWarningObservations({
    market: "A", source: "tushare", endpoint: "stock_st", tradeDate, observedAt, coverage: "unknown",
    rows: index === 1 ? [{ symbol: symbols[0]!, name: "ST 样本", type: "ST", typeName: "风险警示板" }] : [],
  })));
  const result = await replayTspMarketLadders({ sessions: lookback, marketRefs, limitRefs, riskWarningRefs });
  expect(result.rows[1]).toMatchObject({
    riskWarnings: { status: "matched", excludedSymbols: [symbols[0]] },
    metrics: { coverage: { roster: 12 }, ladder: { firstBoardCount: 11 }, seal: { observedLimitUps: 11 } },
  });
  expect(result.rows[2]).toMatchObject({
    riskWarnings: { status: "matched", excludedSymbols: [] },
    metrics: { coverage: { roster: 13 }, ladder: { height: 2, twoOrMoreCount: 4 },
      promotion: { basis: "partial-pool", observedCandidates: 11, observedPromotions: 3, fraction: null } },
  });
  const incomplete = await replayTspMarketLadders({ sessions: lookback, marketRefs, limitRefs,
    riskWarningRefs: [riskWarningRefs[0]!, riskWarningRefs[2]!] });
  expect(incomplete.rows[1]).toMatchObject({ market: { ref: marketRefs[1] }, riskWarnings: { status: "missing" }, metrics: null });
  expect(incomplete.rows[2]?.metrics?.ladder?.height).toBe(2);
  expect(incomplete.rows[2]?.metrics?.promotion).toMatchObject({ basis: "partial-pool", observedCandidates: 0, fraction: null });
});

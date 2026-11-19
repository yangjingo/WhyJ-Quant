import { expect, test } from "bun:test";
import { computeTspDailyLadderFlags, computeTspDailySignals, computeTspMarketLadder, TSP_INDICATOR_REVISION,
  tspTradingLimitThresholds, type TspLimitLadderObservation } from "../index.ts";

const tradingDate = "2025-01-06", previous = "2025-01-03";
const stock = (index: number, upStreak: number, priorUpStreak: number, amountCny = 0, brokenLimitUp = false): TspLimitLadderObservation => ({
  tradingDate, symbol: `${600001 + index}.SH`, name: `Fixture ${index}`, amountCny, upStreak, priorUpStreak, limitUp: upStreak > 0, brokenLimitUp,
});
const universeFor = (rows: readonly TspLimitLadderObservation[]) => ({ id: "fixture:dated-stocks", revision: "freeze-2025-01-06",
  tradingDate, symbols: rows.map(row => row.symbol) });

test("complete ladder derives widths, tier leaders, promotion and seal from explicit numerators", () => {
  const rows = [
    stock(0, 5, 4, 800), stock(1, 3, 2, 350), stock(2, 2, 1, 300), stock(3, 2, 1, 600), stock(4, 1, 0, 20),
    stock(5, 0, 1, 10, true), stock(6, 0, 1, 10, true), ...Array.from({ length: 6 }, (_, index) => stock(index + 7, 0, 1)),
  ];
  const universe = universeFor(rows);
  const result = computeTspMarketLadder(universe, previous, rows);
  expect(result.producer).toBe("whyj");
  expect(result.formula).toEqual({ id: "tsp_market_ladder", version: 1, revision: TSP_INDICATOR_REVISION });
  expect(result.ladder).toEqual({ height: 5, firstBoardCount: 1, twoOrMoreCount: 4, threeOrMoreCount: 2, fiveOrMoreCount: 1,
    occupiedRungs: 3, completeness: 0.75 });
  expect(result.tiers.map(({ boards, count, stocks }) => [boards, count, stocks.map(stock => stock.symbol)])).toEqual([
    [5, 1, [rows[0]!.symbol]], [3, 1, [rows[1]!.symbol]], [2, 2, [rows[3]!.symbol, rows[2]!.symbol]], [1, 1, [rows[4]!.symbol]],
  ]);
  expect(result.promotion).toEqual({ fraction: 0.3333, basis: "measured", observedCandidates: 12, evaluatedCandidates: 12, observedPromotions: 4 });
  expect(result.seal).toEqual({ fraction: 0.7143, regimeFraction: 5 / 7, basis: "measured", denominator: 7, observedLimitUps: 5, observedBrokenLimits: 2 });
  expect(computeTspMarketLadder(universe, previous, rows.toReversed())).toEqual(result);
});

test("partial older and current coverage do not become complete ratios or zero counts", () => {
  const rows = Array.from({ length: 12 }, (_, index) => stock(index, index === 0 ? 2 : 0, 1));
  const universe = universeFor(rows);
  const unavailable = { ...rows[1]!, upStreak: null, limitUp: true };
  const partial = computeTspMarketLadder(universe, previous, [rows[0]!, unavailable, ...rows.slice(2)]);
  expect(partial.ladder).toBeNull();
  expect(partial.observedLadder).toMatchObject({ height: 2, twoOrMoreCount: 1 });
  expect(partial.coverage).toMatchObject({ streaksKnown: 11, limitUpsKnown: 12, priorStreaksKnown: 12 });
  expect(partial.promotion).toEqual({ fraction: null, basis: "partial-outcomes", observedCandidates: 12, evaluatedCandidates: 11, observedPromotions: 1 });
  expect(partial.seal).toMatchObject({ fraction: 1, denominator: 2, observedLimitUps: 2 });
  const missing = computeTspMarketLadder(universe, previous, rows.slice(0, -1));
  expect(missing.promotion).toMatchObject({ fraction: null, basis: "partial-pool", observedCandidates: 11 });
  expect(missing.seal).toMatchObject({ fraction: null, regimeFraction: null, basis: "partial-events", denominator: null });
  const fewerRows = rows.slice(1, 9);
  const noSeals = computeTspMarketLadder(universeFor(fewerRows), previous, fewerRows);
  expect(noSeals.ladder).toMatchObject({ height: 0, completeness: 0 });
  expect(noSeals.promotion).toMatchObject({ fraction: null, basis: "small-pool", observedCandidates: 8 });
  expect(noSeals.seal).toEqual({ fraction: null, regimeFraction: 0.5, basis: "regime-zero-events-default", denominator: 0,
    observedLimitUps: 0, observedBrokenLimits: 0 });
});

test("ratio ties use the pinned four-decimal half-even behavior", () => {
  for (const [hits, expected] of [[1, 0.0312], [3, 0.0938]] as const) {
    const rows = Array.from({ length: 32 }, (_, index) => stock(index, index < hits ? 2 : 0, 1, 1, index >= hits));
    const result = computeTspMarketLadder(universeFor(rows), previous, rows);
    expect(result.promotion.fraction).toBe(expected);
    expect(result.seal.fraction).toBe(expected);
  }
});

test("inconsistent stages, dates, flags and roster membership fail visibly", () => {
  const row = stock(0, 2, 1), universe = universeFor([row]);
  expect(() => computeTspMarketLadder(universe, tradingDate, [row])).toThrow("Invalid market ladder scope");
  expect(() => computeTspMarketLadder(universe, previous, [row, row])).toThrow("Invalid or duplicate market ladder observation");
  expect(() => computeTspMarketLadder(universe, previous, [stock(1, 2, 1)])).toThrow("Invalid or duplicate market ladder observation");
  expect(() => computeTspMarketLadder(universe, previous, [{ ...row, upStreak: 4 }])).toThrow("Incompatible market ladder streak or limit flags");
  expect(() => computeTspMarketLadder(universe, previous, [{ ...row, brokenLimitUp: true }])).toThrow("Incompatible market ladder streak or limit flags");
});

test("market ladder half-tick flags reuse the pinned daily signal rules", () => {
  for (const [close, high, lower] of [[11, 11, 9], [10.5, 11, 9], [9, 10, 9], [10, 10, null]] as const) {
    const operands = { raw_close: close, raw_high: high, raw_low: close, ...tspTradingLimitThresholds(11, lower) };
    const [daily] = computeTspDailySignals([{ date: tradingDate, open: close, close, high, low: close, volume: 100, ...operands }]);
    expect(daily?.values).toMatchObject(computeTspDailyLadderFlags(operands));
  }
  expect(computeTspDailyLadderFlags({ raw_high: 0 })).toEqual({ signal_limit_up: null, signal_limit_down: null, signal_broken_limit_up: null });
  expect(() => computeTspDailyLadderFlags({ raw_high: 5, raw_close: 6 })).toThrow("Invalid TSP daily signal price observations");
});

import { expect, test } from "bun:test";
import { computeTspMarketBreadth, TSP_INDICATOR_REVISION, TSP_MARKET_BREADTH_FORMULA_VERSION } from "../index.ts";
import type { TspBreadthMemberObservation, TspBreadthUniverse } from "../index.ts";
import fixture from "./fixtures/tsp-market-breadth.json";

const universe: TspBreadthUniverse = {
  id: "fixed-sample", revision: "sample-001", tradingDate: fixture.tradingDate, symbols: fixture.rows.map(row => row.symbol),
};
const rows: TspBreadthMemberObservation[] = fixture.rows.map(row => ({
  tradingDate: fixture.tradingDate, symbol: row.symbol, name: row.name, close: row.close,
  changeFraction: row.change_pct, volumeShares: row.volume, amountCny: row.amount, turnoverPct: row.turnover_rate,
  volumeRatio5d: row.vol_ratio_5d, ma5: row.ma5, ma20: row.ma20, ma60: row.ma60, high60d: row.high_60d, low60d: row.low_60d,
  newHighSignal: row.signal_n_day_high, newLowSignal: row.signal_n_day_low,
}));

test("full cross-section matches pinned TSP breadth, distribution, trend and activity", () => {
  expect(fixture.revision).toBe(TSP_INDICATOR_REVISION);
  expect(TSP_MARKET_BREADTH_FORMULA_VERSION).toBe(1);
  const { coverage, breadth, distribution, trend, amount, activity, leaders } = computeTspMarketBreadth(universe, rows);
  const expected = fixture.expected;

  expect(coverage).toEqual({ members: 13, observed: 13, missing: 0, eligible: expected.breadth.total,
    excludedBySuspensionRule: 1, unknownEligibility: 0 });
  for (const [actual, count] of [
    [breadth.up, expected.breadth.up], [breadth.down, expected.breadth.down],
    [breadth.flat, expected.breadth.flat], [breadth.strongUp, expected.breadth.strong_up],
    [breadth.strongDown, expected.breadth.strong_down], [trend.aboveMa5, expected.trend.above_ma5],
    [trend.aboveMa20, expected.trend.above_ma20], [trend.aboveMa60, expected.trend.above_ma60],
    [trend.newHigh, expected.trend.new_high], [trend.newLow, expected.trend.new_low],
    [activity.highTurnover, expected.activity.high_turnover],
  ] as const) {
    expect(actual).toEqual({ count, denominator: coverage.eligible, fraction: count / coverage.eligible });
  }
  expect(breadth.average).toBeCloseTo(expected.breadth.avg_pct, 12);
  expect(breadth.median).toBe(expected.breadth.median_pct);
  expect(distribution).toHaveLength(expected.distribution.length);
  for (const [index, bin] of distribution.entries()) {
    const upstream = expected.distribution[index]!;
    expect(upstream.label).toBe(bin.label);
    expect(bin.count).toBe(upstream.count);
    expect(bin.fraction! * 100).toBeCloseTo(upstream.pct, 12);
  }
  expect(amount).toEqual({ total: expected.amount.total, average: expected.amount.avg, denominator: coverage.eligible });
  expect(activity.volumeRatio.average).toBeCloseTo(expected.activity.vol_ratio, 12);
  expect(activity.highVolume.fraction! * 100).toBeCloseTo(expected.activity.high_vol_ratio, 12);
  expect(activity.turnover.average).toBeCloseTo(expected.activity.avg_turnover, 12);
  expect(leaders.gainers.map(row => row.symbol)).toEqual(expected.top_gainers);
  expect(leaders.losers.map(row => row.symbol)).toEqual(expected.top_losers);
  expect(leaders.amount.map(row => row.symbol)).toEqual(expected.turnover_leaders);
  expect(leaders.turnover.map(row => row.symbol)).toEqual(expected.active_leaders);
  expect(computeTspMarketBreadth(universe, rows.toReversed()).leaders).toEqual(leaders);
});

test("incomplete observations disclose each denominator and preserve unknown versus observed zero", () => {
  const data = computeTspMarketBreadth(universe, [
    { ...rows[0]!, volumeShares: 10, changeFraction: null, amountCny: 0, ma5: null, turnoverPct: null },
    { ...rows[1]!, volumeShares: null, changeFraction: 0 },
    { ...rows[2]!, volumeShares: 10, changeFraction: 0, amountCny: null, newHighSignal: true, high60d: null },
    rows.at(-1)!,
  ]);
  expect(data.coverage).toMatchObject({ observed: 4, eligible: 2, missing: 9, excludedBySuspensionRule: 1, unknownEligibility: 1 });
  expect(data.breadth.flat).toEqual({ count: 1, denominator: 1, fraction: 1 });
  expect(data.trend.aboveMa5.denominator).toBe(1);
  expect(data.trend.newHigh).toEqual({ count: 2, denominator: 2, fraction: 1 });
  expect(data.amount).toEqual({ total: 0, average: 0, denominator: 1 });
  expect(data.activity.turnover.denominator).toBe(1);

  const empty = computeTspMarketBreadth(universe, []);
  expect(empty.coverage.missing).toBe(13);
  expect(empty.breadth.median).toBeNull();
  expect(empty.breadth.flat).toEqual({ count: 0, denominator: 0, fraction: null });
  expect(empty.amount).toEqual({ total: null, average: null, denominator: 0 });
  expect(empty.leaders.gainers).toEqual([]);
});

test("rejects conflicting dates, duplicates, out-of-universe observations and invalid units", () => {
  expect(() => computeTspMarketBreadth({ ...universe, symbols: [rows[0]!.symbol, rows[0]!.symbol] }, [])).toThrow("universe");
  for (const input of [
    [rows[0]!, rows[0]!], [{ ...rows[0]!, tradingDate: "2026-01-06" }],
    [{ ...rows[0]!, symbol: "600099.SH" }], [{ ...rows[0]!, amountCny: -1 }],
  ]) expect(() => computeTspMarketBreadth(universe, input)).toThrow("member observation");
});

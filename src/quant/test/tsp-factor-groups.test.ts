import { expect, test } from "bun:test";
import { computeTspFactorGroups, type TspFactorGroupsInput } from "../index.ts";

// Expected values were computed by the pinned TSP group, turnover and spread methods
// using Polars 1.44.1 and NumPy 2.4.4.
const sessions = [
  "2025-12-29", "2025-12-30", "2025-12-31",
  "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13",
];
const prices = [
  [10, 11, 12, null, 13, 13, 12, 14, 14],
  [10, 9.5, 9, 11, 12, 12, 14, 15, 13],
  [10, null, 9, 8, 10, 11, 10, 12, 14],
  [10, 12, 10, null, 8, 9, 8, 7, 8],
  [8, 8, 9, 10, 11, 10, 10, 11, 12],
];
const factors = [
  [1, 2, 1, 1, 2, 3, 1, 1, null],
  [2, 1, 3, 4, null, 1, 1, 3, null],
  [3, 3, 2, 3, 2, 3, 1, 2, null],
  [4, 4, 4, 2, 2, 2, 1, 1, null],
  [5, null, 2, 2, 1, 3, 1, 3, null],
];
const rows = prices.flatMap((series, s) => sessions.map((tradeDate, i) => ({
  symbol: "S" + s, tradeDate, close: series[i]!, factor: factors[s]![i]!,
})));
const input: TspFactorGroupsInput = { factorId: "factor-fixture", rebalance: "daily", sessions, rows, groupCount: 3 };
const weighted = { weight: "factor_weight", feesFraction: 0.009, commissionFraction: 0.001, stampTaxFraction: 0.002, slippageBps: 10 } as const;
const navValues = (result: ReturnType<typeof computeTspFactorGroups>) => result.groupNav.map(point => point.groups.map(group => group.value));
const statValues = (result: ReturnType<typeof computeTspFactorGroups>) => result.groupStats.map(group =>
  [group.totalReturn, group.maxDrawdown, group.sharpe, group.winRate]);
const spreadValues = (result: ReturnType<typeof computeTspFactorGroups>) => result.longShort!.nav.map(point => point.value);

test("matches daily equal-weight group curves and theoretical spread with a temporarily missing group", () => {
  const result = computeTspFactorGroups(input);
  expect(result).toMatchObject({
    producer: "whyj", formulaVersion: "tsp-factor-v2-groups-v1", referenceRevision: "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc",
    roundTripCost: 0.0014, turnover: 0.8333,
    longShort: { topGroup: "Q3", bottomGroup: "Q1", portfolioType: "theoretical_factor_spread", executableShort: false,
      totalReturn: -0.097, maxDrawdown: -0.097, sharpe: -6.1716 },
  });
  expect(navValues(result)).toEqual([
    [1.0236, 1.1986, 0.9986], [0.9683, 1.3059, 0.8308], [0.9669, 1.5943, 0.8308], [1.0623, 1.9906, 0.9051],
    [0.9642, 2.1371, 0.9051], [0.9897, 2.0145, 0.9051], [0.9897, 2.1782, 0.9051], [1.059, 2.5381, 0.8847],
  ]);
  expect(result.groupNav[2]?.groups[2]).toEqual({ label: "Q3", netReturn: null, value: 0.8308 });
  expect(result.groupNav[2]?.outcomeDate).toBe("2026-01-06");
  expect(statValues(result)).toEqual([[0.059, -0.0923, 1.61, 0.4286], [1.5381, -0.0573, 17.94, 0.8571], [-0.1153, -0.1692, -2.99, 0.1429]]);
  expect(result.groupStats[0]?.annualReturn).toBe(3.0346);
  expect(result.groupStats[1]!.annualReturn / 7_078_727_136.9139).toBeCloseTo(1, 12);
  expect(result.groupStats[2]?.annualReturn).toBe(-0.9494);
  expect(spreadValues(result)).toEqual([0.9861, 0.9285, 0.9278, 0.9223, 0.9636, 0.9495, 0.9482, 0.903]);
  expect(computeTspFactorGroups({ ...input, rows: rows.toReversed() })).toEqual(result);
});

test("matches factor-strength weights and charges override commission, stamp tax and slippage", () => {
  const result = computeTspFactorGroups({ ...input, ...weighted });
  expect(result.roundTripCost).toBe(0.006);
  expect(result.turnover).toBe(0.8333);
  expect(navValues(result)).toEqual([
    [1.0377, 1.194, 0.994], [0.9769, 1.2954, 0.8224], [0.971, 1.5755, 0.8224], [1.0623, 1.9599, 0.8922],
    [0.9594, 2.0951, 0.8922], [1.0136, 1.9653, 0.8922], [1.0136, 2.1159, 0.8922], [1.0799, 2.4559, 0.8679],
  ]);
  expect(statValues(result)).toEqual([[0.0799, -0.0969, 1.78, 0.4286], [1.4559, -0.0619, 17.24, 0.8571], [-0.1321, -0.1776, -3.37, 0.1429]]);
  expect(result.longShort).toMatchObject({ totalReturn: -0.1479, maxDrawdown: -0.1479, sharpe: -9.2883 });
  expect(spreadValues(result)).toEqual([0.9721, 0.9109, 0.9081, 0.8986, 0.9367, 0.9046, 0.8992, 0.8521]);
});

test("matches weekly and monthly rebalances, statistics and turnover", () => {
  const weekly = computeTspFactorGroups({ ...input, ...weighted, rebalance: "weekly" });
  expect(weekly.groupNav.map(point => [point.tradeDate, point.outcomeDate])).toEqual([
    ["2025-12-29", "2026-01-06"], ["2026-01-06", "2026-01-12"],
  ]);
  expect(navValues(weekly)).toEqual([[1.094, 0.794, 1.244], [1.1968, 1.1862, 1.6889]]);
  expect(statValues(weekly)).toEqual([[0.1968, 0, 0, 1], [0.1862, -0.206, 0, 1], [0.6889, 0, 0, 1]]);
  expect(weekly.turnover).toBe(1);
  expect(weekly.longShort).toMatchObject({ totalReturn: 0.2035, maxDrawdown: 0, sharpe: 17.4835 });
  expect(spreadValues(weekly)).toEqual([1.069, 1.2035]);

  const monthly = computeTspFactorGroups({ ...input, rebalance: "monthly" });
  expect(navValues(monthly)).toEqual([[1.0986, 0.7986, 1.2486]]);
  expect(statValues(monthly)).toEqual([[0.0986, 0, 0, 0], [-0.2014, -0.2014, 0, 0], [0.2486, 0, 0, 0]]);
  expect(monthly.turnover).toBe(0);
  expect(monthly.longShort).toMatchObject({ totalReturn: 0.0736, maxDrawdown: 0, sharpe: 0 });
});

test("keeps tied values together and leaves a spread unavailable for a single observed group", () => {
  const sparse = {
    ...input, sessions: sessions.slice(0, 2),
    rows: [
      { symbol: "A", tradeDate: sessions[0]!, close: 10, factor: 1 },
      { symbol: "B", tradeDate: sessions[0]!, close: 10, factor: 1 },
      { symbol: "A", tradeDate: sessions[1]!, close: 12, factor: null },
      { symbol: "B", tradeDate: sessions[1]!, close: null, factor: null },
    ],
    groupCount: 5, feesFraction: 0, slippageBps: 0,
  };
  const result = computeTspFactorGroups(sparse);
  expect(result.groupNav[0]?.groups).toHaveLength(1);
  expect(result.groupNav[0]?.groups[0]).toMatchObject({ label: "Q2", value: 1.2 });
  expect(result.turnover).toBe(0);
  expect(result.longShort).toBeNull();
  expect(computeTspFactorGroups({ ...sparse, rows: [] })).toMatchObject({ groupNav: [], groupStats: [], turnover: null, longShort: null });
});

test("rejects invalid group parameters and non-finite or negative cost inputs", () => {
  for (const groupCount of [0, 2.5, Infinity]) {
    expect(() => computeTspFactorGroups({ ...input, groupCount })).toThrow("Invalid factor grouping parameters");
  }
  for (const cost of [{ commissionFraction: -1 }, { feesFraction: Infinity }, { stampTaxFraction: -0.01 }, { slippageBps: NaN }]) {
    expect(() => computeTspFactorGroups({ ...input, ...cost })).toThrow("Factor group costs must be finite and nonnegative");
  }
});

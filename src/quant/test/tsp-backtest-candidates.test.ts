import { expect, test } from "bun:test";
import {
  computeTspBacktestCandidates, TSP_BACKTEST_CANDIDATE_FORMULA_VERSION, TSP_INDICATOR_REVISION,
  type TspBacktestCandidateInput,
} from "../index.ts";

const input: TspBacktestCandidateInput = {
  candidateCount: 10,
  execution: { buy_no_next_bar: 2 },
  trades: [
    { symbol: "600000.SH", exitDate: "2025-01-07", pnlFraction: 0.26, holdingDays: 6 },
    { symbol: "000001.SZ", exitDate: "2025-01-03", pnlFraction: -0.24, holdingDays: 4 },
    { symbol: "600000.SH", exitDate: "2025-01-06", pnlFraction: -0.02, holdingDays: 3 },
    { symbol: "000001.SZ", exitDate: "2025-01-03", pnlFraction: 0.06, holdingDays: 1 },
    { symbol: "600000.SH", exitDate: "2025-01-07", pnlFraction: 0, holdingDays: 2 },
    { symbol: "300001.SZ", exitDate: "2025-01-06", pnlFraction: 0.02, holdingDays: 6 },
    { symbol: "300001.SZ", exitDate: "2025-01-07", pnlFraction: 0.01999999999999999, holdingDays: 1 },
    { symbol: "300001.SZ", exitDate: "2025-01-07", pnlFraction: 0.019, holdingDays: 0 },
  ],
};

test("reproduces pinned TSP independent exit-day metrics, curves and all histogram bins", () => {
  // Verified against _calc_independent_candidate_result at the reference revision with NumPy 2.4.4.
  const result = computeTspBacktestCandidates(input);
  if (result.status !== "available") throw new Error(result.reason);
  expect(result).toMatchObject({
    producer: "whyj", formulaVersion: TSP_BACKTEST_CANDIDATE_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION, basis: "independent-exits",
    candidateCount: 10, tradeCount: 8, execution: { buy_no_next_bar: 2 }, exitDayCount: 3,
    averageDailyCandidates: 2.7, averageReturn: 0.0149, medianReturn: 0.0195,
    winRate: 0.625, profitFactor: 0.87, best: 0.26, worst: -0.24, averageHoldingDays: 2.9,
    totalReturn: -0.022, maxDrawdown: 0, sharpe: -0.98, sortino: -1.55,
    monteCarlo: { drawdownP50: -0.24, drawdownP95: -0.4353 },
  });
  expect(result.curve.map(({ exitDate, tradeCount, value, drawdown }) => [exitDate, tradeCount, value, drawdown])).toEqual([
    ["2025-01-03", 2, 0.91, -0.09], ["2025-01-06", 2, 0.91, -0.09], ["2025-01-07", 4, 0.978, -0.022],
  ]);
  expect(result.perSymbol).toEqual([
    { symbol: "600000.SH", tradeCount: 3, totalReturn: 0.2348, winRate: 0.3333, best: 0.26, worst: -0.02 },
    { symbol: "300001.SZ", tradeCount: 3, totalReturn: 0.0602, winRate: 1, best: 0.02, worst: 0.019 },
    { symbol: "000001.SZ", tradeCount: 2, totalReturn: -0.1944, winRate: 0.5, best: 0.06, worst: -0.24 },
  ]);
  expect(result.returnDistribution.map(bin => bin.count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 0, 1, 0, 0, 0, 0, 0, 1]);
  expect(result.returnDistribution.map(bin => bin.ratio)).toEqual(result.returnDistribution.map(bin => bin.count / 8));
  expect(result.returnDistribution[10]!.upperFraction).toBe(0.01999999999999999);
  expect(result.returnDistribution.at(-1)!.upperFraction).toBe(0.2);
});

test("preserves every NumPy edge and assigns exact boundaries and clipped tails to their bins", () => {
  const edges = [
    -0.2, -0.18000000000000002, -0.16, -0.14, -0.12000000000000001, -0.1, -0.08000000000000002, -0.06,
    -0.04000000000000001, -0.020000000000000018, 0, 0.01999999999999999, 0.03999999999999998, 0.06,
    0.08000000000000002, 0.09999999999999998, 0.12, 0.14, 0.15999999999999998, 0.18, 0.2,
  ];
  const trades = [-0.26, ...edges, 0.26].map(pnlFraction => ({ ...input.trades[0]!, pnlFraction }));
  const result = computeTspBacktestCandidates({ ...input, candidateCount: trades.length, trades, includeMonteCarlo: false });
  if (result.status !== "available") throw new Error(result.reason);
  expect(result.returnDistribution.map(bin => bin.lowerFraction)).toEqual(edges.slice(0, -1));
  expect(result.returnDistribution.map(bin => bin.upperFraction)).toEqual(edges.slice(1));
  expect(result.returnDistribution.map(bin => bin.count)).toEqual([2, ...Array<number>(18).fill(1), 3]);
});

test("distinguishes empty evidence, observed zero and a zero peak", () => {
  expect(computeTspBacktestCandidates({ ...input, trades: [] })).toMatchObject({
    status: "unavailable", reason: "no-executable-trades", candidateCount: 10, tradeCount: 0, execution: { buy_no_next_bar: 2 },
  });
  const trade = input.trades[0]!;
  const flat = computeTspBacktestCandidates({ ...input, trades: [{ ...trade, pnlFraction: 0 }], includeMonteCarlo: false });
  expect(flat).toMatchObject({ status: "available", averageReturn: 0, totalReturn: 0, profitFactor: null, sharpe: 0, sortino: 0 });
  expect(flat).not.toHaveProperty("monteCarlo");
  expect(computeTspBacktestCandidates({ ...input, trades: [{ ...trade, pnlFraction: -1 }] })).toMatchObject({
    status: "available", totalReturn: -1, maxDrawdown: null, curve: [{ value: 0, drawdown: -1 }],
  });
  expect(computeTspBacktestCandidates({ ...input, trades: [
    { ...trade, exitDate: "2025-01-06", pnlFraction: 0.1 }, { ...trade, pnlFraction: -0.2 },
  ] })).toMatchObject({ status: "available", totalReturn: -0.12, maxDrawdown: -0.2 });
});

test("rejects malformed or non-finite fixed candidate evidence", () => {
  expect(() => computeTspBacktestCandidates({ ...input, candidateCount: 7 })).toThrow();
  expect(() => computeTspBacktestCandidates({ ...input, execution: { pending_exit: -1 } })).toThrow();
  const trade = input.trades[0]!;
  for (const patch of [{ pnlFraction: Number.POSITIVE_INFINITY }, { pnlFraction: -1.1 },
    { exitDate: "2025-02-30" }, { holdingDays: 0.5 }, { symbol: "600000" }]) {
    expect(() => computeTspBacktestCandidates({ ...input, trades: [{ ...trade, ...patch }] })).toThrow();
  }
});

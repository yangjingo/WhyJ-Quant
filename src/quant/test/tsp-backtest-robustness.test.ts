import { expect, test } from "bun:test";
import { computeTspBacktestRobustness } from "../index.ts";

const pnls = [0.05, -0.03, 0.08, -0.06, 0.02, -0.04, 0.10, -0.05];
const durations = [1, 3, 5, 3, 4, 5, 6, 4];
const trades = pnls.map((pnlFraction, index) => ({ pnlFraction, holdingDays: durations[index]! }));

// The snapshot values were computed using the pinned TSP engine and NumPy 2.4.4.
test("matches the fixed-seed bootstrap, trade Sortino, and observed trade statistics", () => {
  const result = computeTspBacktestRobustness({ trades });
  expect(result).toEqual({
    producer: "whyj", formulaVersion: "tsp-trade-robustness-v1", referenceRevision: "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc",
    sortino: 4.24, sortinoBasis: "realized-trades", periodsPerYear: 252, returnSamples: 8,
    perTrade: { tradeSamples: 8, durationSamples: 8, best: 0.1, worst: -0.06, medianPnl: -0.005, avgHoldingDays: 3.9 },
    monteCarlo: { sampler: "numpy-pcg64", seed: 42, sampleCount: 8, simulations: 1000, drawdownP50: -0.0976, drawdownP95: -0.2108 },
  });
  expect(computeTspBacktestRobustness({ trades })).toEqual(result);
});

test("uses supplied periodic returns for Sortino and different-length trade returns for the bootstrap", () => {
  const outcomes = [0.25, -0.11, 0.20, -0.31, -0.05, 0.09, 0.03];
  const holdingDays = [2, 4, 6, 3, 5, 5, 2];
  const result = computeTspBacktestRobustness({
    trades: outcomes.map((pnlFraction, index) => ({ pnlFraction, holdingDays: holdingDays[index]! })),
    periodicReturns: [0.01, -0.02, 0.03, -0.01, 0],
  });
  expect(result).toMatchObject({ sortino: 3.17, sortinoBasis: "periodic-returns", returnSamples: 5,
    perTrade: { tradeSamples: 7, avgHoldingDays: 3.9, best: 0.25, worst: -0.31, medianPnl: 0.03 },
    monteCarlo: { sampleCount: 7, drawdownP50: -0.31, drawdownP95: -0.6176 } });
});

test("clips simulation losses while preserving measured loss and the first simulated equity peak", () => {
  const severe = computeTspBacktestRobustness({
    trades: [0.05, -1.5, 0.08, -0.06, 0.02, -0.04].map(pnlFraction => ({ pnlFraction, holdingDays: 4 })),
  });
  expect(severe).toMatchObject({ sortino: -6.26, perTrade: { worst: -1.5 },
    monteCarlo: { drawdownP50: -0.9999, drawdownP95: -1 } });
  const losses = computeTspBacktestRobustness({ trades: Array(3).fill({ pnlFraction: -0.1, holdingDays: 1 }) });
  expect(losses).toMatchObject({ sortino: -15.87, monteCarlo: { drawdownP50: -0.19, drawdownP95: -0.19 } });
});

test("keeps insufficient, non-finite, all-win and disabled samples explicit", () => {
  expect(computeTspBacktestRobustness({ trades: [] })).toMatchObject({ sortino: 0, perTrade: { tradeSamples: 0 },
    monteCarlo: { simulations: 0, drawdownP50: null, drawdownP95: null } });
  const dirty = computeTspBacktestRobustness({ trades: [...trades,
    { pnlFraction: NaN, holdingDays: null }, { pnlFraction: Infinity, holdingDays: Infinity }],
  });
  expect(dirty).toEqual(computeTspBacktestRobustness({ trades }));
  const wins = computeTspBacktestRobustness({ trades: Array(3000).fill({ pnlFraction: 0.02, holdingDays: 2 }) });
  expect(wins).toMatchObject({ sortino: null, monteCarlo: { simulations: 666, drawdownP50: 0, drawdownP95: 0 } });
  const disabled = computeTspBacktestRobustness({ trades, includeMonteCarlo: false });
  expect(disabled.sortino).toBe(4.24);
  expect(disabled).not.toHaveProperty("monteCarlo");
});

test("uses decimal half-even holding duration and rejects invalid scope or durations", () => {
  const rounded = computeTspBacktestRobustness({
    trades: [2, 2, 2, 3].map(holdingDays => ({ pnlFraction: 0.01, holdingDays })), includeMonteCarlo: false,
  });
  expect(rounded.perTrade.avgHoldingDays).toBe(2.2);
  expect(() => computeTspBacktestRobustness({ trades, periodsPerYear: 0 })).toThrow("Invalid backtest robustness scope");
  expect(() => computeTspBacktestRobustness({ trades: [{ pnlFraction: 0.02, holdingDays: -1 }] }))
    .toThrow("Invalid realized trade observation");
});

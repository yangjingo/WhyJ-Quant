import { expect, test } from "bun:test";
import {
  computeTspBacktestPortfolio,
  TSP_BACKTEST_PORTFOLIO_FORMULA_VERSION,
  type TspBacktestPortfolioInput,
} from "../index.ts";

const input: TspBacktestPortfolioInput = {
  initialCapital: 100,
  equityCurve: [
    { date: "2026-05-27", equity: 100, exposureFraction: 0 },
    { date: "2026-05-28", equity: 110, exposureFraction: 0.5 },
    { date: "2026-05-29", equity: 99, exposureFraction: 0.65 },
    { date: "2026-06-01", equity: 112, exposureFraction: 0.4 },
  ],
  trades: [
    { pnlFraction: 0.16, holdingDays: 3 },
    { pnlFraction: -0.08, holdingDays: 2 },
    { pnlFraction: 0, holdingDays: 1 },
  ],
};

test("replays the pinned TSP portfolio calculator on separate NAV and trade samples", () => {
  // BacktestEngine._calc_portfolio_stats_from_values at f9cb383c, NumPy 2.4.4.
  const result = computeTspBacktestPortfolio(input);
  expect(result).toMatchObject({
    status: "available",
    producer: "whyj",
    formulaVersion: TSP_BACKTEST_PORTFOLIO_FORMULA_VERSION,
    referenceRevision: "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc",
    periodsPerYear: 252,
    firstDate: "2026-05-27",
    lastDate: "2026-06-01",
    equitySamples: 4,
    tradeSamples: 3,
    portfolio: {
      initialCapital: 100, finalEquity: 112, totalReturn: 0.12, annualReturn: 1260.0591,
      maxDrawdown: -0.1, sharpe: 5.54, sortino: 12.04, calmar: 12600.59, avgExposure: 0.3875, maxExposure: 0.65,
    },
    realizedTrades: {
      tradeSamples: 3, durationSamples: 3, winRate: 0.3333, avgPnl: 0.0267, avgWin: 0.16, avgLoss: 0.04,
      profitFactor: 4, best: 0.16, worst: -0.08, medianPnl: 0, avgHoldingDays: 2,
    },
    monteCarlo: { drawdownP50: -0.08, drawdownP95: -0.1536 },
  });
  expect(computeTspBacktestPortfolio({ ...input, includeMonteCarlo: false })).not.toHaveProperty("monteCarlo");
});

test("retains initial capital, empty evidence and no-loss states separately", () => {
  expect(computeTspBacktestPortfolio({ ...input, equityCurve: [] })).toMatchObject({
    status: "unavailable", reason: "empty-equity-curve", equitySamples: 0, tradeSamples: 3,
  });
  expect(computeTspBacktestPortfolio({
    initialCapital: 100,
    equityCurve: [
      { date: "2026-05-27", equity: 101, exposureFraction: 0 },
      { date: "2026-05-28", equity: 102, exposureFraction: 0.2 },
      { date: "2026-05-29", equity: 103, exposureFraction: 0.5 },
    ],
    trades: [],
  })).toMatchObject({
    status: "available",
    portfolio: {
      totalReturn: 0.03, annualReturn: 10.9764, maxDrawdown: 0, sharpe: 2278.67, calmar: 0, sortino: null,
      avgExposure: 0.2333, maxExposure: 0.5,
    },
    realizedTrades: { profitFactor: null, winRate: 0, avgPnl: 0 },
  });
});

test("preserves a terminal zero NAV after a positive sample", () => {
  const first = input.equityCurve[0]!;
  const last = { date: "2026-05-28", equity: 0, exposureFraction: 0 };
  expect(computeTspBacktestPortfolio({ ...input, equityCurve: [first, last] })).toMatchObject({
    status: "available",
    portfolio: { finalEquity: 0, totalReturn: -1, annualReturn: -1, maxDrawdown: -1, calmar: -1, avgExposure: 0 },
  });
  expect(() => computeTspBacktestPortfolio({
    ...input, equityCurve: [first, last, input.equityCurve[2]!],
  })).toThrow("equity observation");
});

test("rejects malformed inputs rather than shrinking the reference sample", () => {
  const sample = input.equityCurve[0]!;
  for (const bad of [
    { ...sample, date: "2026-02-30" },
    { ...sample, equity: 0 },
    { ...sample, exposureFraction: Infinity },
  ]) {
    expect(() => computeTspBacktestPortfolio({ ...input, equityCurve: [bad] })).toThrow("equity observation");
  }
  expect(() => computeTspBacktestPortfolio({ ...input, equityCurve: [sample, sample] })).toThrow("equity observation");
  expect(() => computeTspBacktestPortfolio({ ...input, equityCurve: input.equityCurve.toReversed() })).toThrow("equity observation");
  expect(() => computeTspBacktestPortfolio({
    ...input, trades: [{ pnlFraction: NaN, holdingDays: null }],
  })).toThrow("realized trade");
});

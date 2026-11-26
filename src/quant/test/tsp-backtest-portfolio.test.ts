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

test("uses initial capital as the chart peak and reports optional position evidence", () => {
  const report = computeTspBacktestPortfolio({ ...input, equityCurve: [
    { date: "2026-05-27", equity: 90, exposureFraction: 0, cash: 0, positionCount: 0 },
    { date: "2026-05-28", equity: 85, exposureFraction: 0.43219 },
    { date: "2026-05-29", equity: 110, exposureFraction: 0.6, cash: 44.126, positionCount: 3 },
    { date: "2026-06-01", equity: 105, exposureFraction: 0.5, cash: null },
  ], includeMonteCarlo: false });
  expect(report).toMatchObject({
    status: "available",
    portfolio: { maxDrawdown: -0.0556 },
    curve: { formulaVersion: "tsp-backtest-portfolio-curve-v1", rows: [
      { date: "2026-05-27", equity: 90, exposureFraction: 0, cash: 0, positionCount: 0, drawdownFraction: -0.1 },
      { date: "2026-05-28", equity: 85, exposureFraction: 0.4322, cash: null, positionCount: null, drawdownFraction: -0.15 },
      { date: "2026-05-29", equity: 110, exposureFraction: 0.6, cash: 44.13, positionCount: 3, drawdownFraction: 0 },
      { date: "2026-06-01", equity: 105, exposureFraction: 0.5, cash: null, positionCount: null, drawdownFraction: -0.0455 },
    ] },
  });
});

test("replays TSP per-symbol trades independently of NAV coverage", () => {
  const trades = [
    { pnlFraction: 0.16, holdingDays: 3, symbol: "600000.SH" },
    { pnlFraction: -0.08, holdingDays: 2, symbol: "600000.SH" },
    { pnlFraction: 0, holdingDays: 1, symbol: "000001.SZ" },
    { pnlFraction: 0, holdingDays: 1, symbol: "600001.SH" },
  ];
  const expected = { formulaVersion: "tsp-backtest-per-symbol-v1" as const, groupedTrades: 4, totalTrades: 4, rows: [
    { symbol: "600000.SH", tradeCount: 2, totalReturn: 0.0672, winRate: 0.5, best: 0.16, worst: -0.08 },
    { symbol: "000001.SZ", tradeCount: 1, totalReturn: 0, winRate: 0, best: 0, worst: 0 },
    { symbol: "600001.SH", tradeCount: 1, totalReturn: 0, winRate: 0, best: 0, worst: 0 },
  ] };
  for (const equityCurve of [input.equityCurve, []]) {
    const result = computeTspBacktestPortfolio({ ...input, trades, equityCurve, includeMonteCarlo: false });
    expect(result.perSymbol).toEqual(expected);
    expect(result.status).toBe(equityCurve.length ? "available" : "unavailable");
  }

  const partialTrades = [{ ...input.trades[0]!, symbol: "600000.SH" }, ...input.trades.slice(1)];
  const { perSymbol, ...report } = computeTspBacktestPortfolio({ ...input, trades: partialTrades, includeMonteCarlo: false });
  expect(report).toEqual(computeTspBacktestPortfolio({ ...input, includeMonteCarlo: false }));
  expect(perSymbol).toMatchObject({ groupedTrades: 1, totalTrades: 3,
    rows: [{ symbol: "600000.SH", tradeCount: 1, winRate: 1 }] });
  expect(report).not.toHaveProperty("perSymbol");
  expect(() => computeTspBacktestPortfolio({ ...input, trades: [{ ...input.trades[0]!, symbol: "600000" }] }))
    .toThrow("Invalid realized trade symbol");
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
    curve: { rows: [{ date: first.date, drawdownFraction: 0 }, { date: last.date, drawdownFraction: -1 }] },
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
    { ...sample, cash: Infinity },
    { ...sample, positionCount: 0.5 },
    { ...sample, positionCount: -1 },
  ]) {
    expect(() => computeTspBacktestPortfolio({ ...input, equityCurve: [bad] })).toThrow("equity observation");
  }
  expect(() => computeTspBacktestPortfolio({ ...input, equityCurve: [sample, sample] })).toThrow("equity observation");
  expect(() => computeTspBacktestPortfolio({ ...input, equityCurve: input.equityCurve.toReversed() })).toThrow("equity observation");
  expect(() => computeTspBacktestPortfolio({
    ...input, trades: [{ pnlFraction: NaN, holdingDays: null }],
  })).toThrow("realized trade");
});

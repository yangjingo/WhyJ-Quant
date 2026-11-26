import { expect, test } from "bun:test";
import { computeTspBacktestBenchmark, TSP_BACKTEST_BENCHMARK_FORMULA_VERSION, TSP_INDICATOR_REVISION,
  type TspBacktestBenchmarkInput } from "../index.ts";

const input: TspBacktestBenchmarkInput = {
  range: { start: "2025-01-01", end: "2025-01-09" },
  strategy: { basis: "independent-exits", totalReturn: 0.09 },
  index: { symbol: "000001.SH", closes: [
    { tradeDate: "2025-01-02", closePoints: null },
    { tradeDate: "2025-01-03", closePoints: 3200.33334 },
    { tradeDate: "2025-01-06", closePoints: 0 },
    { tradeDate: "2025-01-07", closePoints: 0.00002 },
    { tradeDate: "2025-01-08", closePoints: 3344.38886 },
  ] },
};

test("reproduces the pinned Shanghai comparison with dated rounded endpoints", () => {
  const result = computeTspBacktestBenchmark(input);
  expect(result).toMatchObject({
    status: "available", producer: "whyj", formulaVersion: TSP_BACKTEST_BENCHMARK_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION, range: input.range, strategy: input.strategy,
    observation: { symbol: "000001.SH", rowCount: 5, eligibleCount: 2,
      first: { tradeDate: "2025-01-03", closePoints: 3200.33334, reportClosePoints: 3200.3333 },
      last: { tradeDate: "2025-01-08", closePoints: 3344.38886, reportClosePoints: 3344.3889 } },
  });
  expect(result.benchmarkReturn).toBeCloseTo(0.04501268664735636, 14);
  expect(result.excessReturn).toBeCloseTo(0.04498731335264364, 14);
});

test("keeps true zero, absent strategy return, and sparse index coverage distinct", () => {
  const zero = { ...input, strategy: { basis: "portfolio-nav", totalReturn: 0 } as const,
    index: { ...input.index, closes: [
      { tradeDate: "2025-01-02", closePoints: 3100 }, { tradeDate: "2025-01-08", closePoints: 3100 },
    ] } };
  expect(computeTspBacktestBenchmark(zero)).toMatchObject({ status: "available", benchmarkReturn: 0, excessReturn: 0 });
  expect(computeTspBacktestBenchmark({ ...zero, strategy: { ...zero.strategy, totalReturn: null } }))
    .toMatchObject({ status: "available", benchmarkReturn: 0, excessReturn: null });
  expect(computeTspBacktestBenchmark({ ...zero, index: { ...zero.index, closes: zero.index.closes.slice(0, 1) } }))
    .toMatchObject({ status: "unavailable", reason: "insufficient-index-closes", benchmarkReturn: null, excessReturn: null,
      observation: { eligibleCount: 1 } });
});

test("rejects dates, scopes or values that cannot represent fixed benchmark evidence", () => {
  for (const closes of [input.index.closes.toReversed(), [...input.index.closes, input.index.closes.at(-1)!],
    [{ tradeDate: "2025-01-02", closePoints: Number.NaN }], [{ tradeDate: "2025-01-10", closePoints: 3100 }]]) {
    expect(() => computeTspBacktestBenchmark({ ...input, index: { ...input.index, closes } })).toThrow();
  }
  expect(() => computeTspBacktestBenchmark({ ...input, strategy: { ...input.strategy, totalReturn: Infinity } })).toThrow();
  expect(() => computeTspBacktestBenchmark({ ...input, range: { start: "2025-02-30", end: "2025-03-01" } })).toThrow();
  expect(() => computeTspBacktestBenchmark({ ...input, index: { ...input.index, symbol: "000300.SH" as "000001.SH" } })).toThrow();
});

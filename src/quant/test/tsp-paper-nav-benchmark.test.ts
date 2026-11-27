import { expect, test } from "bun:test";
import { computeTspPaperNavBenchmark, TSP_INDICATOR_REVISION, type TspPaperNavBenchmarkInput } from "../index.ts";

const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12"];
const base: TspPaperNavBenchmarkInput = {
  accountId: "paper", currency: "CNY",
  finalizedNav: [0, 90, 100, -10, 0, 112.5].map((nav, index) => ({ tradeDate: dates[index]!, currency: "CNY", nav })),
  index: { symbol: "000300.SH", closes: [
    { tradeDate: "2026-01-02", closePoints: 80 }, { tradeDate: dates[0]!, closePoints: 0 },
    { tradeDate: dates[2]!, closePoints: 101 }, { tradeDate: dates[3]!, closePoints: 110 },
    { tradeDate: dates[4]!, closePoints: null }, { tradeDate: dates[5]!, closePoints: 112.5 },
  ] },
};

test("normalizes each positive series against its independent first positive aligned date", () => {
  const output = computeTspPaperNavBenchmark(base);
  expect(output).toEqual({
    producer: "whyj", formulaVersion: "tsp-paper-nav-benchmark-v1", referenceRevision: TSP_INDICATOR_REVISION,
    accountId: "paper", currency: "CNY", benchmarkSymbol: "000300.SH",
    baselines: { nav: { tradeDate: dates[1], value: 90 }, benchmark: { tradeDate: dates[2], value: 101 } },
    coverage: { navRows: 6, positiveNavRows: 3, positiveBenchmarkRows: 3, missingBenchmarkRows: 2 },
    rows: [
      { tradeDate: dates[0], nav: 0, benchmarkClosePoints: 0, navBase100: null, benchmarkBase100: null },
      { tradeDate: dates[1], nav: 90, benchmarkClosePoints: null, navBase100: 100, benchmarkBase100: null },
      { tradeDate: dates[2], nav: 100, benchmarkClosePoints: 101, navBase100: 111.11, benchmarkBase100: 100 },
      { tradeDate: dates[3], nav: -10, benchmarkClosePoints: 110, navBase100: null, benchmarkBase100: 108.91 },
      { tradeDate: dates[4], nav: 0, benchmarkClosePoints: null, navBase100: null, benchmarkBase100: null },
      { tradeDate: dates[5], nav: 112.5, benchmarkClosePoints: 112.5, navBase100: 125, benchmarkBase100: 111.39 },
    ],
  });
});

test("keeps both all-missing and empty chart series explicit", () => {
  expect(computeTspPaperNavBenchmark({ ...base, finalizedNav: base.finalizedNav.slice(0, 1), index: { ...base.index, closes: [] } }))
    .toMatchObject({ baselines: { nav: null, benchmark: null }, rows: [{ navBase100: null, benchmarkBase100: null }],
      coverage: { navRows: 1, missingBenchmarkRows: 1 } });
  expect(computeTspPaperNavBenchmark({ ...base, finalizedNav: [] })).toMatchObject({
    baselines: { nav: null, benchmark: null }, rows: [], coverage: { navRows: 0, positiveBenchmarkRows: 0 },
  });
});

test("rejects invalid chart evidence rather than reordering or replacing values", () => {
  for (const scope of [
    { finalizedNav: base.finalizedNav.toReversed() }, { finalizedNav: [...base.finalizedNav, base.finalizedNav.at(-1)!] },
    { finalizedNav: [{ ...base.finalizedNav[0], currency: "USD" }] }, { index: { ...base.index, symbol: "000001.SH" } },
    { index: { ...base.index, closes: base.index.closes.toReversed() } },
    { index: { ...base.index, closes: [{ tradeDate: "2026-02-31", closePoints: 110 }] } },
    { index: { ...base.index, closes: [{ tradeDate: dates[0], closePoints: NaN }] } },
  ]) expect(() => computeTspPaperNavBenchmark({ ...base, ...scope } as TspPaperNavBenchmarkInput)).toThrow();
});

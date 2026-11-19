import { expect, test } from "bun:test";
import { computeTspPriceDeviation, tspDeviationBenchmarkCandidates, TSP_INDICATOR_REVISION, TSP_PRICE_DEVIATION_FORMULA_VERSION } from "../index.ts";
import type { TspDeviationIndex, TspPriceDeviationInput } from "../index.ts";
import fixture from "./fixtures/tsp-price-deviation.json";

const inputFor = (series: typeof fixture.series[number]): TspPriceDeviationInput => ({
  symbol: series.symbol, tradingDates: fixture.dates, stock: series.stock,
  benchmark: { symbol: series.benchmark.symbol as TspDeviationIndex, levels: series.benchmark.levels },
});

test("matches the pinned three deviation fields and benchmark candidates across five boards", () => {
  expect(TSP_INDICATOR_REVISION).toBe(fixture.revision);
  expect(TSP_PRICE_DEVIATION_FORMULA_VERSION).toBe(1);
  for (const series of fixture.series) {
    const result = computeTspPriceDeviation(inputFor(series));
    expect(tspDeviationBenchmarkCandidates(series.symbol)).toEqual(series.candidates as TspDeviationIndex[]);
    expect(series.board).toBe(result.board);
    expect(series.benchmark.symbol).toBe(result.benchmark!);
    expect(result.rows).toHaveLength(fixture.dates.length);
    for (const [i, row] of result.rows.entries()) {
      for (const key of ["deviate_3d", "deviate_10d", "deviate_30d"] as const) {
        const expected = series.expected[i]![key];
        if (expected === null) expect(row.values[key]).toBeNull();
        else expect(row.values[key]!, `${series.symbol}:${row.date}:${key}`).toBeCloseTo(expected, 12);
      }
    }
  }
});

test("uses fixed calendar endpoints for every window and reports unavailable inputs without backfill", () => {
  const series = fixture.series[0]!;
  const input = inputFor(series);
  const first = computeTspPriceDeviation(input);
  const benchmark = input.benchmark!;
  const last = fixture.dates.length - 1, missing = fixture.dates[last - 3]!;
  const withGap = computeTspPriceDeviation({ ...input, stock: input.stock.filter(row => row.date !== missing) });
  expect(withGap.rows[last]!.values).toEqual({ ...first.rows[last]!.values, deviate_3d: null });
  expect(withGap.rows[last]!.comparisonDates[3]).toBe(missing);
  const partial = computeTspPriceDeviation({ ...input, benchmark: { ...benchmark, levels: benchmark.levels.slice(0, -1) } });
  expect(partial.rows[last]!.values).toEqual({ deviate_3d: null, deviate_10d: null, deviate_30d: null });
  expect(computeTspPriceDeviation({ ...input, benchmark: null }).benchmark).toBeNull();

  const alternate = series.candidates[1] as TspDeviationIndex;
  const alternateResult = computeTspPriceDeviation({ ...input, benchmark: { ...benchmark, symbol: alternate } });
  expect(alternateResult.benchmark).toBe(alternate);
  const count = 31;
  const prefix = computeTspPriceDeviation({ ...input, tradingDates: input.tradingDates.slice(0, count),
    stock: input.stock.slice(0, count), benchmark: { ...benchmark, levels: benchmark.levels.slice(0, count) } });
  expect(prefix.rows).toEqual(first.rows.slice(0, count));
});

test("rejects unsupported benchmarks and inconsistent close history instead of changing the selected window", () => {
  const input = inputFor(fixture.series[0]!);
  const benchmark = input.benchmark!;
  expect(() => computeTspPriceDeviation({ ...input, symbol: "899050.BJ" })).toThrow("stock symbol");
  expect(() => computeTspPriceDeviation({ ...input, benchmark: { ...benchmark, symbol: "899050.BJ" } })).toThrow("eligible");
  expect(() => computeTspPriceDeviation({ ...input, tradingDates: [input.tradingDates[1]!, input.tradingDates[0]!] })).toThrow("calendar");
  expect(() => computeTspPriceDeviation({ ...input, stock: [...input.stock, input.stock.at(-1)!] })).toThrow("closes");
  expect(() => computeTspPriceDeviation({ ...input, stock: [{ date: "1999-01-01", close: 1 }] })).toThrow("closes");
});

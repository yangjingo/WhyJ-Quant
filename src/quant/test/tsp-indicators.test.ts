import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computeTspIndicators, TSP_INDICATOR_FORMULA_VERSION, TSP_INDICATOR_REVISION } from "../index.ts";
import type { TspIndicatorBar } from "../index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tsp-indicators.json", import.meta.url), "utf8")) as {
  revision: string; polars: string;
  cases: Record<string, { bars: TspIndicatorBar[]; expected: { rsi_6: number; rsi_14: number; rsi_24: number; atr_14: number }[] }>;
};

test("matches pinned TSP RSI and ATR outputs for every synthetic row", () => {
  expect(TSP_INDICATOR_REVISION).toBe(fixture.revision);
  expect(TSP_INDICATOR_FORMULA_VERSION).toBe(1);
  expect(Object.keys(fixture.cases)).toEqual(["flat", "flat_zero_range", "rising", "falling", "mixed", "varying_range"]);
  for (const { bars, expected } of Object.values(fixture.cases)) {
    const result = computeTspIndicators(bars);
    expect(result).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const row = result[i]!, reference = expected[i]!;
      expect(row.date).toBe(bars[i]!.date);
      expect(row.rsi6).toBeCloseTo(reference.rsi_6, 9);
      expect(row.rsi14).toBeCloseTo(reference.rsi_14, 9);
      expect(row.rsi24).toBeCloseTo(reference.rsi_24, 9);
      expect(row.atr14).toBeCloseTo(reference.atr_14, 9);
    }
  }
});

test("rejects invalid or unordered inputs without emitting partial rows", () => {
  const [a, b] = fixture.cases.flat!.bars;
  expect(computeTspIndicators([])).toEqual([]);
  for (const rows of [[a!, a!], [b!, a!], [a!, { ...b!, date: "2024-02-30" }],
    [a!, { ...b!, close: NaN }], [a!, { ...b!, high: 1 }], [a!, { ...b!, volume: -1 }],
    [a!, { ...b!, low: null }]]) {
    expect(() => computeTspIndicators(rows as TspIndicatorBar[])).toThrow("Invalid TSP indicator bars");
  }
});

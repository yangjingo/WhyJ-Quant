import { expect, test } from "bun:test";
import { computeTspFactorSignificance, type TspFactorSignificanceInput } from "../index.ts";

function factor(factorId: string, values: (number | null)[]): TspFactorSignificanceInput["factors"][number] {
  return {
    factorId,
    series: values.map((ic, i) => ({ tradeDate: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), ic })),
  };
}

test("matches TSP Newey–West, ordinary fallback and batch correction in input order", () => {
  const mixed = [0.17, 0.4, null, 0.31, 0.22, -0.05, 0.13, 0.36, 0.38, -0.04];
  const family = [
    factor("mixed", mixed), factor("short", [0.2, 0.4, -0.1]), factor("tied", mixed),
    factor("unavailable", [null, 0, 0]), factor("zero-mean", [0.3, -0.3, 0.3, -0.3]),
    factor("small-tail", Array.from({ length: 32 }, (_, i) => i % 4 < 2 ? 0.2 : 0.5)),
    factor("missing", [null, -0.3]),
  ];
  const report = computeTspFactorSignificance({ lag: 1, factors: family });
  expect(report).toMatchObject({
    producer: "whyj", formulaVersion: "tsp-factor-significance-v1",
    referenceRevision: "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", testedFactorCount: 5, lag: 1,
  });
  expect(report.results.map(row => row.factorId)).toEqual(family.map(row => row.factorId));
  const [observed, short, tied, unavailable, zero, tail, missing] = report.results;
  // Pinned stats_v2.py at f9cb383c via Python/NumPy, including BH over five usable tests.
  expect(observed).toMatchObject({ observedSamples: 9, missingSamples: 1, pBasis: "newey-west" });
  expect(observed!.ordinaryT).toBeCloseTo(3.6510016862799346, 12);
  expect(observed!.neweyWestT).toBeCloseTo(3.8568767375174176, 12);
  expect(observed!.neweyWestStandardError).toBeCloseTo(0.054160115322572075, 14);
  expect(observed!.pValue).toBeCloseTo(0.00011484503780791472, 15);
  expect(observed!.qValue).toBeCloseTo(0.00019140839634652454, 15);
  expect(tied!.qValue).toBe(observed!.qValue);
  expect(short).toMatchObject({ pBasis: "ordinary-t", neweyWestT: null });
  expect(short!.pValue).toBeCloseTo(0.2513491088102227, 13);
  expect(short!.qValue).toBeCloseTo(0.3141863860127784, 13);
  expect(unavailable).toMatchObject({ pBasis: null, pValue: null, qValue: null });
  expect(missing).toMatchObject({ observedSamples: 1, missingSamples: 1, pValue: null, qValue: null });
  expect(zero).toMatchObject({ ordinaryT: 0, neweyWestT: 0, pValue: 1, qValue: 1 });
  const tailProbability = 1.2591636100770033e-38;
  expect(tail!.pValue! / tailProbability).toBeCloseTo(1, 12);
  expect(tail!.qValue! / (5 * tailProbability)).toBeCloseTo(1, 12);
});

test("rejects duplicate factors, invalid lag, non-finite IC and unordered dates", () => {
  const valid = factor("valid", [0, 1, -1, null, 0.5]);
  expect(() => computeTspFactorSignificance({ lag: 1, factors: [valid, valid] })).toThrow("factor identity");
  expect(() => computeTspFactorSignificance({ lag: -1, factors: [valid] })).toThrow("test family");
  for (const invalid of [NaN, Infinity, 1.01, -1.01]) {
    expect(() => computeTspFactorSignificance({ lag: 1, factors: [factor("invalid", [invalid])] })).toThrow("IC observation");
  }
  const unordered = { ...valid, series: valid.series.toReversed() };
  expect(() => computeTspFactorSignificance({ lag: 1, factors: [unordered] })).toThrow("IC observation");
  expect(computeTspFactorSignificance({ lag: 0, factors: [] })).toMatchObject({ testedFactorCount: 0, results: [] });
});

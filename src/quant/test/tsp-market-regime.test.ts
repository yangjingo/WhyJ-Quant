import { expect, test } from "bun:test";
import { computeTspMarketRegime, TSP_INDICATOR_REVISION } from "../index.ts";
import fixture from "./fixtures/tsp-market-regime.json";

const tradingDate = "2025-01-02";

test("four-dimensional market regime matches the pinned Python state thresholds and rounding", () => {
  expect(fixture.revision).toBe(TSP_INDICATOR_REVISION);
  const scores = new Set(fixture.cases.map(sample => sample.score));
  for (const boundary of [29, 30, 44, 45, 54, 55, 69, 70]) expect(scores.has(boundary)).toBe(true);
  const halfTies = fixture.cases.filter(sample => sample.rawScore % 1 === 0.5);
  expect(new Set(halfTies.map(sample => Math.floor(sample.rawScore) % 2))).toEqual(new Set([0, 1]));
  for (const sample of fixture.cases) {
    const result = computeTspMarketRegime(tradingDate, sample.metrics);
    expect(result.producer).toBe("whyj");
    expect(result.formula).toEqual({ id: "tsp_market_regime", version: 1, revision: TSP_INDICATOR_REVISION });
    expect<string | null>(result.state).toBe(sample.state);
    expect(result.score).toBe(sample.score);
    expect(result.rawScore).toBeCloseTo(sample.rawScore, 12);
    for (const dimension of ["profit", "speculation", "resilience", "trend"] as const) {
      expect(result.dimensions?.[dimension]).toBeCloseTo(sample.dimensions[dimension], 12);
    }
    expect(result.input.availability).toBe("complete");
  }
});

test("keeps zero fallbacks, absent metrics, unavailable scores and neutral non-finite inputs explicit", () => {
  const result = computeTspMarketRegime(tradingDate, { sealFraction: 0, aboveMa20Fraction: 0,
    upFraction: 0, averageFraction: NaN, medianFraction: Infinity, limitUpCount: null });
  expect(result.input.availability).toBe("partial");
  expect(result.input.observed).toBe(3);
  expect(result.input.evidence).toMatchObject({
    sealFraction: { observed: 0, normalizationInput: 50, basis: "zero-fallback" },
    aboveMa20Fraction: { observed: 0, normalizationInput: 50, basis: "zero-fallback" },
    upFraction: { observed: 0, normalizationInput: 0, basis: "observed" },
    averageFraction: { observed: null, normalizationInput: null, basis: "non-finite-neutral" },
    medianFraction: { observed: null, normalizationInput: null, basis: "non-finite-neutral" },
    limitUpCount: { observed: null, normalizationInput: 0, basis: "missing-default" },
  });
  expect(computeTspMarketRegime(tradingDate, { upFraction: NaN })).toMatchObject({
    input: { availability: "unavailable", observed: 0 }, state: null, score: null, rawScore: null, dimensions: null,
  });
});

test("rejects nonexistent market dates, invalid fractions and fractional counts", () => {
  expect(() => computeTspMarketRegime("2025-02-29", {})).toThrow("Invalid market regime date");
  expect(() => computeTspMarketRegime(tradingDate, { upFraction: 2 })).toThrow("upFraction");
  expect(() => computeTspMarketRegime(tradingDate, { limitUpCount: 5.3 })).toThrow("limitUpCount");
  expect(() => computeTspMarketRegime(tradingDate, { indexChangeFraction: -1.1 })).toThrow("indexChangeFraction");
});

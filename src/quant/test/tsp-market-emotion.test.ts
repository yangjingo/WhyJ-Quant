import { expect, test } from "bun:test";
import { computeTspMarketEmotion, TSP_INDICATOR_REVISION, TSP_MARKET_EMOTION_FORMULA_VERSION } from "../index.ts";
import fixture from "./fixtures/tsp-market-emotion.json";

test("matches pinned default and overridden emotion scores and radar across observed fixtures", () => {
  expect(fixture.revision).toBe(TSP_INDICATOR_REVISION);
  expect(TSP_MARKET_EMOTION_FORMULA_VERSION).toBe(1);
  for (const [index, sample] of fixture.cases.entries()) {
    const output = computeTspMarketEmotion(sample.metrics, sample.overrides);
    expect(output.score, `sample ${index}`).toBe(sample.expected.score);
    expect(sample.expected.label, `sample ${index}`).toBe(output.label!);
    expect(output.config.thresholds).toEqual(sample.expected.thresholds);
    expect(output.radar.map(({ key, label, value, weight, inverted }) => ({ key: String(key), label, value, weight, invert: inverted })))
      .toEqual(sample.expected.dimensions);
    expect(output.observedDimensions).toBeGreaterThan(0);
  }
});

test("records neutral fallback separately from observations and returns no score without evidence", () => {
  const absent = computeTspMarketEmotion({});
  expect(absent.score).toBeNull();
  expect(absent.label).toBeNull();
  expect(absent.observedDimensions).toBe(0);
  expect(absent.radar.every(item => item.value === 50 && item.observedTerms === 0)).toBe(true);
  expect(computeTspMarketEmotion({ avg_index_pct: null, avg_vol_ratio: null }).score).toBeNull();
  const observed = computeTspMarketEmotion({ avg_index_pct: 0, avg_vol_ratio: null }, {
    dimensions: { profit: { weight: -1 }, money: { terms: { avg_vol_ratio: { low: 1, high: 1 } } } },
  });
  expect(observed.score).toBe(50);
  expect(observed.observedDimensions).toBe(1);
  expect(observed.radar[0]).toMatchObject({ value: 50, observedTerms: 1 });
  expect(observed.radar.find(item => item.key === "money")).toMatchObject({ value: 50, observedTerms: 0 });
  expect(observed.config.dimensions.find(item => item.key === "profit")?.weight).toBe(1);
  expect(observed.config.dimensions[0]!.terms[0]!.unit).toBe("percentage-point");
});

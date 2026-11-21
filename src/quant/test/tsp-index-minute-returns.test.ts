import { expect, test } from "bun:test";
import { computeTspIndexMinuteReturns } from "../index.ts";

const stamp = Date.parse("2024-02-05T09:30:00+08:00");
const prices = [1_000, 1_025, 975].map((closePoints, index) => ({ sourceTimestamp: stamp + index * 60_000, closePoints }));

test("matches the pinned index chart's close-to-prior-close fraction and preserves true zero", () => {
  const result = computeTspIndexMinuteReturns(prices, 1_000);
  expect(result).toMatchObject({ producer: "whyj", formulaVersion: "tsp-index-minute-return-v1", returnUnit: "fraction", previousClosePoints: 1_000 });
  expect(result.points.map(point => point.sourceTimestamp)).toEqual(prices.map(row => row.sourceTimestamp));
  expect(result.points[0]?.returnFraction).toBe(0);
  expect(result.points[1]?.returnFraction).toBeCloseTo(0.025, 12);
  expect(result.points[2]?.returnFraction).toBeCloseTo(-0.025, 12);
  expect(computeTspIndexMinuteReturns(prices, null).points.every(point => point.returnFraction === null)).toBe(true);
  expect(computeTspIndexMinuteReturns([], 1_000).points).toEqual([]);
});

test("rejects unsupported prices, repeated or unordered provider labels, and overflow", () => {
  for (const reference of [NaN, Infinity, 0, -1]) {
    expect(() => computeTspIndexMinuteReturns(prices, reference)).toThrow("previous close");
  }
  for (const invalid of [
    [prices[0]!, prices[0]!], [...prices].reverse(), [{ sourceTimestamp: 0, closePoints: 1 }],
    [{ sourceTimestamp: stamp, closePoints: Infinity }], [{ sourceTimestamp: stamp, closePoints: 0 }],
  ]) {
    expect(() => computeTspIndexMinuteReturns(invalid, 1_000)).toThrow("positive closes");
  }
  expect(() => computeTspIndexMinuteReturns(prices, Number.MIN_VALUE)).toThrow("finite numeric");
});
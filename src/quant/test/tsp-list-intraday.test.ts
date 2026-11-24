import { expect, test } from "bun:test";
import { computeTspListIntraday, TSP_INDICATOR_REVISION } from "../index.ts";

const tradingDate = "2025-03-07";
const bars = [
  { tradingDate, minute: "09:30", open: 10.1, close: 10.4 },
  { tradingDate, minute: "09:32", open: 10.4, close: 9.8 },
  { tradingDate, minute: "13:01", open: 9.8, close: 10 },
];
const input = { tradeDate: tradingDate, bars, previousClose: 10 };

test("uses the exact completed minutes, cumulative observed closes and actual previous close", () => {
  const result = computeTspListIntraday(input);
  expect(result).toMatchObject({
    producer: "whyj", formula: { id: "tsp_list_intraday", version: 1, revision: TSP_INDICATOR_REVISION },
    tradeDate: tradingDate, plotBaseline: { kind: "previous-close", value: 10 },
    latestReturnFraction: 0,
  });
  expect(result.points).toEqual([
    { minute: "09:30", close: 10.4, averageClose: 10.4, previousCloseReturnFraction: 10.4 / 10 - 1 },
    { minute: "09:32", close: 9.8, averageClose: (10.4 + 9.8) / 2, previousCloseReturnFraction: 9.8 / 10 - 1 },
    { minute: "13:01", close: 10, averageClose: (10.4 + 9.8 + 10) / 3, previousCloseReturnFraction: 0 },
  ]);
});

test("discloses plot fallback while leaving previous-close returns unavailable", () => {
  const pending = { ...input, previousClose: null };
  const implied = computeTspListIntraday({ ...pending, sameCloseChangeFraction: 0.1 });
  expect(implied.plotBaseline).toEqual({ kind: "implied-from-last-return", value: 10 / 1.1 });
  expect(implied.latestReturnFraction).toBeNull();
  expect(implied.points.every(point => point.previousCloseReturnFraction === null)).toBe(true);
  expect(computeTspListIntraday({ ...pending, sameCloseChangeFraction: 0 }).plotBaseline)
    .toEqual({ kind: "first-observed-open", value: 10.1 });
  expect(computeTspListIntraday({ ...pending, bars: [{ ...bars[0]!, open: null }] }).plotBaseline)
    .toEqual({ kind: "first-observed-close", value: 10.4 });
  expect(computeTspListIntraday({ ...input, bars: [] })).toMatchObject({ plotBaseline: null, latestReturnFraction: null, points: [] });
});

test("rejects impossible or unordered minute and price evidence", () => {
  for (const invalid of [
    { ...input, bars: [bars[0]!, bars[0]!] },
    { ...input, bars: bars.toReversed() },
    { ...input, bars: [{ ...bars[0]!, minute: "11:30" }] },
    { ...input, bars: [{ ...bars[0]!, tradingDate: "2025-03-06" }] },
    { ...input, bars: [{ ...bars[0]!, close: Infinity }] },
    { ...input, bars: [{ ...bars[0]!, open: 0 }] },
    { ...input, previousClose: 0 },
    { ...input, sameCloseChangeFraction: -1 },
  ]) expect(() => computeTspListIntraday(invalid)).toThrow();
});

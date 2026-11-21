import { expect, test } from "bun:test";
import { computeTspFactorInformation, type TspFactorInformationInput } from "../index.ts";

// Expected values come from the pinned TSP preparation, IC, yearly and decay methods with Polars 1.44.1.
const sessions = [
  "2025-12-29", "2025-12-30", "2025-12-31",
  "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13",
];
const prices = [
  [10, 11, 12, null, 13, 13, 12, 14, 14],
  [10, 9.5, 9, 11, 12, 12, 14, 15, 13],
  [10, null, 9, 8, 10, 11, 10, 12, 14],
  [10, 12, 10, null, 8, 9, 8, 7, 8],
  [8, 8, 9, 10, 11, 10, 10, 11, 12],
];
const factors = [
  [1, 2, 1, 1, 2, 3, 1, 1, null],
  [2, 1, 3, 4, null, 1, 1, 3, null],
  [3, 3, 2, 3, 2, 3, 1, 2, null],
  [4, 4, 4, 2, 2, 2, 1, 1, null],
  [5, null, 2, 2, 1, 3, 1, 3, null],
];
const rows = prices.flatMap((values, symbolIndex) => sessions.map((tradeDate, index) => ({
  symbol: "S" + symbolIndex, tradeDate, close: values[index]!, factor: factors[symbolIndex]![index]!,
})));
const input: TspFactorInformationInput = { factorId: "test-factor", rebalance: "daily", sessions, rows };
const decay: ReturnType<typeof computeTspFactorInformation>["decay"] = [
  { horizon: 1, icMean: 0.0346, nDates: 7 },
  { horizon: 3, icMean: 0.2181, nDates: 6 },
  { horizon: 5, icMean: -0.4878, nDates: 4 },
];

test("matches the pinned daily information statistics with ties, missing prices and outcomes without a factor", () => {
  const result = computeTspFactorInformation(input);
  expect(result).toMatchObject({
    producer: "whyj", formulaVersion: "tsp-factor-v2-information-v1", factorId: "test-factor",
    referenceRevision: "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc",
    start: sessions[0], end: sessions.at(-1), coverage: 0.8333, priceRows: 42, factorRows: 35, factorDates: 8, symbolCount: 5,
    summary: { icMean: 0.0144, icStd: 0.5343, ir: 0.0269, winRate: 0.2857, nDates: 7 },
    yearly: [
      { year: 2025, icMean: 0.122, ir: 0.2162, winRate: 0.3333, nDates: 3 },
      { year: 2026, icMean: -0.0663, ir: -0.1338, winRate: 0.25, nDates: 4 },
    ],
    decay,
  });
  expect(result.series).toEqual([
    { tradeDate: "2025-12-29", outcomeDate: "2025-12-30", ic: 0, pairCount: 4 },
    { tradeDate: "2025-12-30", outcomeDate: "2025-12-31", ic: -0.5, pairCount: 3 },
    { tradeDate: "2025-12-31", outcomeDate: "2026-01-06", ic: 0.866, pairCount: 3 },
    { tradeDate: "2026-01-06", outcomeDate: "2026-01-07", ic: -0.5, pairCount: 3 },
    { tradeDate: "2026-01-07", outcomeDate: "2026-01-08", ic: 0.7746, pairCount: 4 },
    { tradeDate: "2026-01-08", outcomeDate: "2026-01-09", ic: -0.2236, pairCount: 5 },
    { tradeDate: "2026-01-12", outcomeDate: "2026-01-13", ic: -0.3162, pairCount: 5 },
  ]);
  expect(computeTspFactorInformation({ ...input, rows: rows.toReversed() })).toEqual(result);
});

test("weekly and monthly use the first observed price date and keep the daily decay independent", () => {
  const weekly = computeTspFactorInformation({ ...input, rebalance: "weekly" });
  const monthly = computeTspFactorInformation({ ...input, rebalance: "monthly" });
  expect(weekly.series).toEqual([
    { tradeDate: "2025-12-29", outcomeDate: "2026-01-06", ic: 0.5, pairCount: 3 },
    { tradeDate: "2026-01-06", outcomeDate: "2026-01-12", ic: 0.5, pairCount: 3 },
  ]);
  expect(monthly.series).toEqual([weekly.series[0]!]);
  expect(weekly.summary).toEqual({ icMean: 0.5, icStd: 0, ir: null, winRate: 1, nDates: 2 });
  expect(monthly.summary).toEqual({ icMean: 0.5, icStd: 0, ir: null, winRate: 1, nDates: 1 });
  expect(weekly.decay).toEqual(decay);
  expect(monthly.decay).toEqual(decay);
});

test("a missing market session cannot move an outcome to a later observed day", () => {
  const sparse = computeTspFactorInformation({
    ...input, sessions: sessions.slice(0, 4),
    rows: [
      { tradeDate: sessions[0]!, symbol: "A", close: 10, factor: 1 },
      { tradeDate: sessions[0]!, symbol: "B", close: 10, factor: 2 },
      { tradeDate: sessions[3]!, symbol: "A", close: 11, factor: null },
      { tradeDate: sessions[3]!, symbol: "B", close: 9, factor: null },
    ],
  });
  expect(sparse.series).toEqual([]);
  expect(sparse.summary).toEqual({ icMean: null, icStd: null, ir: null, winRate: null, nDates: 0 });
  expect(sparse.decay).toEqual([{ horizon: 1, icMean: null, nDates: 0 }, { horizon: 3, icMean: -1, nDates: 1 },
    { horizon: 5, icMean: null, nDates: 0 }]);
  expect(computeTspFactorInformation({ ...input, rows: [] }).coverage).toBeNull();
});

test("rejects ambiguous rows, invalid calendars and nonfinite inputs", () => {
  const row = rows[0]!;
  expect(() => computeTspFactorInformation({ ...input, sessions: sessions.toReversed() })).toThrow("Invalid factor-information scope");
  expect(() => computeTspFactorInformation({ ...input, sessions: ["2026-02-30"] })).toThrow("Invalid factor-information scope");
  for (const invalid of [
    [row, row], [{ ...row, tradeDate: "2025-12-28" }], [{ ...row, close: 0 }], [{ ...row, factor: Infinity }],
    [{ ...row, symbol: "" }],
  ]) {
    expect(() => computeTspFactorInformation({ ...input, rows: invalid })).toThrow("Invalid or duplicate factor-information row");
  }
});

test("four-decimal summary matches ties-to-even formatting for an exact half case", () => {
  const dates = Array.from({ length: 33 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  const observations = dates.flatMap((tradeDate, i) => [
    { symbol: "A", tradeDate, close: 10 + i, factor: i === 0 ? 2 : 1 },
    { symbol: "B", tradeDate, close: 10, factor: i === 0 ? 1 : 2 },
  ]);
  expect(computeTspFactorInformation({ ...input, sessions: dates, rows: observations }).summary)
    .toEqual({ icMean: -0.9375, icStd: 0.348, ir: -2.6941, winRate: 0.0312, nDates: 32 });
});

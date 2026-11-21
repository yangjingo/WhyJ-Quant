import { expect, test } from "bun:test";
import { computeTspFactorInformation, type TspFactorInformationInput, type TspFactorRegimeObservation } from "../index.ts";

const sessions = [
  "2025-12-29", "2025-12-30", "2025-12-31",
  "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13",
];
const precedingSession = "2025-12-26";
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
const rows = prices.flatMap((values, index) => sessions.map((tradeDate, i) => ({
  symbol: "S" + index, tradeDate, close: values[i]!, factor: factors[index]![i]!,
})));
const input: TspFactorInformationInput = { factorId: "fixture", rebalance: "daily", sessions, rows };
const observations: TspFactorRegimeObservation[] = [
  { tradeDate: precedingSession, state: "lean_strong", score: 62 },
  { tradeDate: sessions[0]!, state: "strong", score: 80 },
  { tradeDate: sessions[1]!, state: "range", score: 48 },
  { tradeDate: sessions[2]!, state: "lean_weak", score: 34 },
  { tradeDate: sessions[3]!, state: "weak", score: 18 },
  { tradeDate: sessions[4]!, state: "lean_strong", score: 63 },
  { tradeDate: sessions[5]!, state: "range", score: 50 },
  { tradeDate: sessions[6]!, state: "strong", score: 77 },
  { tradeDate: sessions[7]!, state: "range", score: 50 },
  { tradeDate: sessions[8]!, state: "weak", score: 20 },
];

// Expected aggregation is from the pinned TSP factor methods and regime alignment with Polars 1.44.1 and NumPy 2.4.4.
test("matches the pinned three-state diagnostic and uses the exact predecessor across holidays", () => {
  const result = computeTspFactorInformation(input, { precedingSession, observations });
  expect(result.marketRegime).toMatchObject({
    formulaVersion: "tsp-factor-v2-regime-v1", unclassifiedAtStart: null,
    buckets: [
      { state: "strong", icMean: -0.26, ir: -1.4437, winRate: 0, meanScore: 70.5, nDates: 4, nIcDates: 4 },
      { state: "range", icMean: 0.866, ir: null, winRate: 1, meanScore: 49.33, nDates: 3, nIcDates: 1 },
      { state: "weak", icMean: 0.1373, ir: 0.2154, winRate: 0.5, meanScore: 26, nDates: 2, nIcDates: 2 },
    ],
  });
  expect(result.marketRegime?.assignments[0]).toEqual({ tradeDate: "2025-12-29", previousTradeDate: precedingSession, state: "strong", score: 62 });
  expect(result.marketRegime?.assignments[3]).toEqual({ tradeDate: "2026-01-06", previousTradeDate: "2025-12-31", state: "weak", score: 34 });
  expect(result.marketRegime?.assignments.at(-1)).toEqual({ tradeDate: "2026-01-13", previousTradeDate: "2026-01-12", state: "range", score: 50 });
  expect(computeTspFactorInformation(input)).not.toHaveProperty("marketRegime");
});

test("skips an unobserved initial predecessor and excludes dates with no prices from the bucket count", () => {
  const boundary = computeTspFactorInformation(input, { observations: observations.slice(1) }).marketRegime;
  expect(boundary?.unclassifiedAtStart).toBe(sessions[0]!);
  expect(boundary?.buckets[0]).toEqual({ state: "strong", icMean: -0.3466, ir: -3.0176, winRate: 0, meanScore: 73.33, nDates: 3, nIcDates: 3 });
  const sparse = computeTspFactorInformation({ ...input, rows: rows.filter(row => row.tradeDate !== sessions[6]!) },
    { precedingSession, observations }).marketRegime;
  expect(sparse?.assignments.find(row => row.tradeDate === sessions[6]!)).toBeUndefined();
  expect(sparse?.buckets[1]).toMatchObject({ state: "range", nDates: 2, nIcDates: 1 });
});

test("rejects missing internal predecessors, duplicate dates and invalid regime values", () => {
  for (const missing of [precedingSession, sessions[4]!]) {
    expect(() => computeTspFactorInformation(input, { precedingSession, observations: observations.filter(row => row.tradeDate !== missing) }))
      .toThrow("Missing previous-session factor regime " + missing);
  }
  expect(() => computeTspFactorInformation(input, { precedingSession: sessions[0]!, observations })).toThrow("Invalid factor regime scope");
  for (const malformed of [
    [...observations, observations[0]!],
    [{ ...observations[0]!, score: 101 }, ...observations.slice(1)],
    [{ ...observations[0]!, tradeDate: "2026-01-01" }, ...observations.slice(1)],
  ]) {
    expect(() => computeTspFactorInformation(input, { precedingSession, observations: malformed }))
      .toThrow("Invalid or duplicate factor regime observation");
  }
});

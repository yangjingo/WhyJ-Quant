import { expect, test } from "bun:test";
import { computeTspScreenerScores, type TspScreenerScoreInput } from "../index.ts";

const candidates = ["600001.SH", "600002.SH", "600003.SH", "600004.SH"];
const input: TspScreenerScoreInput = {
  tradeDate: "2024-03-04",
  candidateRevision: "a".repeat(64),
  strategy: { id: "fixture", revision: "b".repeat(64) },
  candidateSymbols: candidates,
  columns: [
    { field: "amount", values: [10, 20, 30, null] },
    { field: "turnover", values: [5, 3, 1, 2] },
    { field: "constant", values: [7, null, 7, 7] },
    { field: "all-null", values: [null, null, null, null] },
  ],
  weights: [
    { field: "amount", weight: 2 }, { field: "turnover", weight: 2, direction: "low" },
    { field: "constant", weight: 1 }, { field: "all-null", weight: 1 },
    { field: "absent", weight: 99 }, { field: "inactive", weight: 0 },
  ],
  orderBy: "turnover",
  displayLimit: 3,
};

test("matches the pinned Polars materialized-column scores and limits after ranking", () => {
  const result = computeTspScreenerScores(input);
  expect(result).toMatchObject({
    producer: "whyj", candidateRevision: input.candidateRevision, strategy: input.strategy,
    formula: { id: "tsp_screener_score", version: 1 },
    candidateCount: 4, order: { field: "score", descending: true, limit: 3 },
    scoring: { omittedFields: ["absent"] },
  });
  expect(result.scoring.fields.map(v => v.observedCount)).toEqual([3, 4, 3, 0]);
  // Reproduced with the pinned _apply_scoring and Polars 1.44.1.
  expect(result.selected.map(row => row.symbol)).toEqual([candidates[3], candidates[2], candidates[1]]);
  expect(result.selected.map(row => row.position)).toEqual([1, 2, 3]);
  expect(result.selected[0]?.score).toBeNull();
  expect(result.selected[1]?.score).toBeCloseTo(83.33333333333334, 12);
  expect(result.selected[2]?.score).toBeCloseTo(49.99999999999999, 12);
  const ascending = computeTspScreenerScores({ ...input, descending: false, displayLimit: 0 });
  expect(ascending.selected.map(row => row.symbol)).toEqual([candidates[3], candidates[0], candidates[1], candidates[2]]);
  expect(ascending.selected[1]?.score).toBeCloseTo(16.666666666666664, 12);
});

test("maintains fixed candidate order for ties and honors fallback sort and display settings", () => {
  const tied = computeTspScreenerScores({ ...input, weights: [{ field: "constant", weight: 2 }], displayLimit: null });
  expect(tied.selected.map(row => [row.symbol, row.score])).toEqual(candidates.map(symbol => [symbol, 50]));
  const fallback = computeTspScreenerScores({ ...input, weights: [], descending: false, displayLimit: 2 });
  expect(fallback.order).toEqual({ field: "turnover", descending: false, limit: 2 });
  expect(fallback.selected.map(row => [row.symbol, row.score, row.sortValue]))
    .toEqual([[candidates[2], null, 1], [candidates[3], null, 2]]);
  const universe = Array.from({ length: 103 }, (_, i) => `${600100 + i}.SH`);
  const defaultLimit = computeTspScreenerScores({ ...input, weights: [], columns: [], candidateSymbols: universe, displayLimit: undefined });
  expect(defaultLimit.selected).toHaveLength(100);
  expect(defaultLimit.selected[99]?.symbol).toBe(universe[99]);
  const empty = computeTspScreenerScores({ ...input, columns: [{ field: "amount", values: [] }], candidateSymbols: [] });
  expect(empty.selected).toEqual([]);
});

test("rejects bad candidate identity, shape, weights, revisions and arithmetic overflow", () => {
  for (const bad of [
    { tradeDate: "2024-02-30" }, { candidateRevision: "different" },
    { candidateSymbols: [candidates[0]!, candidates[0]!] },
    { columns: [{ field: "amount", values: [3] }] },
    { columns: [{ field: "amount", values: [10, 20, NaN, null] }] },
    { columns: [input.columns[0]!, input.columns[0]!] },
    { weights: [{ field: "amount", weight: -1 }] },
    { weights: [input.weights[0]!, input.weights[0]!] },
    { displayLimit: -1 },
  ]) expect(() => computeTspScreenerScores({ ...input, ...bad })).toThrow();
  expect(() => computeTspScreenerScores({ ...input,
    columns: [{ field: "amount", values: [-Number.MAX_VALUE, Number.MAX_VALUE, 0, null] }],
  })).toThrow("normalization overflow");
});

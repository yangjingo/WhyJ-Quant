import { describe, expect, test } from "bun:test";
import { computeTspParameterRobustness, planTspParameterValidation, type TspParameterCandidateEvidence } from "../index.ts";

const scope = { start: "2024-01-01", end: "2024-02-13", segmentCount: 3, objective: "sortino" as const };
const windows = planTspParameterValidation(scope.start, scope.end, scope.segmentCount);

function candidate(p: number, objectives: (number | null)[], count: number | null = 10): TspParameterCandidateEvidence {
  return { params: { p }, segments: objectives.map((objective, index) => ({ ...windows[index]!, objective, tradeCount: count })) };
}

describe("TSP parameter robustness", () => {
  test("keeps windows contiguous in the pinned calendar split and rejects short ranges", () => {
    expect(windows).toEqual([
      { start: "2024-01-01", end: "2024-01-15" },
      { start: "2024-01-16", end: "2024-01-30" },
      { start: "2024-01-31", end: "2024-02-13" },
    ]);
    expect(() => planTspParameterValidation(scope.start, "2024-02-10", 3)).toThrow("at least 14");
    expect(() => planTspParameterValidation(scope.start, scope.end, 2.5)).toThrow("Invalid");
  });

  test("matches pinned Python scores, champions and neighborhood for fixed candidates", () => {
    const result = computeTspParameterRobustness({ ...scope, candidates: [
      candidate(1, [2.98, 2.98, 2.98]),
      { ...candidate(2, [3, 3, 3]), fullWindow: { start: scope.start, end: scope.end, objective: 4, tradeCount: 31 } },
      candidate(3, [1, 5, 3]),
    ] });
    expect(result.bestParams).toEqual({ p: 2 });
    expect(result.bestScore).toBe(3);
    expect(result.results[0]).toMatchObject({ degradation: 1, degradationFraction: 0.25 });
    expect(result.results[2]).toMatchObject({ score: 2.1999999999999997, median: 3, worst: 1, spread: 4 });
    expect(result.convergence).toEqual({
      label: "majority", maxCount: 2, champions: [
        { segment: 0, params: { p: 2 }, objective: 3 },
        { segment: 1, params: { p: 3 }, objective: 5 },
        { segment: 2, params: { p: 2 }, objective: 3 },
      ],
    });
    expect(result.plateau).toMatchObject({ label: "slope", ratio: 0.5, tolerance: 0.15, validNeighborCount: 2,
      neighbors: [{ params: { p: 1 } }, { params: { p: 3 } }] });
  });

  test("uses raw minimization correctly for scores and segment champions", () => {
    const result = computeTspParameterRobustness({ ...scope, objective: "max_drawdown", direction: "min",
      candidates: [candidate(1, [4, 6, 3]), candidate(2, [3, null, 2]), candidate(3, [1, 1, 1], 1)] });
    expect(result.bestParams).toEqual({ p: 2 });
    expect(result.results[0]).toMatchObject({ median: -2.5, worst: -3, spread: 1, tradesTotal: 30 });
    expect(result.convergence).toMatchObject({ label: "majority", maxCount: 2 });
    expect(result.convergence.champions.map(row => row.params.p)).toEqual([2, 1, 2]);
    expect(result.results[2]?.status).toBe("insufficient-trades");
  });

  test("preserves zero, isolates failed and unavailable candidates, and keeps tied grid order", () => {
    const result = computeTspParameterRobustness({ ...scope, candidates: [candidate(1, [-1, -1, -1]), candidate(2, [0, 0, 0]),
      candidate(3, [0, 0, 0]), candidate(4, [null, NaN, Infinity]), { ...candidate(5, [9]), failed: true },
      candidate(6, [2, 2, 2], null)] });
    expect(result.results.map(row => [row.params.p, row.status, row.score])).toEqual([
      [2, "eligible", 0], [3, "eligible", 0], [1, "eligible", -1], [6, "insufficient-trades", 2],
      [4, "unavailable-score", null], [5, "failed", null],
    ]);
    expect(result.bestScore).toBe(0);
    expect(result.results[4]?.segments.every(row => row.objective === null)).toBe(true);
    expect(computeTspParameterRobustness({ ...scope, candidates: [candidate(4, [null, null, null])] })).toMatchObject({
      bestParams: null, bestScore: null, plateau: null, convergence: { label: "no_data" },
    });
  });

  test("rejects duplicate or misbound evidence and preserves full-window denominator rules", () => {
    const row = candidate(1, [1, 1, 1]);
    expect(() => computeTspParameterRobustness({ ...scope, candidates: [row, row] })).toThrow("Duplicate");
    expect(() => computeTspParameterRobustness({ ...scope, candidates: [{ ...row, segments: [...row.segments].reverse() }] }))
      .toThrow("exact validation window");
    const only = { ...row, fullWindow: { start: scope.start, end: scope.end, objective: 0, tradeCount: 0 } };
    expect(computeTspParameterRobustness({ ...scope, candidates: [only] }).results[0])
      .toMatchObject({ degradation: -1, degradationFraction: null });
  });
});
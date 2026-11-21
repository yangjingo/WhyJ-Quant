import { describe, expect, test } from "bun:test";
import { computeTspWalkForward, planTspWalkForward, type TspWalkForwardFoldEvidence } from "../index.ts";

const dates = { start: "2024-01-01", end: "2024-06-30", trainDays: 90, testDays: 30, stepDays: 30 };
const scope = { ...dates, objective: "sortino", direction: "max" as const };

function fold(index: number, totalReturn: number, objective: number | null,
  trainingObjective: number | null = 2, tradeCount = 10): TspWalkForwardFoldEvidence {
  return {
    window: planTspWalkForward(dates)[index]!,
    training: { candidateId: "fixed-parameters", objective: trainingObjective },
    heldOut: { candidateId: "fixed-parameters", objective, totalReturn, tradeCount },
  };
}

describe("TSP walk-forward", () => {
  test("pins closed calendar intervals across leap day and stops at the final complete window", () => {
    expect(planTspWalkForward(dates)).toEqual([
      { index: 0, trainStart: "2024-01-01", trainEnd: "2024-03-31", testStart: "2024-04-01", testEnd: "2024-05-01" },
      { index: 1, trainStart: "2024-01-31", trainEnd: "2024-04-30", testStart: "2024-05-01", testEnd: "2024-05-31" },
      { index: 2, trainStart: "2024-03-01", trainEnd: "2024-05-30", testStart: "2024-05-31", testEnd: "2024-06-30" },
    ]);
    expect(planTspWalkForward({ ...dates, end: "2024-06-29" })).toHaveLength(2);
    expect(() => planTspWalkForward({ ...dates, end: "2024-04-30" })).toThrow("no complete test window");
    expect(() => planTspWalkForward({ ...dates, start: "2024-02-30" })).toThrow("Invalid walk-forward");
    expect(() => planTspWalkForward({ ...dates, stepDays: 0.5 })).toThrow("Invalid walk-forward");
  });

  test("matches pinned Python aggregation for an unordered manifest", () => {
    // Pinned upstream aggregate_oos, read with f9cb383's date schedule and the upstream fixture returns.
    const result = computeTspWalkForward({ ...scope, folds: [fold(2, 0.08, 1.2), fold(0, 0.1, 1.5), fold(1, -0.05, 0.8)] });
    expect(result).toMatchObject({ producer: "whyj", formulaVersion: "tsp-walk-forward-v1", validFoldCount: 3,
      skippedFoldCount: 0, overlappingTestWindows: true, summary: {
        compoundedHeldOutReturn: 0.1286, averageTrainObjective: 2, averageHeldOutObjective: 1.1667,
        degradation: 0.8333, profitableFoldShare: 0.6667, equityCurve: [
          { fold: 0, date: "2024-05-01", value: 1.1 },
          { fold: 1, date: "2024-05-31", value: 1.045 },
          { fold: 2, date: "2024-06-30", value: 1.1286 },
        ],
      } });
  });

  test("handles min objectives and distinguishes zero return, missing objectives and omitted folds", () => {
    const result = computeTspWalkForward({ ...scope, objective: "avg_holding_days", direction: "min",
      folds: [fold(0, 0, 5, 3), fold(1, 0.2, null, null, 9)] });
    expect(result.summary).toMatchObject({ compoundedHeldOutReturn: 0, degradation: 2, profitableFoldShare: 0 });
    expect(result.folds[0]).toMatchObject({ heldOutReturn: 0, degraded: true });
    expect(result.skipped.map(entry => entry.reason)).toEqual(["insufficient-held-out-trades", "missing-training"]);
    expect(result.overlappingTestWindows).toBe(false);
    const nullObjective = computeTspWalkForward({ ...scope, folds: [
      fold(0, 0.04, null), { ...fold(1, 0, 1), heldOut: null },
    ] });
    expect(nullObjective.summary).toMatchObject({ compoundedHeldOutReturn: 0.04, averageHeldOutObjective: null, degradation: null });
    expect(nullObjective.skipped.map(entry => entry.reason)).toEqual(["missing-held-out", "missing-training"]);
    expect(nullObjective.folds[0]?.degraded).toBeNull();
    expect(computeTspWalkForward({ ...scope, folds: [] }).summary).toEqual({
      averageTrainObjective: null, averageHeldOutObjective: null, degradation: null,
      compoundedHeldOutReturn: 0, profitableFoldShare: 0, equityCurve: [],
    });
  });

  test("rejects misbound data rather than changing the window or parameter selection", () => {
    const row = fold(0, 0.1, 1.5);
    expect(() => computeTspWalkForward({ ...scope, folds: [row, row] })).toThrow("unique planned window");
    expect(() => computeTspWalkForward({ ...scope, folds: [{ ...row, window: { ...row.window, testStart: "2024-03-31" } }] }))
      .toThrow("unique planned window");
    expect(() => computeTspWalkForward({ ...scope, folds: [{ ...row, heldOut: { ...row.heldOut!, candidateId: "different" } }] }))
      .toThrow("must match the training selection");
    expect(() => computeTspWalkForward({ ...scope, folds: [fold(0, NaN, 1)] })).toThrow("valid return and trade count");
  });
});
import { expect, test } from "bun:test";
import { summarizeTspMiningRegimes, TSP_INDICATOR_REVISION, type TspMiningRegimeFoldEvidence } from "../index.ts";

const measured = {
  foldIndex: 0, candidateId: "winner", state: "overall", testSessionCount: 6,
  outcome: { status: "valid", metrics: { totalReturnFraction: 0.25, sharpe: 1.5, maxDrawdownFraction: -0.125 } },
} as const satisfies TspMiningRegimeFoldEvidence;

test("matches the pinned workbench regime aggregation for one saved signature", () => {
  const report = summarizeTspMiningRegimes({ candidateId: "winner", folds: [
    measured,
    { ...measured, foldIndex: 1, testSessionCount: 2,
      outcome: { status: "valid", metrics: { totalReturnFraction: 0, sharpe: null, maxDrawdownFraction: -0.25 } } },
    { ...measured, candidateId: "other" },
    { ...measured, state: "strong", testSessionCount: 3 },
    { ...measured, state: "range", testSessionCount: 0,
      outcome: { status: "valid", metrics: { totalReturnFraction: 0, sharpe: 0, maxDrawdownFraction: 0 } } },
    { ...measured, state: "weak", outcome: { status: "skipped", reason: "conditioned evaluation failed" } },
  ] });
  expect(report).toEqual({
    producer: "whyj", formulaVersion: "tsp-mining-regime-report-v1", referenceRevision: TSP_INDICATOR_REVISION, candidateId: "winner",
    regimes: [
      { state: "overall", testSessionCount: 8, validFolds: 2, skippedFolds: 0, meanReturnFraction: 0.125, meanSharpe: 1.5,
        worstDrawdownFraction: -0.25, coverage: { returnFolds: 2, sharpeFolds: 1, drawdownFolds: 2 } },
      { state: "strong", testSessionCount: 3, validFolds: 1, skippedFolds: 0, meanReturnFraction: 0.25, meanSharpe: 1.5,
        worstDrawdownFraction: -0.125, coverage: { returnFolds: 1, sharpeFolds: 1, drawdownFolds: 1 } },
      { state: "range", testSessionCount: 0, validFolds: 1, skippedFolds: 0, meanReturnFraction: 0, meanSharpe: 0,
        worstDrawdownFraction: 0, coverage: { returnFolds: 1, sharpeFolds: 1, drawdownFolds: 1 } },
      { state: "weak", testSessionCount: 0, validFolds: 0, skippedFolds: 1, meanReturnFraction: null, meanSharpe: null,
        worstDrawdownFraction: null, coverage: { returnFolds: 0, sharpeFolds: 0, drawdownFolds: 0 } },
    ],
  });
});

test("sums each successful fold's date count and keeps rows across signatures when none is requested", () => {
  const folds = [measured, { ...measured, foldIndex: 1 }, { ...measured, candidateId: null },
    { ...measured, candidateId: "other" }];
  expect(summarizeTspMiningRegimes({ folds })).toMatchObject({ candidateId: null, regimes: [
    { state: "overall", testSessionCount: 24, validFolds: 4 }, { state: "strong", validFolds: 0 },
    { state: "range", validFolds: 0 }, { state: "weak", validFolds: 0 },
  ] });
  expect(summarizeTspMiningRegimes({ candidateId: "unknown", folds }).regimes.every(row => row.validFolds === 0)).toBe(true);
});

test("rejects duplicate, malformed, and overflowed fold evidence", () => {
  for (const folds of [
    [measured, measured], [{ ...measured, foldIndex: -1 }], [{ ...measured, testSessionCount: -1 }],
    [{ ...measured, state: "unknown" }], [{ ...measured, candidateId: "" }],
    [{ ...measured, outcome: { status: "skipped" } }],
    [{ ...measured, outcome: { status: "valid", metrics: { ...measured.outcome.metrics, maxDrawdownFraction: 0.1 } } }],
    [{ ...measured, testSessionCount: Number.MAX_SAFE_INTEGER }, { ...measured, foldIndex: 1 }],
  ]) expect(() => summarizeTspMiningRegimes({ folds: folds as TspMiningRegimeFoldEvidence[] })).toThrow();
});

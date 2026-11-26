import { expect, test } from "bun:test";
import { summarizeTspMiningRun, TSP_INDICATOR_REVISION, type TspMiningRunFold, type TspMiningRunSummaryInput } from "../index.ts";

const selected: TspMiningRunFold = { foldIndex: 0, state: "overall", candidateId: "a", evaluationKind: "selected", skipped: false };
const skipped: TspMiningRunFold = { ...selected, foldIndex: 1, candidateId: null, skipped: true };
const base: TspMiningRunSummaryInput = {
  profile: "strict",
  factors: [{ factorId: "rsi", selected: true }, { factorId: "momentum", selected: false }],
  candidateIds: ["a", "b"],
  folds: [selected, skipped, { ...selected, state: "range" }, { ...selected, candidateId: "b", evaluationKind: "cross" },
    { ...selected, candidateId: "benchmark", evaluationKind: "benchmark" }],
  trials: { maxProxyTrials: 20, maxTrials: 10, proxyTrialsUsed: 19, searchTrialsUsed: 9, evaluatorBacktestCount: 12 },
};

test("counts run-level selected and no-candidate rows independently from comparison rows", () => {
  expect(summarizeTspMiningRun(base)).toEqual({
    producer: "whyj", formulaVersion: "tsp-mining-run-summary-v1", referenceRevision: TSP_INDICATOR_REVISION,
    profile: "strict", confidence: "high", status: "succeeded", factorCount: 2, selectedFactorCount: 1,
    candidateCount: 2, validFoldCount: 1, skippedFoldCount: 1, budgetExhausted: false,
    trials: { ...base.trials, trialsUsed: 12 },
  });
  const unattributed = { ...selected, evaluationKind: "cross", candidateId: null } as const;
  expect(summarizeTspMiningRun({ ...base, profile: "balanced", candidateIds: [], folds: [unattributed] }))
    .toMatchObject({ confidence: "standard", candidateCount: 0, validFoldCount: 1, skippedFoldCount: 0 });
  expect(summarizeTspMiningRun({ ...base, profile: "exploratory", factors: [], candidateIds: [], folds: [],
    trials: { ...base.trials, proxyTrialsUsed: 0, searchTrialsUsed: 0, evaluatorBacktestCount: 0 } }))
    .toMatchObject({ confidence: "low", factorCount: 0, validFoldCount: 0, skippedFoldCount: 0,
      budgetExhausted: false, trials: { trialsUsed: 0 } });
});

test("matches pinned trial caps and saved case-sensitive outer-search error", () => {
  for (const trials of [{ ...base.trials, proxyTrialsUsed: 20 }, { ...base.trials, searchTrialsUsed: 10 },
    { ...base.trials, searchTrialsUsed: 11, evaluatorBacktestCount: 8 }]) {
    expect(summarizeTspMiningRun({ ...base, trials })).toMatchObject({
      status: "succeeded_with_budget_exhausted", budgetExhausted: true,
      trials: { trialsUsed: Math.max(trials.searchTrialsUsed, trials.evaluatorBacktestCount) },
    });
  }
  const folds = [{ ...skipped, outerSearchError: "real trial budget exhausted before outer evaluation" }];
  expect(summarizeTspMiningRun({ ...base, folds })).toMatchObject({ skippedFoldCount: 1, budgetExhausted: true });
  expect(summarizeTspMiningRun({ ...base, folds: [{ ...skipped, outerSearchError: "Budget exhausted" }] }).budgetExhausted).toBe(false);
});

test("rejects ambiguous run evidence", () => {
  for (const change of [
    { candidateIds: ["a", "a"] }, { factors: [base.factors[0], base.factors[0]] },
    { folds: [selected, selected] }, { folds: [selected, { ...selected, candidateId: "b" }] },
    { folds: [{ ...selected, outerSearchError: "budget exhausted" }] },
    { folds: [{ ...skipped, evaluationKind: "cross", outerSearchError: "budget exhausted" }] },
    { trials: { ...base.trials, maxTrials: 0 } }, { trials: { ...base.trials, evaluatorBacktestCount: 0.5 } },
  ]) expect(() => summarizeTspMiningRun({ ...base, ...change } as TspMiningRunSummaryInput)).toThrow();
});

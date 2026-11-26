import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspMiningCandidateFoldEvidence, TspMiningCandidateReportInput } from "./tsp-mining-candidate-report.ts";
import type { TspMiningRegimeState } from "./tsp-mining-regime-report.ts";

export const TSP_MINING_RUN_SUMMARY_FORMULA_VERSION = "tsp-mining-run-summary-v1";

const confidenceByProfile = { exploratory: "low", balanced: "standard", strict: "high" } as const;
const states = new Set<TspMiningRegimeState>(["overall", "strong", "range", "weak"]);
const evaluationKinds = new Set<TspMiningCandidateFoldEvidence["evaluationKind"]>(["selected", "cross", "benchmark"]);

export interface TspMiningRunFold {
  foldIndex: number;
  state: TspMiningRegimeState;
  candidateId: string | null;
  evaluationKind: TspMiningCandidateFoldEvidence["evaluationKind"];
  skipped: boolean;
  /** Error saved by the outer search, separate from the candidate evaluation. */
  outerSearchError?: string | null;
}

export interface TspMiningRunSummaryInput {
  profile: TspMiningCandidateReportInput["profile"];
  factors: readonly { factorId: string; selected: boolean }[];
  candidateIds: readonly string[];
  folds: readonly TspMiningRunFold[];
  trials: {
    maxProxyTrials: number;
    maxTrials: number;
    proxyTrialsUsed: number;
    searchTrialsUsed: number;
    evaluatorBacktestCount: number;
  };
}

const hasId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function summarizeTspMiningRun({ profile, factors, candidateIds, folds, trials }: TspMiningRunSummaryInput) {
  if (typeof profile !== "string" || !Object.hasOwn(confidenceByProfile, profile) ||
    !Array.isArray(factors) || !Array.isArray(candidateIds) || !Array.isArray(folds) || !trials) {
    throw new Error("Invalid mining run scope");
  }
  const { maxProxyTrials, maxTrials, proxyTrialsUsed, searchTrialsUsed, evaluatorBacktestCount } = trials;
  if (![maxProxyTrials, maxTrials, proxyTrialsUsed, searchTrialsUsed, evaluatorBacktestCount].every(isCount) ||
    maxProxyTrials === 0 || maxTrials === 0) throw new Error("Invalid mining trial counts or limits");

  const knownFactors = new Set<string>();
  let selectedFactorCount = 0;
  for (const factor of factors as TspMiningRunSummaryInput["factors"]) {
    if (!factor || !hasId(factor.factorId) || knownFactors.has(factor.factorId) || typeof factor.selected !== "boolean") {
      throw new Error("Invalid or duplicate mining factor");
    }
    knownFactors.add(factor.factorId);
    if (factor.selected) selectedFactorCount++;
  }
  if (Array.from(candidateIds).some(id => !hasId(id)) || new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("Invalid or duplicate mining candidate");
  }

  const seenRows = new Set<string>(), selectedOuterFolds = new Set<number>();
  let validFoldCount = 0, skippedFoldCount = 0, searchRanOutOfBudget = false;
  for (const row of folds as readonly TspMiningRunFold[]) {
    if (!row || !isCount(row.foldIndex) || !states.has(row.state) || !evaluationKinds.has(row.evaluationKind) ||
      (row.candidateId !== null && !hasId(row.candidateId)) || typeof row.skipped !== "boolean") {
      throw new Error("Invalid mining run fold");
    }
    const key = JSON.stringify([row.foldIndex, row.state, row.evaluationKind, row.candidateId]);
    if (seenRows.has(key)) throw new Error("Duplicate mining run fold");
    seenRows.add(key);
    const selected = row.state === "overall" && row.evaluationKind === "selected";
    if (selected) {
      if (selectedOuterFolds.has(row.foldIndex)) throw new Error("Multiple selected outcomes for one outer fold");
      selectedOuterFolds.add(row.foldIndex);
    }
    if (row.outerSearchError != null) {
      if (!selected || !row.skipped || !hasId(row.outerSearchError)) throw new Error("Invalid outer search error");
      searchRanOutOfBudget ||= row.outerSearchError.includes("budget exhausted");
    }
    if (row.state === "overall" && (selected || row.candidateId === null)) {
      if (row.skipped) skippedFoldCount++;
      else validFoldCount++;
    }
  }
  const budgetExhausted = proxyTrialsUsed >= maxProxyTrials || searchTrialsUsed >= maxTrials || searchRanOutOfBudget;
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_MINING_RUN_SUMMARY_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    profile,
    status: budgetExhausted ? "succeeded_with_budget_exhausted" as const : "succeeded" as const,
    confidence: confidenceByProfile[profile],
    factorCount: factors.length, selectedFactorCount, candidateCount: candidateIds.length,
    validFoldCount, skippedFoldCount, budgetExhausted,
    trials: { maxProxyTrials, maxTrials, proxyTrialsUsed, searchTrialsUsed, evaluatorBacktestCount,
      trialsUsed: Math.max(searchTrialsUsed, evaluatorBacktestCount) },
  };
}

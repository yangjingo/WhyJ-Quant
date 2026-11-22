import { isDailyDate } from "../market/bars.ts";
import { mean } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { summarizeTspRobustObjectives } from "./tsp-parameter-robustness.ts";
import type { TspWalkForwardWindow } from "./tsp-walk-forward.ts";

export const TSP_MINING_CANDIDATE_REPORT_FORMULA_VERSION = "tsp-mining-candidate-report-v1";
const profileConfidence = { exploratory: "low", balanced: "standard", strict: "high" } as const;
const evaluationKinds = ["selected", "cross", "benchmark"] as const;

export interface TspMiningCandidateFoldMetrics {
  totalReturnFraction: number | null;
  sharpe: number | null;
  maxDrawdownFraction: number | null;
  tradeCount: number | null;
}

export interface TspMiningCandidateFoldEvidence {
  window: TspWalkForwardWindow;
  evaluationKind: typeof evaluationKinds[number];
  testSessionCount: number;
  outcome: { status: "valid"; metrics: TspMiningCandidateFoldMetrics } | { status: "skipped"; reason: string };
}

export interface TspMiningCandidateReportInput {
  candidateId: string;
  profile: keyof typeof profileConfidence;
  folds: readonly TspMiningCandidateFoldEvidence[];
}

export function computeTspMiningCandidateReport(input: TspMiningCandidateReportInput) {
  const { candidateId, profile, folds } = input;
  if (typeof candidateId !== "string" || !candidateId.trim() ||
    typeof profile !== "string" || !Object.hasOwn(profileConfidence, profile) || !Array.isArray(folds)) {
    throw new Error("Invalid mining candidate report scope");
  }
  const indexed = new Map<number, TspMiningCandidateFoldEvidence>();
  const returns: number[] = [], sharpes: number[] = [], drawdowns: number[] = [];
  let tradeCount = 0, tradeCountFolds = 0, validFoldCount = 0;
  for (const fold of folds as readonly TspMiningCandidateFoldEvidence[]) {
    if (!fold?.window || !evaluationKinds.includes(fold.evaluationKind) ||
      !Number.isSafeInteger(fold.testSessionCount) || fold.testSessionCount < 0) {
      throw new Error("Invalid mining candidate fold");
    }
    const { window, outcome } = fold;
    const { index, trainStart, trainEnd, testStart, testEnd } = window;
    if (!Number.isSafeInteger(index) || index < 0 || indexed.has(index) ||
      ![trainStart, trainEnd, testStart, testEnd].every(isDailyDate) ||
      trainStart > trainEnd || trainEnd >= testStart || testStart > testEnd) {
      throw new Error("Mining candidate folds require unique IDs and ordered training and test windows");
    }
    indexed.set(index, fold);
    if (outcome?.status === "skipped") {
      if (typeof outcome.reason !== "string" || !outcome.reason.trim() || Object.hasOwn(outcome, "metrics")) {
        throw new Error("Invalid skipped mining candidate fold");
      }
      continue;
    }
    if (outcome?.status !== "valid" || !outcome.metrics || fold.testSessionCount === 0) {
      throw new Error("Invalid valid mining candidate fold");
    }
    const { totalReturnFraction, sharpe, maxDrawdownFraction, tradeCount: trades } = outcome.metrics;
    if ((totalReturnFraction !== null && (!Number.isFinite(totalReturnFraction) || totalReturnFraction < -1)) ||
      (sharpe !== null && !Number.isFinite(sharpe)) ||
      (maxDrawdownFraction !== null && (!Number.isFinite(maxDrawdownFraction) || maxDrawdownFraction < -1 || maxDrawdownFraction > 0)) ||
      (trades !== null && (!Number.isSafeInteger(trades) || trades < 0))) {
      throw new Error("Invalid mining candidate fold metrics");
    }
    if (totalReturnFraction !== null) returns.push(totalReturnFraction);
    if (sharpe !== null) sharpes.push(sharpe);
    if (maxDrawdownFraction !== null) drawdowns.push(maxDrawdownFraction);
    if (trades !== null) {
      tradeCount += trades;
      tradeCountFolds++;
    }
    validFoldCount++;
  }
  if (!Number.isSafeInteger(tradeCount)) throw new Error("Mining candidate total trade count exceeds the supported range");
  const robust = summarizeTspRobustObjectives(sharpes);
  const summary = {
    robustScore: robust.score,
    meanReturnFraction: returns.length ? mean(returns) : null,
    meanSharpe: sharpes.length ? mean(sharpes) : null,
    worstSharpe: robust.worst,
    worstDrawdownFraction: drawdowns.length ? drawdowns.reduce((worst, value) => Math.min(worst, value)) : null,
    positiveReturnFoldRatio: returns.length ? returns.filter(value => value > 0).length / returns.length : null,
    tradeCount: tradeCountFolds ? tradeCount : null,
    validFoldCount,
    skippedFoldCount: folds.length - validFoldCount,
    coverage: { returnFolds: returns.length, sharpeFolds: sharpes.length, drawdownFolds: drawdowns.length, tradeCountFolds },
  };

  const thresholds = {
    minValidFolds: 2, minPositiveReturnFoldRatio: 2 / 3, minMeanSharpe: 0.5, minDrawdownFraction: -0.25, minTrades: 60,
    minWorstSharpeExclusive: profile === "strict" ? 0 : null,
  };
  const reasons: ("exploratory-profile" | "insufficient-valid-folds" | "insufficient-positive-fold-ratio" |
    "insufficient-mean-sharpe" | "nonpositive-worst-sharpe" | "excessive-drawdown" | "insufficient-trades")[] = [];
  if (profile === "exploratory") reasons.push("exploratory-profile");
  if (summary.validFoldCount < thresholds.minValidFolds) reasons.push("insufficient-valid-folds");
  if (summary.positiveReturnFoldRatio === null || summary.positiveReturnFoldRatio < thresholds.minPositiveReturnFoldRatio) {
    reasons.push("insufficient-positive-fold-ratio");
  }
  if (summary.meanSharpe === null || summary.meanSharpe < thresholds.minMeanSharpe) reasons.push("insufficient-mean-sharpe");
  if (thresholds.minWorstSharpeExclusive !== null && summary.worstSharpe !== null && summary.worstSharpe <= thresholds.minWorstSharpeExclusive) {
    reasons.push("nonpositive-worst-sharpe");
  }
  if (summary.worstDrawdownFraction === null || summary.worstDrawdownFraction < thresholds.minDrawdownFraction) reasons.push("excessive-drawdown");
  if (summary.tradeCount === null || summary.tradeCount < thresholds.minTrades) reasons.push("insufficient-trades");

  return {
    producer: "whyj" as const,
    formulaVersion: TSP_MINING_CANDIDATE_REPORT_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    candidateId, profile, confidence: profileConfidence[profile],
    folds: [...indexed.values()].sort((a, b) => a.window.index - b.window.index),
    summary,
    gate: { formulaVersion: "tsp-mining-candidate-gate-v1", qualified: reasons.length === 0, reasons, thresholds },
  };
}

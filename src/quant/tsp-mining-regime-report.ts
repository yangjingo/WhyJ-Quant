import { mean } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspMiningCandidateFoldMetrics } from "./tsp-mining-candidate-report.ts";

export const TSP_MINING_REGIME_REPORT_FORMULA_VERSION = "tsp-mining-regime-report-v1";

const states = ["overall", "strong", "range", "weak"] as const;
export type TspMiningRegimeState = typeof states[number];
type RegimeMetrics = Pick<TspMiningCandidateFoldMetrics, "totalReturnFraction" | "sharpe" | "maxDrawdownFraction">;

export interface TspMiningRegimeFoldEvidence {
  foldIndex: number;
  candidateId: string | null;
  state: TspMiningRegimeState;
  testSessionCount: number;
  outcome: { status: "valid"; metrics: RegimeMetrics } | { status: "skipped"; reason: string };
}

export interface TspMiningRegimeReportInput {
  candidateId?: string | null;
  folds: readonly TspMiningRegimeFoldEvidence[];
}

export function summarizeTspMiningRegimes({ candidateId = null, folds }: TspMiningRegimeReportInput) {
  if ((candidateId !== null && (typeof candidateId !== "string" || !candidateId.trim())) || !Array.isArray(folds)) {
    throw new Error("Invalid mining regime report scope");
  }
  const seen = new Set<string>();
  for (const fold of folds as readonly TspMiningRegimeFoldEvidence[]) {
    if (!fold || !states.includes(fold.state) || !Number.isSafeInteger(fold.foldIndex) || fold.foldIndex < 0 ||
      !Number.isSafeInteger(fold.testSessionCount) || fold.testSessionCount < 0 ||
      (fold.candidateId !== null && (typeof fold.candidateId !== "string" || !fold.candidateId.trim()))) {
      throw new Error("Invalid mining regime fold");
    }
    const key = JSON.stringify([fold.state, fold.foldIndex, fold.candidateId]);
    if (seen.has(key)) throw new Error("Duplicate mining regime fold");
    seen.add(key);
    const { outcome } = fold;
    if (outcome?.status === "skipped") {
      if (typeof outcome.reason !== "string" || !outcome.reason.trim() || Object.hasOwn(outcome, "metrics")) {
        throw new Error("Invalid skipped mining regime fold");
      }
      continue;
    }
    if (outcome?.status !== "valid" || !outcome.metrics) throw new Error("Invalid mining regime fold outcome");
    const { totalReturnFraction, sharpe, maxDrawdownFraction } = outcome.metrics;
    if ((totalReturnFraction !== null && (!Number.isFinite(totalReturnFraction) || totalReturnFraction < -1)) ||
      (sharpe !== null && !Number.isFinite(sharpe)) ||
      (maxDrawdownFraction !== null && (!Number.isFinite(maxDrawdownFraction) || maxDrawdownFraction < -1 || maxDrawdownFraction > 0))) {
      throw new Error("Invalid mining regime fold metrics");
    }
  }

  const selected = (folds as readonly TspMiningRegimeFoldEvidence[]).filter(fold => candidateId === null || fold.candidateId === candidateId);
  const regimes = states.map(state => {
    let testSessionCount = 0, validFolds = 0, skippedFolds = 0;
    const returns: number[] = [], sharpes: number[] = [], drawdowns: number[] = [];
    for (const fold of selected) {
      if (fold.state !== state) continue;
      if (fold.outcome.status === "skipped") {
        skippedFolds++;
        continue;
      }
      validFolds++;
      testSessionCount += fold.testSessionCount;
      const { totalReturnFraction, sharpe, maxDrawdownFraction } = fold.outcome.metrics;
      if (totalReturnFraction !== null) returns.push(totalReturnFraction);
      if (sharpe !== null) sharpes.push(sharpe);
      if (maxDrawdownFraction !== null) drawdowns.push(maxDrawdownFraction);
    }
    if (!Number.isSafeInteger(testSessionCount)) throw new Error("Mining regime date count exceeds the supported range");
    return {
      state, testSessionCount, validFolds, skippedFolds,
      meanReturnFraction: returns.length ? mean(returns) : null,
      meanSharpe: sharpes.length ? mean(sharpes) : null,
      worstDrawdownFraction: drawdowns.length ? drawdowns.reduce((worst, value) => Math.min(worst, value)) : null,
      coverage: { returnFolds: returns.length, sharpeFolds: sharpes.length, drawdownFolds: drawdowns.length },
    };
  });
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_MINING_REGIME_REPORT_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    candidateId, regimes,
  };
}

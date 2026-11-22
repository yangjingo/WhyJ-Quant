import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { planTspParameterValidation, summarizeTspRobustObjectives, TSP_PARAMETER_OBJECTIVES,
  type TspParameterSegmentEvidence } from "./tsp-parameter-robustness.ts";

export const TSP_STRATEGY_GUARDIAN_FORMULA_VERSION = "tsp-strategy-guardian-v1";

export interface TspStrategyGuardianThresholds {
  watchFraction: number;
  retireFraction: number;
  maxSoftDrawdownFraction: number;
  maxSegments: number;
  minNewTradingDays: number;
}

export interface TspStrategyGuardianPlanInput {
  dataAsOf: string;
  sessions: readonly string[];
  thresholds?: Partial<TspStrategyGuardianThresholds>;
}

export interface TspStrategyGuardianCheckInput extends TspStrategyGuardianPlanInput {
  strategyId: string;
  objective: typeof TSP_PARAMETER_OBJECTIVES[number];
  baselineScore: number;
  baselineTradeCount: number;
  segments: readonly (TspParameterSegmentEvidence & { maxDrawdownFraction: number | null })[];
}

export type TspStrategyGuardianReason =
  | "incomplete-segments" | "retirement-degradation" | "watch-degradation" | "hard-trade-drought"
  | "objective-soft-floor" | "drawdown-soft-floor" | "soft-trade-drought";

const defaults: TspStrategyGuardianThresholds = {
  watchFraction: 0.20, retireFraction: 0.50, maxSoftDrawdownFraction: -0.30, maxSegments: 4, minNewTradingDays: 30,
};
const drawdownObjectives = new Set(["max_drawdown", "mc_maxdd_p50", "mc_maxdd_p95"]);

export function planTspStrategyGuardianCheck(input: TspStrategyGuardianPlanInput) {
  const { dataAsOf, sessions } = input;
  const thresholds = { ...defaults, ...input.thresholds };
  const { watchFraction, retireFraction, maxSoftDrawdownFraction, maxSegments, minNewTradingDays } = thresholds;
  if (![watchFraction, retireFraction, maxSoftDrawdownFraction].every(Number.isFinite) ||
    !(watchFraction > 0 && watchFraction < retireFraction && retireFraction <= 1) ||
    !(maxSoftDrawdownFraction >= -1 && maxSoftDrawdownFraction <= 0) ||
    !Number.isInteger(maxSegments) || maxSegments < 2 || maxSegments > 4 ||
    !Number.isSafeInteger(minNewTradingDays) || minNewTradingDays < 1 ||
    !isDailyDate(dataAsOf) || dataAsOf < "0001-01-01" || !Array.isArray(sessions) ||
    Array.from(sessions).some((date, i) => !isDailyDate(date) || (i > 0 && date <= sessions[i - 1]!))) {
    throw new Error("Invalid strategy guardian calendar or thresholds");
  }
  const fresh = sessions.filter(date => date > dataAsOf);
  const base = { dataAsOf, thresholds, newTradingDays: fresh.length };
  const start = fresh[0], end = fresh.at(-1);
  if (!start || !end || fresh.length < minNewTradingDays) {
    return { ...base, status: "skipped" as const, reason: "insufficient-new-data" as const };
  }
  const span = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  const count = Math.min(maxSegments, Math.floor(span / 14));
  if (count < 2) return { ...base, status: "skipped" as const, reason: "window-too-short" as const };
  return { ...base, status: "ready" as const, windows: planTspParameterValidation(start, end, count) };
}

export function evaluateTspStrategyGuardian(input: TspStrategyGuardianCheckInput) {
  const { strategyId, objective, baselineScore, baselineTradeCount, segments } = input;
  if (typeof strategyId !== "string" || !strategyId.trim() || !TSP_PARAMETER_OBJECTIVES.includes(objective) ||
    !Number.isFinite(baselineScore) || !Number.isSafeInteger(baselineTradeCount) || baselineTradeCount < 0 || !Array.isArray(segments)) {
    throw new Error("Invalid strategy guardian baseline");
  }
  const plan = planTspStrategyGuardianCheck(input);
  const basis = {
    producer: "whyj" as const, formulaVersion: TSP_STRATEGY_GUARDIAN_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    strategyId, objective, baselineScore, baselineTradeCount,
  };
  if (plan.status === "skipped") {
    if (segments.length) throw new Error("Skipped strategy guardian check cannot accept segments");
    return { ...basis, plan, status: "skipped" as const, reason: plan.reason };
  }
  if (segments.length !== plan.windows.length) throw new Error("Strategy guardian requires evidence for each planned window");
  const values: (number | null)[] = [];
  const aligned = [];
  let tradeCount = 0, tradeCountSegments = 0, worstDrawdownFraction: number | null = null, missingScoreSegments = 0;
  for (const [index, window] of plan.windows.entries()) {
    const row = segments[index];
    if (!row || row.start !== window.start || row.end !== window.end ||
      (row.objective !== null && !Number.isFinite(row.objective)) ||
      (row.tradeCount !== null && (!Number.isSafeInteger(row.tradeCount) || row.tradeCount < 0)) ||
      (row.maxDrawdownFraction !== null &&
        (!Number.isFinite(row.maxDrawdownFraction) || row.maxDrawdownFraction < -1 || row.maxDrawdownFraction > 0))) {
      throw new Error("Invalid strategy guardian segment evidence");
    }
    values.push(row.objective);
    if (row.objective === null) missingScoreSegments++;
    if (row.tradeCount !== null) {
      tradeCount += row.tradeCount;
      tradeCountSegments++;
    }
    if (row.maxDrawdownFraction !== null) {
      worstDrawdownFraction = Math.min(worstDrawdownFraction ?? 0, row.maxDrawdownFraction);
    }
    aligned.push({ ...window, objective: row.objective, tradeCount: row.tradeCount, maxDrawdownFraction: row.maxDrawdownFraction });
  }
  if (!Number.isSafeInteger(tradeCount)) throw new Error("Strategy guardian total trade count exceeds the supported range");
  const { score: currentScore } = summarizeTspRobustObjectives(values);
  const incompleteData = missingScoreSegments > 0;
  const evidence = {
    segments: aligned, currentScore, tradeCount, tradeCountSegments, worstDrawdownFraction, missingScoreSegments, incompleteData,
  };
  if (currentScore === null) return { ...basis, plan, evidence, status: "unavailable" as const, reason: "all-segment-scores-missing" as const };

  const { watchFraction, retireFraction, maxSoftDrawdownFraction } = plan.thresholds;
  const degradationFraction = baselineScore > 0 ? finiteStatistic(Math.max(0, (baselineScore - currentScore) / baselineScore)) : null;
  const hardTradeFloor = baselineTradeCount > 0 ? Math.max(3, Math.floor(baselineTradeCount * 0.10)) : 0;
  const softTradeFloor = Math.floor(baselineTradeCount * (1 / 3));
  const objectiveSoftFloor = drawdownObjectives.has(objective) ? -0.30 : 0;
  const hardDrought = tradeCount < hardTradeFloor;
  const exceedsRetirement = degradationFraction !== null && degradationFraction > retireFraction;
  const reasons: TspStrategyGuardianReason[] = [];
  if (incompleteData) reasons.push("incomplete-segments");
  if (exceedsRetirement) reasons.push("retirement-degradation");
  else if (degradationFraction !== null && degradationFraction > watchFraction) reasons.push("watch-degradation");
  if (hardDrought) reasons.push("hard-trade-drought");
  else {
    if (currentScore < objectiveSoftFloor) reasons.push("objective-soft-floor");
    if (worstDrawdownFraction !== null && worstDrawdownFraction < maxSoftDrawdownFraction) reasons.push("drawdown-soft-floor");
    if (tradeCount < softTradeFloor) reasons.push("soft-trade-drought");
  }
  const status = !reasons.length ? "healthy" : !incompleteData && (hardDrought || exceedsRetirement) ? "retired" : "watch";
  return { ...basis, plan, evidence, status, reasons, degradationFraction, objectiveSoftFloor, hardTradeFloor, softTradeFloor };
}

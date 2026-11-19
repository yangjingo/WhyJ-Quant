import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_MARKET_REGIME_FORMULA_VERSION = 1;

export interface TspRegimeMetrics {
  upFraction: number;
  averageFraction: number;
  medianFraction: number;
  strongDifferenceFraction: number;
  limitUpCount: number;
  sealFraction: number;
  maxStreak: number;
  strongDownFraction: number;
  indexChangeFraction: number;
  aboveMa20Fraction: number;
}

const labels = { strong: "强势", lean_strong: "偏强", range: "震荡", lean_weak: "偏弱", weak: "弱势" } as const;
export type TspMarketState = keyof typeof labels;
type MetricKey = keyof TspRegimeMetrics;
type Offset = { low: number; high: number; scale: number; fallback: number; zeroFallback?: true };
type MetricEvidence = { observed: number | null; normalizationInput: number | null;
  basis: "observed" | "missing-default" | "zero-fallback" | "non-finite-neutral" };

const bounds: Record<MetricKey, Offset> = {
  upFraction: { low: 21, high: 75, scale: 100, fallback: 0.5 },
  averageFraction: { low: -1.2, high: 1.3, scale: 100, fallback: 0 },
  medianFraction: { low: -1.2, high: 1.3, scale: 100, fallback: 0 },
  strongDifferenceFraction: { low: -13, high: 14, scale: 100, fallback: 0 },
  limitUpCount: { low: 35, high: 97, scale: 1, fallback: 0 },
  sealFraction: { low: 57, high: 75, scale: 100, fallback: 0.5, zeroFallback: true },
  maxStreak: { low: 4, high: 9, scale: 1, fallback: 0 },
  strongDownFraction: { low: 2, high: 18, scale: 100, fallback: 0 },
  indexChangeFraction: { low: -2.5, high: 2.5, scale: 100, fallback: 0 },
  aboveMa20Fraction: { low: 22, high: 76, scale: 100, fallback: 0.5, zeroFallback: true },
};

function roundHalfEven(value: number) {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}

function validateMetric(key: MetricKey, value: number) {
  if (typeof value !== "number") throw new Error(`Invalid market regime metric: ${key}`);
  if (!Number.isFinite(value)) return;
  const fraction = key === "upFraction" || key === "sealFraction" || key === "strongDownFraction" || key === "aboveMa20Fraction";
  const count = key === "limitUpCount" || key === "maxStreak";
  if ((fraction && (value < 0 || value > 1)) || (count && (!Number.isSafeInteger(value) || value < 0)) ||
    (!fraction && !count && value < -1) || (key === "strongDifferenceFraction" && value > 1)) {
    throw new Error(`Invalid market regime metric: ${key}`);
  }
}

function stateFor(score: number): TspMarketState {
  if (score >= 70) return "strong";
  if (score >= 55) return "lean_strong";
  if (score >= 45) return "range";
  if (score >= 30) return "lean_weak";
  return "weak";
}

/** Estimate the pinned four-dimensional state for one explicit market date. */
export function computeTspMarketRegime(tradingDate: string, metrics: Partial<{ [K in MetricKey]: number | null }>) {
  if (typeof tradingDate !== "string" || !isDailyDate(tradingDate)) throw new Error("Invalid market regime date");
  const evidence: Partial<Record<MetricKey, MetricEvidence>> = {};
  let observed = 0;
  const term = (key: MetricKey) => {
    const { low, high, scale, fallback, zeroFallback } = bounds[key];
    const raw = metrics[key] ?? null;
    if (raw !== null) validateMetric(key, raw);
    if (raw !== null && !Number.isFinite(raw * scale)) {
      evidence[key] = { observed: null, normalizationInput: null, basis: "non-finite-neutral" };
      return 50;
    }
    if (raw !== null) observed++;
    const substitutedZero = raw === 0 && zeroFallback;
    const normalizationInput = (substitutedZero ? fallback : raw ?? fallback) * scale;
    evidence[key] = { observed: raw, normalizationInput, basis: raw === null ? "missing-default" : substitutedZero ? "zero-fallback" : "observed" };
    return roundHalfEven(Math.max(0, Math.min(100, (normalizationInput - low) / (high - low) * 100)));
  };

  const profit = term("upFraction") * 0.45 + term("averageFraction") * 0.25 + term("medianFraction") * 0.20 + term("strongDifferenceFraction") * 0.10;
  const speculation = term("limitUpCount") * 0.30 + term("sealFraction") * 0.40 + term("maxStreak") * 0.30;
  const resilience = 100 - term("strongDownFraction");
  const trend = term("indexChangeFraction") * 0.50 + term("aboveMa20Fraction") * 0.50;
  const rawScore = observed === 0 ? null : Math.max(0, Math.min(100, profit * 0.35 + speculation * 0.25 + resilience * 0.20 + trend * 0.20));
  const score = rawScore === null ? null : roundHalfEven(rawScore);
  const state = score === null ? null : stateFor(score);
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_market_regime" as const, version: TSP_MARKET_REGIME_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, score, rawScore, state, label: state === null ? null : labels[state],
    dimensions: state === null ? null : { profit, speculation, resilience, trend },
    input: { availability: observed === 0 ? "unavailable" as const : observed === Object.keys(bounds).length ? "complete" as const : "partial" as const,
      observed, evidence },
  };
}

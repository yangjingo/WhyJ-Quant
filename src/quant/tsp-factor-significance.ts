import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, mean, sampleDeviation } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_FACTOR_SIGNIFICANCE_FORMULA_VERSION = "tsp-factor-significance-v1";

export interface TspFactorSignificanceInput {
  /** Bartlett lag measured in retained IC observations. The pinned daily batch uses 1. */
  lag: number;
  factors: readonly {
    factorId: string;
    series: readonly { tradeDate: string; ic: number | null }[];
  }[];
}

function normalTwoSidedProbability(t: number): number {
  const x = Math.abs(t) / Math.SQRT2;
  const z = x * x;
  if (x < 1) {
    // DLMF 7.6.1 gives erf(x) by power series.
    let term = x;
    let sum = term;
    for (let n = 1; n <= 20; n++) {
      term *= -z / n;
      sum += term / (2 * n + 1);
    }
    return 1 - 2 * sum / Math.sqrt(Math.PI);
  }
  // DLMF 8.9.2 at a = 1/2 gives erfc(x) directly, avoiding subtraction in the tail.
  let denominator = 1;
  for (let n = 256; n >= 1; n--) denominator = 1 + (n / 2 / z) / denominator;
  return Math.exp(-z - Math.log(x) - Math.log(Math.PI) / 2 - Math.log(denominator));
}

function neweyWestError(values: number[], average: number, lag: number): number | null {
  const count = values.length;
  if (count <= lag + 2) return null;
  const centered = values.map(value => value - average);
  const scale = centered.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (scale === 0) return null;
  const centeredScaled = centered.map(value => value / scale);
  let variance = mean(centeredScaled.map(value => value * value));
  for (let offset = 1; offset <= lag; offset++) {
    let covarianceSum = 0;
    for (let i = offset; i < count; i++) covarianceSum += centeredScaled[i]! * centeredScaled[i - offset]!;
    variance += 2 * (1 - offset / (lag + 1)) * (covarianceSum / count);
  }
  const standardError = scale * Math.sqrt(Math.max(variance, 0) / count);
  return standardError === 0 ? null : standardError;
}

export function computeTspFactorSignificance(input: TspFactorSignificanceInput) {
  const { factors, lag } = input;
  if (!Number.isSafeInteger(lag) || lag < 0 || !Array.isArray(factors)) throw new Error("Invalid factor test family");
  const seen = new Set<string>();
  const results = factors.map((factor: TspFactorSignificanceInput["factors"][number]) => {
    if (!factor || typeof factor.factorId !== "string" || !factor.factorId.trim() || seen.has(factor.factorId) ||
      !Array.isArray(factor.series)) throw new Error("Invalid or duplicate factor identity");
    seen.add(factor.factorId);
    const values: number[] = [];
    let previousDate = "";
    for (const row of factor.series) {
      if (!row || typeof row.tradeDate !== "string" || !isDailyDate(row.tradeDate) || row.tradeDate <= previousDate ||
        (row.ic !== null && (!Number.isFinite(row.ic) || Math.abs(row.ic) > 1))) {
        throw new Error("Invalid or unordered IC observation");
      }
      if (row.ic !== null) values.push(row.ic);
      previousDate = row.tradeDate;
    }
    const average = values.length ? mean(values) : null;
    const deviation = values.length >= 3 ? sampleDeviation(values) : 0;
    const ordinaryT = average !== null && deviation > 0 ? finiteStatistic(average / deviation * Math.sqrt(values.length)) : null;
    const neweyWestStandardError = average === null ? null : neweyWestError(values, average, lag);
    const neweyWestT = average !== null && neweyWestStandardError !== null ? finiteStatistic(average / neweyWestStandardError) : null;
    const statistic = neweyWestT ?? ordinaryT;
    return {
      factorId: factor.factorId,
      observedSamples: values.length,
      missingSamples: factor.series.length - values.length,
      icMean: average,
      ordinaryT,
      neweyWestT,
      neweyWestStandardError,
      pBasis: neweyWestT !== null ? "newey-west" as const : ordinaryT !== null ? "ordinary-t" as const : null,
      pValue: statistic === null ? null : normalTwoSidedProbability(statistic),
      qValue: null as number | null,
    };
  });
  const tested = results.filter(row => row.pValue !== null).sort((left, right) => left.pValue! - right.pValue!);
  let runningMin = 1;
  for (let i = tested.length - 1; i >= 0; i--) {
    const row = tested[i]!;
    runningMin = Math.min(runningMin, row.pValue! * tested.length / (i + 1));
    row.qValue = runningMin;
  }
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_FACTOR_SIGNIFICANCE_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    lag,
    testedFactorCount: tested.length,
    results,
  };
}

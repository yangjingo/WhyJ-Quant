import { isDailyDate } from "../market/bars.ts";
import { mean, rootMeanSquare, roundDecimalTiesToEven } from "./statistics.ts";
import { averageTspFactorRanks, correlateTspFactorRanks } from "./tsp-factor-information.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_FACTOR_MINING_SCREEN_FORMULA_VERSION = 1;
export const TSP_MINING_MAX_FACTORS = 48;

export interface TspFactorMiningRow {
  tradeDate: string;
  symbol: string;
  /** Observations in factorIds order. Explicit null marks an unavailable value. */
  values: readonly (number | null)[];
  forwardReturnFraction: number | null;
}

export interface TspFactorMiningScreenInput {
  factorIds: readonly string[];
  rows: readonly TspFactorMiningRow[];
  correlationThreshold: number;
}

interface HoldingsChanges {
  previous: Set<string> | null;
  sum: number;
  observations: number;
}

function recordHoldings(state: HoldingsChanges, current: Set<string>) {
  if (!current.size) return;
  const { previous } = state;
  if (previous) {
    let common = 0;
    for (const symbol of current) if (previous.has(symbol)) common++;
    state.sum += 1 - common / Math.max(previous.size, current.size);
    state.observations++;
  }
  state.previous = current;
}

function qualityState() {
  const holdings = (): HoldingsChanges => ({ previous: null, sum: 0, observations: 0 });
  return { observed: 0, eligible: 0, dailyIc: [] as number[], top: holdings(), bottom: holdings() };
}

const round = (value: number) => roundDecimalTiesToEven(value, 8);
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function rankCorrelation(left: number[], right: number[]): number | null {
  if (left.length < 2) return null;
  const rho = correlateTspFactorRanks(averageTspFactorRanks(left), averageTspFactorRanks(right));
  // Normalization can leave a perfect rank match a few floating point units below one.
  return rho !== null && 1 - Math.abs(rho) <= 4 * Number.EPSILON ? Math.sign(rho) : rho;
}

export function computeTspFactorMiningScreen(input: TspFactorMiningScreenInput) {
  const { factorIds, rows, correlationThreshold } = input;
  if (!Array.isArray(input.factorIds) || !factorIds.length || factorIds.length > TSP_MINING_MAX_FACTORS ||
    Array.from(factorIds).some(id => typeof id !== "string" || !id.trim()) ||
    new Set(factorIds).size !== factorIds.length || !Array.isArray(input.rows) || !rows.length ||
    !Number.isFinite(correlationThreshold) || correlationThreshold <= 0 || correlationThreshold > 1) {
    throw new Error("Invalid factor mining screen scope");
  }
  const groups = new Map<string, Map<string, TspFactorMiningRow>>();
  for (const row of rows) {
    if (!row || typeof row.tradeDate !== "string" || !isDailyDate(row.tradeDate) || typeof row.symbol !== "string" || !row.symbol.trim() ||
      !Array.isArray(row.values) || row.values.length !== factorIds.length || Array.from(row.values).some(value => value !== null && !Number.isFinite(value)) ||
      (row.forwardReturnFraction !== null && (!Number.isFinite(row.forwardReturnFraction) || row.forwardReturnFraction < -1))) {
      throw new Error("Invalid factor mining panel row");
    }
    const day = groups.get(row.tradeDate) ?? new Map<string, TspFactorMiningRow>();
    if (day.has(row.symbol)) throw new Error("Duplicate factor mining panel row");
    day.set(row.symbol, row);
    groups.set(row.tradeDate, day);
  }

  const sessions = [...groups.keys()].sort();
  const factors = factorIds.map(qualityState);
  const pairCounts = factorIds.map(() => factorIds.map(() => 0));
  const sums = factorIds.map(() => factorIds.map(() => 0));
  for (const date of sessions) {
    const day = [...groups.get(date)!.values()].sort((left, right) => lexical(left.symbol, right.symbol));
    for (let factor = 0; factor < factorIds.length; factor++) {
      const evidence = factors[factor]!;
      const eligible: TspFactorMiningRow[] = [];
      let observed = 0;
      for (const row of day) {
        if (row.values[factor] === null) continue;
        observed++;
        if (row.forwardReturnFraction !== null) eligible.push(row);
      }
      evidence.observed += observed;
      evidence.eligible += eligible.length;
      if (observed >= 2) pairCounts[factor]![factor]!++;
      if (eligible.length) {
        const ranks = averageTspFactorRanks(eligible.map(row => row.values[factor]!));
        const ic = correlateTspFactorRanks(ranks, averageTspFactorRanks(eligible.map(row => row.forwardReturnFraction!)));
        if (ic !== null) evidence.dailyIc.push(ic);
        const top = new Set<string>(), bottom = new Set<string>();
        eligible.forEach(({ symbol }, index) => {
          if (ranks[index]! > eligible.length * 0.8) top.add(symbol);
          if (ranks[index]! <= eligible.length * 0.2) bottom.add(symbol);
        });
        recordHoldings(evidence.top, top);
        recordHoldings(evidence.bottom, bottom);
      }

      for (let other = factor + 1; other < factorIds.length; other++) {
        const left: number[] = [], right: number[] = [];
        for (const row of day) {
          const x = row.values[factor]!, y = row.values[other]!;
          if (x === null || y === null) continue;
          left.push(x);
          right.push(y);
        }
        const rho = rankCorrelation(left, right);
        if (rho === null) continue;
        pairCounts[factor]![other]!++;
        pairCounts[other]![factor]!++;
        sums[factor]![other]! += rho;
        sums[other]![factor]! += rho;
      }
    }
  }
  const matrix = pairCounts.map((row, i) => row.map((count, j) => count ? i === j ? 1 : sums[i]![j]! / count : null));
  const metrics = factors.map(({ observed, eligible, dailyIc, top, bottom }, i) => {
    const rankIc = dailyIc.length ? mean(dailyIc) : 0;
    const deviation = dailyIc.length ? rootMeanSquare(dailyIc.map(ic => ic - rankIc)) : 0;
    const ir = deviation > 1e-12 ? Math.abs(rankIc) / deviation : 0;
    const coverage = observed / rows.length;
    const holdings = rankIc >= 0 ? top : bottom;
    const turnover = !eligible ? 1 : holdings.observations ? holdings.sum / holdings.observations : 0;
    return { factorId: factorIds[i]!, compositeScore: round(ir * coverage / (1 + turnover)), ir: round(ir),
      coverage: round(coverage), turnover: round(turnover), rankIc: round(rankIc),
      observedFactorRows: observed, eligibleRows: eligible, observedIcDays: dailyIc.length };
  });

  const ordered = metrics.map((metric, index) => ({ ...metric, index })).sort((left, right) =>
    right.compositeScore - left.compositeScore || right.ir - left.ir || right.coverage - left.coverage ||
    left.turnover - right.turnover || lexical(left.factorId, right.factorId));
  const representatives: typeof ordered = [];
  const excluded: { factorId: string; reason: "correlation_threshold"; representative: string; rho: number }[] = [];
  for (const candidate of ordered) {
    let closest: { factorId: string; rho: number } | null = null;
    for (const representative of representatives) {
      const rho = matrix[candidate.index]![representative.index]!;
      if (rho !== null && Math.abs(rho) >= correlationThreshold && (!closest || Math.abs(rho) > Math.abs(closest.rho))) {
        closest = { factorId: representative.factorId, rho };
      }
    }
    if (closest) excluded.push({ factorId: candidate.factorId, reason: "correlation_threshold", representative: closest.factorId, rho: round(closest.rho) });
    else representatives.push(candidate);
  }

  return {
    producer: "whyj" as const,
    formula: { id: "tsp_factor_mining_screen" as const, version: TSP_FACTOR_MINING_SCREEN_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    sessions, inputRows: rows.length, factorIds: [...factorIds], metrics,
    correlation: { threshold: correlationThreshold, matrix, pairCounts },
    selected: representatives.map(row => row.factorId), excluded,
  };
}

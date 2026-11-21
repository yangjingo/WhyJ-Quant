import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, mean, sampleDeviation, standardScores } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspMarketState } from "./tsp-market-regime.ts";

export const TSP_FACTOR_INFORMATION_FORMULA_VERSION = "tsp-factor-v2-information-v1";
export const TSP_FACTOR_REGIME_FORMULA_VERSION = "tsp-factor-v2-regime-v1";

export interface TspFactorInformationRow {
  symbol: string;
  tradeDate: string;
  close: number | null;
  factor: number | null;
}

export interface TspFactorInformationInput {
  factorId: string;
  rebalance: "daily" | "weekly" | "monthly";
  /** Complete exchange date axis for the requested sample window. */
  sessions: readonly string[];
  rows: readonly TspFactorInformationRow[];
}

export interface TspFactorRegimeObservation {
  tradeDate: string;
  state: TspMarketState;
  score: number;
}

export interface TspFactorRegimeInput {
  /** Exact adjacent exchange session before the evaluation window, when known. */
  precedingSession?: string;
  observations: readonly TspFactorRegimeObservation[];
}

const regimeBuckets = { strong: "strong", lean_strong: "strong", range: "range", lean_weak: "weak", weak: "weak" } as const;
const regimeOrder = ["strong", "range", "weak"] as const;

const horizons = [1, 3, 5] as const;
type DatedFactor = { symbol: string; close: number; factor: number };
type PriceRows = Map<string, TspFactorInformationRow>;

export function roundTspFactorStatistic(value: number, digits: 2 | 4 = 4): number {
  finiteStatistic(value);
  const decimalScale = 10 ** digits;
  const scaled = value * decimalScale;
  // Binary-representable halfway cases retain the factor of two in the decimal denominator.
  const floor = Math.floor(scaled);
  if (Number.isInteger(value * 2 ** (digits + 1)) && scaled - floor === 0.5) {
    return (floor + Math.abs(floor % 2)) / decimalScale;
  }
  return Number(value.toFixed(digits)) || 0;
}

export function averageTspFactorRanks(values: number[]): number[] {
  const byValue = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);
  for (let first = 0; first < byValue.length;) {
    let end = first + 1;
    while (end < byValue.length && byValue[end]!.value === byValue[first]!.value) end++;
    const rank = (first + 1 + end) / 2;
    for (let cursor = first; cursor < end; cursor++) ranks[byValue[cursor]!.index] = rank;
    first = end;
  }
  return ranks;
}

function correlation(factorRanks: number[], returnRanks: number[]): number | null {
  if (factorRanks.length < 2) return null;
  const factors = standardScores(factorRanks);
  const returns = standardScores(returnRanks);
  if (!factors.some(value => value !== 0) || !returns.some(value => value !== 0)) return null;
  const product = factors.map((value, i) => value * returns[i]!);
  const ic = mean(product) * (product.length / (product.length - 1));
  return Math.max(-1, Math.min(1, ic));
}

export function tspFactorForwardReturn(row: DatedFactor, target: PriceRows): number | null {
  const endClose = target.get(row.symbol)?.close;
  if (endClose == null) return null;
  const outcome = endClose / row.close - 1;
  if (!Number.isFinite(outcome)) throw new Error("Factor forward return exceeds the supported numeric range");
  return outcome;
}

function rankIc(rows: DatedFactor[], target?: PriceRows, fullFactorRanks?: number[]) {
  if (!target) return { ic: null, pairCount: 0 };
  const signals: number[] = [];
  const outcomes: number[] = [];
  rows.forEach((row, index) => {
    const outcome = tspFactorForwardReturn(row, target);
    if (outcome === null) return;
    signals.push(fullFactorRanks ? fullFactorRanks[index]! : row.factor);
    outcomes.push(outcome);
  });
  const factorRanks = fullFactorRanks ? signals : averageTspFactorRanks(signals);
  return { ic: correlation(factorRanks, averageTspFactorRanks(outcomes)), pairCount: outcomes.length };
}

function periodKey(date: string, rebalance: "weekly" | "monthly"): string {
  if (rebalance === "monthly") return date.slice(0, 7);
  const anchor = new Date(date + "T00:00:00Z");
  const daysSinceMonday = (anchor.getUTCDay() + 6) % 7;
  anchor.setUTCDate(anchor.getUTCDate() - daysSinceMonday);
  return anchor.toISOString();
}

function rebalanceTargets(sessions: readonly string[], prices: PriceRows[], rebalance: TspFactorInformationInput["rebalance"]) {
  const targets = new Map<number, number>();
  if (rebalance === "daily") {
    for (let index = 1; index < sessions.length; index++) targets.set(index - 1, index);
    return targets;
  }
  let previous: { key: string; index: number } | undefined;
  sessions.forEach((date, index) => {
    if (![...prices[index]!.values()].some(row => row.close !== null)) return;
    const key = periodKey(date, rebalance);
    if (key === previous?.key) return;
    if (previous) targets.set(previous.index, index);
    previous = { key, index };
  });
  return targets;
}

function summary(values: number[]) {
  if (!values.length) return { icMean: null, icStd: null, ir: null, winRate: null, nDates: 0 };
  const average = mean(values);
  const std = sampleDeviation(values) * Math.sqrt((values.length - 1) / values.length);
  return {
    icMean: roundTspFactorStatistic(average),
    icStd: roundTspFactorStatistic(std),
    ir: std > 1e-8 ? roundTspFactorStatistic(average / std) : null,
    winRate: roundTspFactorStatistic(values.filter(ic => ic > 0).length / values.length),
    nDates: values.length,
  };
}

export function prepareTspFactorPanel(input: TspFactorInformationInput) {
  const { factorId, rebalance, sessions, rows } = input;
  if (typeof factorId !== "string" || !factorId.trim() || !["daily", "weekly", "monthly"].includes(rebalance) ||
    !Array.isArray(sessions) || !sessions.length || sessions.some((date, index) =>
      typeof date !== "string" || !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!)) || !Array.isArray(rows)) {
    throw new Error("Invalid factor-information scope");
  }
  const indexByDate = new Map(sessions.map((date, index) => [date, index]));
  const panel = sessions.map((): PriceRows => new Map());
  for (const row of rows) {
    const dateIndex = row && indexByDate.get(row.tradeDate);
    if (typeof dateIndex !== "number" || typeof row.symbol !== "string" || !row.symbol.trim() || row.symbol !== row.symbol.trim() ||
      (row.close !== null && (!Number.isFinite(row.close) || row.close <= 0)) ||
      (row.factor !== null && !Number.isFinite(row.factor)) || panel[dateIndex]!.has(row.symbol)) {
      throw new Error("Invalid or duplicate factor-information row");
    }
    panel[dateIndex]!.set(row.symbol, row);
  }

  return { panel, targets: rebalanceTargets(sessions, panel, rebalance) };
}

export function tspFactorCrossSection(daily: PriceRows) {
  const factors: DatedFactor[] = [];
  let priceRows = 0;
  for (const { symbol, close, factor } of daily.values()) {
    if (close === null) continue;
    priceRows++;
    if (factor !== null) factors.push({ symbol, close, factor });
  }
  factors.sort((left, right) => left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0);
  return { factors, priceRows };
}

function alignFactorRegimes(sessions: readonly string[], input: TspFactorRegimeInput) {
  const { observations, precedingSession } = input;
  if (!Array.isArray(observations) || (precedingSession !== undefined &&
    (typeof precedingSession !== "string" || !isDailyDate(precedingSession) || precedingSession >= sessions[0]!))) {
    throw new Error("Invalid factor regime scope");
  }
  const scope = new Set(sessions);
  if (precedingSession !== undefined) scope.add(precedingSession);
  const byDate = new Map<string, TspFactorRegimeObservation>();
  for (const row of observations) {
    if (!row || !scope.has(row.tradeDate) || byDate.has(row.tradeDate) ||
      !Object.hasOwn(regimeBuckets, row.state) || !Number.isFinite(row.score) || row.score < 0 || row.score > 100) {
      throw new Error("Invalid or duplicate factor regime observation");
    }
    byDate.set(row.tradeDate, row);
  }
  return sessions.map((tradeDate, index) => {
    const previousTradeDate = sessions[index - 1] ?? precedingSession;
    if (previousTradeDate === undefined) return null;
    const point = byDate.get(previousTradeDate);
    if (!point) throw new Error("Missing previous-session factor regime " + previousTradeDate);
    return { tradeDate, previousTradeDate, state: regimeBuckets[point.state], score: point.score };
  });
}

function summarizeFactorRegimes(
  aligned: ReturnType<typeof alignFactorRegimes>, pricedDates: ReadonlySet<string>, icByDate: ReadonlyMap<string, number>,
  firstDate: string,
) {
  const assignments = aligned.flatMap(point => point && pricedDates.has(point.tradeDate) ? [point] : []);
  return {
    formulaVersion: TSP_FACTOR_REGIME_FORMULA_VERSION,
    unclassifiedAtStart: aligned[0] === null && pricedDates.has(firstDate) ? firstDate : null,
    assignments,
    buckets: regimeOrder.flatMap(state => {
      const points = assignments.filter(point => point.state === state);
      if (!points.length) return [];
      const values = points.flatMap(({ tradeDate }) => {
        const ic = icByDate.get(tradeDate);
        return ic === undefined ? [] : [ic];
      });
      const { icMean, ir, winRate, nDates: nIcDates } = summary(values);
      return [{ state, icMean, ir, winRate, meanScore: roundTspFactorStatistic(mean(points.map(point => point.score)), 2),
        nDates: points.length, nIcDates }];
    }),
  };
}

export function computeTspFactorInformation(input: TspFactorInformationInput, regimeInput?: TspFactorRegimeInput) {
  const { panel, targets } = prepareTspFactorPanel(input);
  const { factorId, rebalance, sessions } = input;
  const regime = regimeInput && {
    aligned: alignFactorRegimes(sessions, regimeInput),
    pricedDates: new Set<string>(),
    icByDate: new Map<string, number>(),
  };
  const yearly = new Map<number, number[]>();
  const decay = horizons.map(horizon => ({ horizon, values: [] as number[] }));
  const series: { tradeDate: string; outcomeDate: string; pairCount: number; ic: number }[] = [];
  const allValues: number[] = [];
  const symbols = new Set<string>();
  let priceRows = 0, factorRows = 0, factorDates = 0;

  panel.forEach((daily, index) => {
    const { factors: available, priceRows: priced } = tspFactorCrossSection(daily);
    priceRows += priced;
    const tradeDate = sessions[index]!;
    if (priced) regime?.pricedDates.add(tradeDate);
    if (!available.length) return;
    for (const row of available) symbols.add(row.symbol);
    factorRows += available.length;
    factorDates++;
    const target = targets.get(index);
    if (target !== undefined) {
      const { ic, pairCount } = rankIc(available, panel[target]);
      if (ic !== null) {
        series.push({ tradeDate, outcomeDate: sessions[target]!, pairCount, ic: roundTspFactorStatistic(ic) });
        allValues.push(ic);
        regime?.icByDate.set(tradeDate, ic);
        const year = Number(tradeDate.slice(0, 4));
        if (!yearly.has(year)) yearly.set(year, []);
        yearly.get(year)!.push(ic);
      }
    }
    const ranks = averageTspFactorRanks(available.map(row => row.factor));
    for (const { horizon, values } of decay) {
      // TSP ranks the full finite-factor cross-section before excluding absent horizon returns.
      const { ic } = rankIc(available, panel[index + horizon], ranks);
      if (ic !== null) values.push(ic);
    }
  });

  return {
    producer: "whyj" as const,
    formulaVersion: TSP_FACTOR_INFORMATION_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    factorId, rebalance,
    start: sessions[0]!,
    end: sessions.at(-1)!,
    coverage: priceRows ? roundTspFactorStatistic(factorRows / priceRows) : null,
    priceRows, factorRows, factorDates, symbolCount: symbols.size,
    summary: summary(allValues),
    ...(regime && { marketRegime: summarizeFactorRegimes(regime.aligned, regime.pricedDates, regime.icByDate, sessions[0]!) }),
    series,
    yearly: [...yearly].map(([year, values]) => ({ year, ...summary(values) })),
    decay: decay.map(({ horizon, values }) => ({
      horizon, icMean: values.length ? roundTspFactorStatistic(mean(values)) : null, nDates: values.length,
    })),
  };
}

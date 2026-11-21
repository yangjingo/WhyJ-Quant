import { isDailyDate } from "../market/bars.ts";
import { mean, sampleDeviation, standardScores } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_FACTOR_INFORMATION_FORMULA_VERSION = "tsp-factor-v2-information-v1";

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

const horizons = [1, 3, 5] as const;
type DatedFactor = { symbol: string; close: number; factor: number };
type PriceRows = Map<string, TspFactorInformationRow>;

function rounded(value: number): number {
  const scaled = value * 10_000;
  // Exact binary halfway cases at four decimal places are odd multiples of 1/32.
  const floor = Math.floor(scaled);
  if (Number.isInteger(value * 32) && scaled - floor === 0.5) {
    return (floor + Math.abs(floor % 2)) / 10_000;
  }
  return Number(value.toFixed(4)) || 0;
}

function averageRanks(values: number[]): number[] {
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

function rankIc(rows: DatedFactor[], target?: PriceRows, fullFactorRanks?: number[]) {
  if (!target) return { ic: null, pairCount: 0 };
  const signals: number[] = [];
  const outcomes: number[] = [];
  rows.forEach(({ symbol, close, factor }, index) => {
    const endClose = target.get(symbol)?.close;
    if (endClose == null) return;
    const outcome = endClose / close - 1;
    if (!Number.isFinite(outcome)) throw new Error("Factor forward return exceeds the supported numeric range");
    signals.push(fullFactorRanks ? fullFactorRanks[index]! : factor);
    outcomes.push(outcome);
  });
  const factorRanks = fullFactorRanks ? signals : averageRanks(signals);
  return { ic: correlation(factorRanks, averageRanks(outcomes)), pairCount: outcomes.length };
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
    icMean: rounded(average),
    icStd: rounded(std),
    ir: std > 1e-8 ? rounded(average / std) : null,
    winRate: rounded(values.filter(ic => ic > 0).length / values.length),
    nDates: values.length,
  };
}

export function computeTspFactorInformation(input: TspFactorInformationInput) {
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

  const targets = rebalanceTargets(sessions, panel, rebalance);
  const yearly = new Map<number, number[]>();
  const decay = horizons.map(horizon => ({ horizon, values: [] as number[] }));
  const series: { tradeDate: string; outcomeDate: string; pairCount: number; ic: number }[] = [];
  const allValues: number[] = [];
  const symbols = new Set<string>();
  let priceRows = 0, factorRows = 0, factorDates = 0;

  panel.forEach((daily, index) => {
    const available: DatedFactor[] = [];
    for (const { symbol, close, factor } of daily.values()) {
      if (close === null) continue;
      priceRows++;
      if (factor === null) continue;
      available.push({ symbol, close, factor });
      symbols.add(symbol);
    }
    if (!available.length) return;
    available.sort((left, right) => left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0);
    factorRows += available.length;
    factorDates++;
    const tradeDate = sessions[index]!;
    const target = targets.get(index);
    if (target !== undefined) {
      const { ic, pairCount } = rankIc(available, panel[target]);
      if (ic !== null) {
        series.push({ tradeDate, outcomeDate: sessions[target]!, pairCount, ic: rounded(ic) });
        allValues.push(ic);
        const year = Number(tradeDate.slice(0, 4));
        if (!yearly.has(year)) yearly.set(year, []);
        yearly.get(year)!.push(ic);
      }
    }
    const ranks = averageRanks(available.map(row => row.factor));
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
    coverage: priceRows ? rounded(factorRows / priceRows) : null,
    priceRows, factorRows, factorDates, symbolCount: symbols.size,
    summary: summary(allValues),
    series,
    yearly: [...yearly].map(([year, values]) => ({ year, ...summary(values) })),
    decay: decay.map(({ horizon, values }) => ({
      horizon, icMean: values.length ? rounded(mean(values)) : null, nDates: values.length,
    })),
  };
}

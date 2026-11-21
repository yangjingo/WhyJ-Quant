import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_SCREENER_SCORE_FORMULA_VERSION = 1;

export interface TspScreenerScoreInput {
  tradeDate: string;
  candidateRevision: string;
  strategy: { id: string; revision: string };
  candidateSymbols: readonly string[];
  columns: readonly { field: string; values: readonly (number | null)[] }[];
  weights: readonly { field: string; weight: number; direction?: "high" | "low" }[];
  orderBy?: string;
  descending?: boolean;
  displayLimit?: number | null;
}

const revisionPattern = /^[a-f0-9]{64}$/;
const symbolPattern = /^\d{6}\.(?:SH|SZ|BJ)$/;
const validField = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim();

/** Score one already-filtered candidate set using its frozen materialized columns. */
export function computeTspScreenerScores(input: TspScreenerScoreInput) {
  if (!input || typeof input !== "object" || !input.strategy || !validField(input.strategy.id) ||
    typeof input.strategy.revision !== "string" || !revisionPattern.test(input.strategy.revision) ||
    typeof input.candidateRevision !== "string" || !revisionPattern.test(input.candidateRevision) ||
    typeof input.tradeDate !== "string" || !isDailyDate(input.tradeDate) || input.tradeDate < "0001-01-01" ||
    !Array.isArray(input.candidateSymbols) || !Array.isArray(input.columns) || !Array.isArray(input.weights) ||
    (input.orderBy !== undefined && !validField(input.orderBy)) ||
    (input.descending !== undefined && typeof input.descending !== "boolean") ||
    (input.displayLimit != null && (!Number.isSafeInteger(input.displayLimit) || input.displayLimit < 0))) {
    throw new Error("Invalid TSP screener scope");
  }
  const { tradeDate, strategy, candidateRevision, candidateSymbols, columns, weights, orderBy } = input;
  const seenSymbols = new Set<string>();
  for (const symbol of candidateSymbols) {
    if (typeof symbol !== "string" || !symbolPattern.test(symbol) || seenSymbols.has(symbol)) {
      throw new Error("Invalid or duplicate TSP screener symbol");
    }
    seenSymbols.add(symbol);
  }

  const materialized = new Map<string, readonly (number | null)[]>();
  for (const column of columns) {
    if (!column || !validField(column.field) || column.field === "score" || materialized.has(column.field) ||
      !Array.isArray(column.values) || column.values.length !== candidateSymbols.length) {
      throw new Error("Invalid or duplicate TSP screener column");
    }
    for (const value of column.values) {
      if (value !== null && !Number.isFinite(value)) throw new Error("Invalid TSP screener value");
    }
    materialized.set(column.field, column.values);
  }

  const components: { field: string; weight: number; direction: "high" | "low"; values: readonly (number | null)[];
    lo: number | null; hi: number | null; range: number; observedCount: number }[] = [];
  const omittedFields: string[] = [];
  const seenWeights = new Set<string>();
  let totalWeight = 0;
  for (const entry of weights) {
    if (!entry || !validField(entry.field) || seenWeights.has(entry.field) ||
      !Number.isFinite(entry.weight) || entry.weight < 0 ||
      (entry.direction !== undefined && entry.direction !== "high" && entry.direction !== "low")) {
      throw new Error("Invalid or duplicate TSP screener weight");
    }
    const { field, weight, direction = "high" } = entry;
    seenWeights.add(field);
    if (weight === 0) continue;
    const values = materialized.get(field);
    if (!values) { omittedFields.push(field); continue; }
    let lo = Infinity, hi = -Infinity, observedCount = 0;
    for (const value of values) {
      if (value === null) continue;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
      observedCount++;
    }
    const range = observedCount === 0 ? 0 : hi - lo;
    totalWeight += weight;
    if (!Number.isFinite(range) || !Number.isFinite(totalWeight)) throw new Error("TSP screener normalization overflow");
    components.push({ field, weight, direction, values, lo: observedCount ? lo : null,
      hi: observedCount ? hi : null, range, observedCount });
  }

  const fallback = orderBy !== undefined && orderBy !== "score" ? materialized.get(orderBy) : undefined;
  const sortField = totalWeight > 0 ? "score" : fallback ? orderBy ?? null : null;
  const descending = input.descending ?? true;
  const rows = candidateSymbols.map((symbol, index) => {
    let score: number | null = totalWeight > 0 ? 0 : null;
    for (const { weight, direction, values, lo, range } of components) {
      const value = values[index] ?? null;
      if (score === null || (range > 0 && value === null)) { score = null; break; }
      const normalized = range > 0 ? (value! - lo!) / range : 0.5;
      score += (direction === "low" ? 1 - normalized : normalized) * (weight / totalWeight);
    }
    if (score !== null) score = Math.min(100, score * 100);
    const sortValue = sortField === "score" ? score : fallback?.[index] ?? null;
    return { symbol, score, sortValue, index };
  });
  if (sortField !== null) {
    rows.sort((a, b) => {
      if (a.sortValue === b.sortValue) return a.index - b.index;
      if (a.sortValue === null) return -1;
      if (b.sortValue === null) return 1;
      return descending ? b.sortValue - a.sortValue : a.sortValue - b.sortValue;
    });
  }
  const limit = input.displayLimit === undefined ? 100 : input.displayLimit || null;
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_screener_score" as const, version: TSP_SCREENER_SCORE_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradeDate, strategy: { id: strategy.id, revision: strategy.revision }, candidateRevision, candidateCount: candidateSymbols.length,
    scoring: { fields: components.map(({ field, weight, direction, lo, hi, observedCount }) =>
      ({ field, weight, direction, min: lo, max: hi, observedCount })), omittedFields },
    order: { field: sortField, descending, limit },
    selected: rows.slice(0, limit ?? rows.length).map(({ symbol, score, sortValue }, index) =>
      ({ symbol, score, sortValue, position: index + 1 })),
  };
}

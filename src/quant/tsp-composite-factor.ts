import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, standardScores } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_COMPOSITE_FACTOR_FORMULA_VERSION = "tsp-composite-factor-v1";

export interface TspCompositeFactorInput {
  members: readonly { factorId: string; weight: number }[];
  rows: readonly {
    tradeDate: string;
    symbol: string;
    values: Readonly<Record<string, number | null>>;
  }[];
}

export function computeTspCompositeFactor({ members, rows }: TspCompositeFactorInput) {
  if (!Array.isArray(members) || members.length < 2 || members.length > 8 || !Array.isArray(rows)) {
    throw new Error("Invalid composite factor evidence");
  }
  if (members.some(member => !member || typeof member.factorId !== "string" ||
    !/^[a-z][a-z0-9_]{0,47}$/.test(member.factorId) || !Number.isFinite(member.weight) || member.weight === 0) ||
    new Set(members.map(member => member.factorId)).size !== members.length) {
    throw new Error("Invalid or duplicate composite factor member");
  }

  type Row = TspCompositeFactorInput["rows"][number];
  const byDate = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    if (!row || typeof row.tradeDate !== "string" || !isDailyDate(row.tradeDate) ||
      typeof row.symbol !== "string" || !row.symbol || row.symbol.trim() !== row.symbol ||
      !row.values || typeof row.values !== "object" || Array.isArray(row.values) ||
      Object.keys(row.values).length !== members.length || members.some(({ factorId }) => {
        const value = row.values[factorId];
        return !Object.hasOwn(row.values, factorId) || (value !== null && !Number.isFinite(value));
      })) {
      throw new Error("Invalid composite factor row");
    }
    let daily = byDate.get(row.tradeDate);
    if (!daily) byDate.set(row.tradeDate, daily = new Map());
    if (daily.has(row.symbol)) throw new Error("Duplicate composite factor symbol and date");
    daily.set(row.symbol, row);
  }

  const results = [...byDate.keys()].sort().flatMap(tradeDate => {
    const daily = byDate.get(tradeDate)!;
    const symbols = [...daily.keys()].sort();
    const standardized = members.map(({ factorId }) => {
      const present = symbols.flatMap(symbol => {
        const value = daily.get(symbol)!.values[factorId]!;
        return value === null ? [] : [{ symbol, value }];
      });
      if (present.length < 2) return new Map<string, number>();
      const scores = standardScores(present.map(({ value }) => value));
      if (!scores.some(value => value !== 0)) return new Map<string, number>();
      return new Map(present.map(({ symbol }, i) => [symbol, scores[i]!]));
    });
    return symbols.map(symbol => {
      const componentScores = standardized.map(scores => scores.get(symbol));
      const score = componentScores.every(value => value !== undefined)
        ? finiteStatistic(members.reduce((sum, { weight }, i) => sum + weight * componentScores[i]!, 0))
        : null;
      return { tradeDate, symbol, score };
    });
  });

  return {
    producer: "whyj" as const,
    formulaVersion: TSP_COMPOSITE_FACTOR_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    members: members.map(({ factorId, weight }) => ({ factorId, weight })),
    rows: results,
  };
}

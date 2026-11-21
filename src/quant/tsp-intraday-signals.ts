import { isDailyDate } from "../market/bars.ts";
import { tspMinuteIndex, type TspIntradayRow, type TspIntradayValues } from "./tsp-intraday.ts";

export const TSP_INTRADAY_SIGNAL_FORMULA_VERSION = 1;

const features = [
  "price", "vwap", "pct_vs_prev_close", "pct_from_open", "vol_ratio_1m_today", "vol_ratio_3m_today",
  "vol_ratio_5m_today", "day_high_dist", "day_low_dist", "open_30m_high_dist", "open_30m_low_dist",
] as const satisfies readonly (keyof TspIntradayValues)[];
const operators = [">", ">=", "<", "<=", "==", "!=", "cross_up", "cross_down"] as const;
type Feature = typeof features[number];
type Operator = typeof operators[number];

export interface TspIntradaySignalRule {
  id: string;
  minBars?: number;
  conditions: readonly { left: Feature; op: Operator; right: number | { field: Feature } }[];
}

function ruleRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid TSP minute signal definition");
  return value as Record<string, unknown>;
}

export function parseTspIntradaySignalRule(value: unknown): Required<TspIntradaySignalRule> {
  const { id, minBars = 0, conditions } = ruleRecord(value, ["id", "minBars", "conditions"]);
  if (typeof id !== "string" || !/^[a-z0-9_]{1,40}$/.test(id) || typeof minBars !== "number" ||
    !Number.isInteger(minBars) || minBars < 0 || minBars > 240 || !Array.isArray(conditions) || !conditions.length) {
    throw new Error("Invalid TSP minute signal rule");
  }
  return { id, minBars, conditions: conditions.map((value: unknown) => {
    const { left: field, op: operator, right: operand } = ruleRecord(value, ["left", "op", "right"]);
    const left = features.find(name => name === field);
    const op = operators.find(name => name === operator);
    if (!left || !op) throw new Error("Unknown TSP minute signal feature or operator");
    if (typeof operand === "number" && Number.isFinite(operand)) return { left, op, right: operand };
    const { field: rightField } = ruleRecord(operand, ["field"]);
    const right = features.find(name => name === rightField);
    if (!right) throw new Error("Unknown TSP minute signal operand");
    return { left, op, right: { field: right } };
  }) };
}

function numberAt(values: TspIntradayValues, field: Feature) {
  const value = values[field];
  if (value !== null && !Number.isFinite(value)) throw new Error("Invalid TSP minute feature value");
  return value;
}

function matches(condition: TspIntradaySignalRule["conditions"][number], values: TspIntradayValues, prior?: TspIntradayValues) {
  const { left, op, right } = condition;
  const a = numberAt(values, left), b = typeof right === "number" ? right : numberAt(values, right.field);
  if (a === null || b === null) return false;
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    case "cross_up":
    case "cross_down": {
      if (!prior) return false;
      const pa = numberAt(prior, left), pb = typeof right === "number" ? right : numberAt(prior, right.field);
      if (pa === null || pb === null) return false;
      return op === "cross_up" ? pa <= pb && a > b : pa >= pb && a < b;
    }
  }
}

/** Calculate one rule on a completed series for one symbol. An unobserved minute breaks edge continuity. */
export function computeTspIntradaySignal(rows: readonly TspIntradayRow[], rule: TspIntradaySignalRule) {
  const { conditions, minBars } = parseTspIntradaySignalRule(rule);
  let previous: TspIntradayRow | undefined;
  let previousIndex = -1, barsSeen = 0, previousMatch = false;
  return rows.map(row => {
    const index = tspMinuteIndex(row.minute);
    const newDay = previous?.tradingDate !== row.tradingDate;
    if (index < 0 || !isDailyDate(row.tradingDate) ||
      (previous && (row.tradingDate < previous.tradingDate || (!newDay && index <= previousIndex)))) {
      throw new Error("Invalid or unordered TSP minute signal rows");
    }
    const prior = !newDay && index === previousIndex + 1 ? previous?.values : undefined;
    barsSeen = newDay ? 1 : barsSeen + 1;
    const conditionMet = conditions.every(condition => matches(condition, row.values, prior));
    const triggered = prior !== undefined && conditionMet && !previousMatch && barsSeen >= minBars;
    previous = row;
    previousIndex = index;
    previousMatch = conditionMet;
    return { tradingDate: row.tradingDate, minute: row.minute, conditionMet, triggered };
  });
}

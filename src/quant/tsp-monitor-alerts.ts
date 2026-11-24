import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_MONITOR_ALERT_FORMULA_VERSION = 1;

const comparisons = {
  ">": (value: number, threshold: number) => value > threshold,
  ">=": (value: number, threshold: number) => value >= threshold,
  "<": (value: number, threshold: number) => value < threshold,
  "<=": (value: number, threshold: number) => value <= threshold,
  "==": (value: number, threshold: number) => value === threshold,
  "!=": (value: number, threshold: number) => value !== threshold,
};

export type TspMonitorCondition = { field: string } & (
  { op: "truth" } | { op: keyof typeof comparisons; value: number; unit: string }
);

export interface TspMonitorAlertRule {
  id: string;
  revision: string;
  type: "signal" | "price" | "market";
  assetType: "stock" | "etf" | "index";
  scope: { kind: "all" } | { kind: "symbols"; symbols: readonly string[] } |
    { kind: "watchlist_group"; membershipRevision: string; symbols: readonly string[] };
  conditions: readonly TspMonitorCondition[];
  logic: "and" | "or";
  cooldownMs: number;
  severity: "info" | "warn" | "critical";
}

export interface TspMonitorAlertCapture {
  revision: string;
  evaluatedAt: number;
  symbols: readonly string[];
  // Null represents an unavailable value within a captured column.
  columns: Readonly<Record<string, readonly (number | boolean | null)[]>>;
  units: Readonly<Record<string, string>>;
}

export interface TspMonitorAlertsInput {
  rule: TspMonitorAlertRule;
  captures: readonly TspMonitorAlertCapture[];
}

function validateSymbols(symbols: readonly string[]) {
  if (!Array.isArray(symbols) || new Set(symbols).size !== symbols.length ||
    symbols.some(symbol => typeof symbol !== "string" || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(symbol))) {
    throw new Error("Invalid or duplicate monitor symbol");
  }
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function evaluateCondition(condition: TspMonitorCondition, value: number | boolean | null | undefined) {
  if (condition.op === "truth") {
    if (value == null) return false;
    if (typeof value === "boolean") return value;
  } else {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return comparisons[condition.op](value, condition.value);
  }
  throw new Error(`Invalid monitor observation for ${condition.field}`);
}

export function computeTspMonitorAlerts({ rule, captures }: TspMonitorAlertsInput) {
  if (!rule || typeof rule.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(rule.id) || !hasText(rule.revision) ||
    !["signal", "price", "market"].includes(rule.type) || !["stock", "etf", "index"].includes(rule.assetType) ||
    (rule.assetType === "index" && rule.type === "market") || !["and", "or"].includes(rule.logic) ||
    !["info", "warn", "critical"].includes(rule.severity) || !Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 0 ||
    !Array.isArray(rule.conditions) || !rule.conditions.length || !Array.isArray(captures)) {
    throw new Error("Invalid monitor rule or captures");
  }
  const { scope } = rule;
  if (!scope || !["all", "symbols", "watchlist_group"].includes(scope.kind) ||
    (scope.kind === "watchlist_group" && (rule.assetType !== "stock" || !hasText(scope.membershipRevision)))) {
    throw new Error("Invalid monitor scope");
  }
  if (scope.kind !== "all") validateSymbols(scope.symbols);
  const members = scope.kind === "all" ? null : new Set(scope.symbols);
  for (const condition of rule.conditions) {
    if (!hasText(condition?.field) || (condition.op !== "truth" &&
      (!Object.hasOwn(comparisons, condition.op) || !Number.isFinite(condition.value) || !hasText(condition.unit)))) {
      throw new Error("Invalid monitor condition");
    }
  }
  const fields = [...new Set(rule.conditions.map((condition: TspMonitorCondition) => condition.field))];
  const revisions = new Set<string>();
  const lastFire = new Map<string, number>();
  let previousTime = 0;
  const evaluations = captures.map((capture: TspMonitorAlertCapture) => {
    if (!hasText(capture?.revision) || revisions.has(capture.revision) || !Number.isSafeInteger(capture.evaluatedAt) ||
      capture.evaluatedAt <= previousTime || !Number.isFinite(new Date(capture.evaluatedAt).getTime()) ||
      !capture.columns || typeof capture.columns !== "object" || Array.isArray(capture.columns) ||
      !capture.units || typeof capture.units !== "object" || Array.isArray(capture.units)) {
      throw new Error("Invalid, duplicate or unordered monitor capture");
    }
    validateSymbols(capture.symbols);
    revisions.add(capture.revision);
    previousTime = capture.evaluatedAt;
    const eligible = capture.symbols.map((symbol, index) => ({ symbol, index })).filter(({ symbol }) => !members || members.has(symbol));
    const missingFields = fields.filter(field => !Object.hasOwn(capture.columns, field));
    for (const field of fields) {
      if (!Object.hasOwn(capture.columns, field)) continue;
      const column = capture.columns[field];
      if (!Array.isArray(column) || column.length !== capture.symbols.length || Object.keys(column).length !== column.length) {
        throw new Error(`Invalid monitor column ${field}`);
      }
    }
    for (const condition of rule.conditions) {
      if (condition.op !== "truth" && Object.hasOwn(capture.columns, condition.field) &&
        (!Object.hasOwn(capture.units, condition.field) || capture.units[condition.field] !== condition.unit)) {
        throw new Error(`Incompatible monitor unit for ${condition.field}`);
      }
    }
    const events: { symbol: string; matchedConditions: number[]; signals: string[] }[] = [];
    let unavailableCount = missingFields.length ? eligible.length : 0;
    let suppressedCount = 0;
    for (const { symbol, index } of missingFields.length ? [] : eligible) {
      const outcomes = rule.conditions.map((condition: TspMonitorCondition) => evaluateCondition(condition, capture.columns[condition.field]?.[index]));
      const matched = rule.logic === "and" ? outcomes.every(outcome => outcome === true) : outcomes.includes(true);
      if (!matched) {
        if (outcomes.includes(null) && (rule.logic === "or" || !outcomes.includes(false))) unavailableCount++;
        continue;
      }
      const last = lastFire.get(symbol);
      if (last !== undefined && capture.evaluatedAt - last < rule.cooldownMs) {
        suppressedCount++;
        continue;
      }
      lastFire.set(symbol, capture.evaluatedAt);
      const matchedConditions = outcomes.flatMap((outcome, conditionIndex) => outcome === true ? [conditionIndex] : []);
      const signals = matchedConditions.flatMap(conditionIndex => {
        const condition = rule.conditions[conditionIndex]!;
        return condition.op === "truth" ? [condition.field] : [];
      });
      events.push({ symbol, matchedConditions, signals });
    }
    return { captureRevision: capture.revision, evaluatedAt: capture.evaluatedAt, eligibleCount: eligible.length, missingFields,
      unavailableCount, suppressedCount, events };
  });
  return {
    formulaVersion: TSP_MONITOR_ALERT_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    type: rule.type,
    assetType: rule.assetType,
    severity: rule.severity,
    membershipRevision: scope.kind === "watchlist_group" ? scope.membershipRevision : null,
    evaluations,
  };
}

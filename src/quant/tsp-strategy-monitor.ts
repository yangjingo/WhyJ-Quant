import { isDailyDate } from "../market/bars.ts";
import { isAIndexSymbol, isDatedEtfSymbol } from "../market/symbols.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_STRATEGY_MONITOR_FORMULA_VERSION = 1;
export const TSP_STRATEGY_MONITOR_EVENT_TYPES = ["buy_signal", "sell_signal", "pool_entry", "pool_exit"] as const;

type EventKind = typeof TSP_STRATEGY_MONITOR_EVENT_TYPES[number];

export interface TspStrategyMonitorRule {
  id: string;
  revision: string;
  strategyId: string;
  strategyRevision: string;
  assetType: "stock" | "etf";
  eventTypes: readonly EventKind[];
  cooldownMs: number;
  scoreMin?: number;
  scoreMax?: number;
}

export interface TspStrategyMonitorSignal {
  symbol: string;
  signals: readonly string[];
}

export type TspStrategyMonitorCapture = {
  revision: string;
  evaluatedAt: number;
  tradeDate: string;
} & ({ status: "unavailable" } | {
  status: "completed";
  rows: readonly { symbol: string; score: number | null }[];
  buySignals: readonly TspStrategyMonitorSignal[];
  sellSignals: readonly TspStrategyMonitorSignal[];
});

export interface TspStrategyMonitorInput {
  rule: TspStrategyMonitorRule;
  captures: readonly TspStrategyMonitorCapture[];
}

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const stockSymbol = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRule(rule: TspStrategyMonitorRule) {
  if (!rule || typeof rule.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(rule.id) ||
    !hasText(rule.revision) || !hasText(rule.strategyId) || !hasText(rule.strategyRevision) ||
    (rule.assetType !== "stock" && rule.assetType !== "etf") || !Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 0 ||
    (rule.scoreMin !== undefined && !Number.isFinite(rule.scoreMin)) || (rule.scoreMax !== undefined && !Number.isFinite(rule.scoreMax)) ||
    (rule.scoreMin !== undefined && rule.scoreMax !== undefined && rule.scoreMin > rule.scoreMax) ||
    !Array.isArray(rule.eventTypes) || !rule.eventTypes.length || new Set(rule.eventTypes).size !== rule.eventTypes.length ||
    [...rule.eventTypes].some(kind => !TSP_STRATEGY_MONITOR_EVENT_TYPES.includes(kind))) {
    throw new Error("Invalid strategy monitor rule");
  }
}

function bySymbol<T extends { symbol: string }>(rows: readonly T[], validSymbol: (symbol: string) => boolean) {
  if (!Array.isArray(rows)) throw new Error("Missing strategy monitor result rows");
  const result = new Map<string, T>();
  for (const row of rows as readonly T[]) {
    if (typeof row?.symbol !== "string" || !validSymbol(row.symbol) || result.has(row.symbol)) {
      throw new Error("Invalid or duplicate strategy monitor symbol");
    }
    result.set(row.symbol, row);
  }
  return result;
}

function signalMembers(rows: readonly TspStrategyMonitorSignal[], validSymbol: (symbol: string) => boolean) {
  return [...bySymbol(rows, validSymbol).values()].map(({ symbol, signals }) => {
    if (!Array.isArray(signals) || ![...signals].every(hasText) || new Set(signals).size !== signals.length) {
      throw new Error("Invalid or duplicate strategy monitor signal IDs");
    }
    return { symbol, signals: [...signals].sort() };
  });
}

function poolDifference(current: ReadonlySet<string>, previous: ReadonlySet<string>) {
  return [...current].filter(symbol => !previous.has(symbol)).map(symbol => ({ symbol, signals: [] }));
}

function freshSignals(members: readonly TspStrategyMonitorSignal[], seen: Set<string>) {
  return members.filter(member => {
    if (seen.has(member.symbol)) return false;
    seen.add(member.symbol);
    return true;
  });
}

export function replayTspStrategyMonitor({ rule, captures }: TspStrategyMonitorInput) {
  validateRule(rule);
  if (!Array.isArray(captures)) throw new Error("Invalid strategy monitor captures");
  const validSymbol = rule.assetType === "etf" ? isDatedEtfSymbol : (symbol: string) => stockSymbol.test(symbol) && !isAIndexSymbol(symbol);
  const hasBounds = rule.scoreMin !== undefined || rule.scoreMax !== undefined;
  const enabled = new Set(rule.eventTypes);
  const revisions = new Set<string>();
  const lastFire = new Map<string, number>();
  const buySeen = new Set<string>();
  const sellSeen = new Set<string>();
  let priorTime = 0;
  let priorDate: string | undefined;
  let priorPool: Set<string> | undefined;
  const evaluations = Array.from(captures as readonly TspStrategyMonitorCapture[], capture => {
    if (!hasText(capture?.revision) || revisions.has(capture.revision) || !Number.isSafeInteger(capture.evaluatedAt) ||
      capture.evaluatedAt <= priorTime || !Number.isFinite(new Date(capture.evaluatedAt).getTime()) ||
      typeof capture.tradeDate !== "string" || !isDailyDate(capture.tradeDate) || shanghai.format(capture.evaluatedAt) !== capture.tradeDate) {
      throw new Error("Invalid, duplicate or unordered strategy monitor capture");
    }
    revisions.add(capture.revision);
    priorTime = capture.evaluatedAt;
    const evidence = { captureRevision: capture.revision, evaluatedAt: capture.evaluatedAt, tradeDate: capture.tradeDate };
    const events: { kind: EventKind; batch: boolean; members: TspStrategyMonitorSignal[] }[] = [];
    if (capture.status === "unavailable") {
      if ("rows" in capture || "buySignals" in capture || "sellSignals" in capture) throw new Error("Unavailable strategy capture has result rows");
      return { ...evidence, status: "unavailable" as const, pool: priorPool ? [...priorPool] : null, suppressedCount: 0, events };
    }
    if (capture.status !== "completed") throw new Error("Invalid strategy monitor capture status");

    const eligible = [...bySymbol(capture.rows, validSymbol).values()].filter(({ score }) => {
      if (score !== null && !Number.isFinite(score)) throw new Error("Invalid strategy monitor score");
      return !hasBounds || (score !== null && score >= (rule.scoreMin ?? -Infinity) && score <= (rule.scoreMax ?? Infinity));
    }).map(row => row.symbol).sort();
    const pool = new Set(eligible);
    const buys = signalMembers(capture.buySignals, validSymbol).filter(member => !hasBounds || pool.has(member.symbol));
    const sells = signalMembers(capture.sellSignals, validSymbol);
    if (priorDate !== capture.tradeDate) {
      buySeen.clear();
      sellSeen.clear();
    }
    priorDate = capture.tradeDate;
    const freshBuys = freshSignals(buys, buySeen);
    const freshSells = freshSignals(sells, sellSeen);
    const previous = priorPool;
    priorPool = pool;
    if (!previous) return { ...evidence, status: "baseline" as const, pool: eligible, suppressedCount: 0, events };

    const changes = { buy_signal: freshBuys, sell_signal: freshSells,
      pool_entry: poolDifference(pool, previous), pool_exit: poolDifference(previous, pool) };
    let suppressedCount = 0;
    for (const kind of TSP_STRATEGY_MONITOR_EVENT_TYPES) {
      if (!enabled.has(kind)) continue;
      const members = changes[kind].sort((left, right) => left.symbol.localeCompare(right.symbol));
      const batch = members.length > 5;
      for (const group of batch ? [members] : members.map(member => [member])) {
        const key = `${kind}:${batch ? "batch" : group[0]!.symbol}`;
        const last = lastFire.get(key);
        if (last !== undefined && capture.evaluatedAt - last < rule.cooldownMs) {
          suppressedCount++;
          continue;
        }
        lastFire.set(key, capture.evaluatedAt);
        events.push({ kind, batch, members: group });
      }
    }
    return { ...evidence, status: "completed" as const, pool: eligible, suppressedCount, events };
  });
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_STRATEGY_MONITOR_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    strategyId: rule.strategyId,
    strategyRevision: rule.strategyRevision,
    assetType: rule.assetType,
    evaluations,
  };
}

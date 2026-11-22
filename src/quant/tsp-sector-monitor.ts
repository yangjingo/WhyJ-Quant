import { isDailyDate } from "../market/bars.ts";
import { isDatedBenchmarkIndexSymbol } from "../market/symbols.ts";
import { finiteStatistic, mean } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_SECTOR_MONITOR_FORMULA_VERSION = 1;
export const TSP_SECTOR_MONITOR_WINDOWS = [1, 3, 5, 10, 15] as const;
type MonitorWindow = typeof TSP_SECTOR_MONITOR_WINDOWS[number];

export type TspSectorMonitorTarget = { id: string; name: string } & (
  { kind: "index"; symbol: string } |
  { kind: "concept" | "industry"; membershipRevision: string; members: readonly string[] }
);

export interface TspSectorMonitorQuote {
  symbol: string;
  name: string | null;
  changeFraction: number | null;
  pricePoints?: number | null;
}

export type TspSectorMonitorRule = { direction: "up" | "down"; thresholdFraction: number; cooldownMs: number } & (
  { trigger: "change_pct" } | { trigger: "momentum"; windowMinutes: MonitorWindow }
);

export interface TspSectorMonitorInput {
  tradingDate: string;
  target: TspSectorMonitorTarget;
  captures: readonly { observedAt: number; quotes: readonly TspSectorMonitorQuote[] }[];
  rule?: TspSectorMonitorRule;
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const minuteMs = 60_000;
const baselineToleranceMs = 90_000;

function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function targetSymbols(target: TspSectorMonitorTarget) {
  if (!target || !text(target.id) || !text(target.name)) throw new Error("Invalid sector monitor target");
  if (target.kind === "index") {
    if (!text(target.symbol) || !isDatedBenchmarkIndexSymbol(target.symbol)) throw new Error("Invalid sector monitor index");
    return new Set([target.symbol]);
  }
  if ((target.kind !== "industry" && target.kind !== "concept") || !text(target.membershipRevision) || !Array.isArray(target.members) ||
    new Set(target.members).size !== target.members.length || target.members.some(symbol => typeof symbol !== "string" || !stock.test(symbol))) {
    throw new Error("Invalid sector monitor membership");
  }
  return new Set(target.members);
}

function summarizeCapture(quotes: readonly TspSectorMonitorQuote[], scope: ReadonlySet<string>, kind: TspSectorMonitorTarget["kind"]) {
  const seen = new Set<string>();
  const changes: number[] = [];
  let upCount = 0, downCount = 0;
  let leader: { symbol: string; name: string | null; changeFraction: number } | null = null;
  for (const quote of quotes) {
    if (!quote || !scope.has(quote.symbol) || seen.has(quote.symbol) ||
      (quote.name !== null && typeof quote.name !== "string") ||
      (quote.changeFraction !== null && (!Number.isFinite(quote.changeFraction) || quote.changeFraction < -1)) ||
      (quote.pricePoints != null && (kind !== "index" || !Number.isFinite(quote.pricePoints) || quote.pricePoints <= 0))) {
      throw new Error("Invalid or duplicate sector monitor quote");
    }
    seen.add(quote.symbol);
    const { symbol, name, changeFraction } = quote;
    if (changeFraction === null) continue;
    changes.push(changeFraction);
    if (changeFraction > 0) upCount++;
    if (changeFraction < 0) downCount++;
    if (!leader || changeFraction > leader.changeFraction || (changeFraction === leader.changeFraction && symbol < leader.symbol)) {
      leader = { symbol, name, changeFraction };
    }
  }
  const totalCount = scope.size;
  const validCount = changes.length;
  const coverageRatio = totalCount ? validCount / totalCount : 0;
  return {
    valid: kind === "index" ? validCount === 1 : totalCount >= 5 && coverageRatio >= 0.8,
    changeFraction: validCount ? mean(changes) : null,
    pricePoints: kind === "index" && validCount ? quotes[0]!.pricePoints ?? null : null,
    coverageRatio, validCount, totalCount, upCount, downCount,
    leader: kind === "index" ? null : leader,
  };
}

export function computeTspSectorMonitor(input: TspSectorMonitorInput) {
  const { tradingDate, target, captures, rule } = input;
  if (!isDailyDate(tradingDate) || !Array.isArray(captures) ||
    (rule !== undefined && (!rule || (rule.direction !== "up" && rule.direction !== "down") ||
      !Number.isFinite(rule.thresholdFraction) || rule.thresholdFraction <= 0 || rule.thresholdFraction > 0.2 ||
      !Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 0 ||
      (rule.trigger !== "change_pct" && (rule.trigger !== "momentum" || !TSP_SECTOR_MONITOR_WINDOWS.includes(rule.windowMinutes)))))) {
    throw new Error("Invalid sector monitor scope or rule");
  }
  const scope = targetSymbols(target);
  const history: { observedAt: number; changeFraction: number }[] = [];
  const baselinePositions = TSP_SECTOR_MONITOR_WINDOWS.map(() => 0);
  let previousTime = 0, lastFire: number | null = null, previousCondition: boolean | null = null;
  const rows = captures.map((capture: TspSectorMonitorInput["captures"][number]) => {
    if (!capture || !Number.isSafeInteger(capture.observedAt) || capture.observedAt <= previousTime ||
      !Number.isFinite(new Date(capture.observedAt).getTime()) || shanghai.format(capture.observedAt) !== tradingDate ||
      !Array.isArray(capture.quotes)) throw new Error("Invalid or unordered sector monitor capture");
    const { observedAt, quotes } = capture;
    previousTime = observedAt;
    const summary = summarizeCapture(quotes, scope, target.kind);
    const windows = TSP_SECTOR_MONITOR_WINDOWS.map((minutes, index) => {
      const cutoff = observedAt - minutes * minuteMs;
      let position = baselinePositions[index]!;
      while (position < history.length && history[position]!.observedAt <= cutoff) position++;
      baselinePositions[index] = position;
      const latest = history[position - 1];
      const baseline = summary.changeFraction !== null && latest && latest.observedAt >= cutoff - baselineToleranceMs ? latest : null;
      return { minutes, baselineAt: baseline?.observedAt ?? null,
        changeFraction: baseline && summary.changeFraction !== null ? finiteStatistic(summary.changeFraction - baseline.changeFraction) : null };
    });
    if (summary.valid && summary.changeFraction !== null) history.push({ observedAt, changeFraction: summary.changeFraction });

    let triggered: boolean | null = rule ? false : null;
    if (rule && summary.valid) {
      const metric = rule.trigger === "change_pct" ? summary.changeFraction
        : windows.find(window => window.minutes === rule.windowMinutes)!.changeFraction;
      const condition = metric !== null && (rule.direction === "up" ? metric >= rule.thresholdFraction : metric <= -rule.thresholdFraction);
      triggered = previousCondition === false && condition && (lastFire === null || observedAt - lastFire >= rule.cooldownMs);
      previousCondition = condition;
      if (triggered) lastFire = observedAt;
    }
    return { observedAt, ...summary, windows, triggered };
  });
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_sector_monitor" as const, version: TSP_SECTOR_MONITOR_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, target: structuredClone(target), rule: rule ? { ...rule } : null, rows,
  };
}

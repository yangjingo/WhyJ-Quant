import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_QUOTE_POLL_DELTA_FORMULA_VERSION = 1;

export interface TspQuotePollRow {
  symbol: string;
  timestamp: number;
  volume: number;
  amount: number | null;
}

export interface TspQuotePollCapture {
  observedAt: number;
  rows: readonly TspQuotePollRow[];
}

export interface TspQuotePollDeltaRule {
  metric: "volume" | "amount";
  threshold: number;
}

export interface TspQuotePollDeltaInput {
  tradingDate: string;
  requestedSymbols: readonly string[];
  previous?: TspQuotePollCapture;
  current: TspQuotePollCapture;
  volumeUnit: "hand" | "share" | "unknown";
  amountUnit: "CNY" | "CNY-thousand" | "unknown";
  rule?: TspQuotePollDeltaRule;
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const shanghaiTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const instant = (value: number) => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;

function continuousSession(timestamp: number, tradingDate: string) {
  if (shanghaiDate.format(timestamp) !== tradingDate) return null;
  const weekday = new Date(tradingDate + "T00:00:00Z").getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const time = shanghaiTime.format(timestamp);
  if (time >= "09:30:00" && (time < "11:30:00" || (time === "11:30:00" && timestamp % 1000 === 0))) return "morning" as const;
  if (time >= "13:00:00" && (time < "15:00:00" || (time === "15:00:00" && timestamp % 1000 === 0))) return "afternoon" as const;
  return null;
}

function indexCapture(capture: TspQuotePollCapture, scope: ReadonlySet<string>) {
  if (!capture || !instant(capture.observedAt) || !Array.isArray(capture.rows)) throw new Error("Invalid quote poll capture");
  const index = new Map<string, TspQuotePollRow>();
  for (const row of capture.rows) {
    if (!row || !scope.has(row.symbol) || index.has(row.symbol) || !instant(row.timestamp) || row.timestamp > capture.observedAt ||
      !nonnegative(row.volume) || (row.amount !== null && !nonnegative(row.amount))) throw new Error("Invalid or duplicate quote poll row");
    index.set(row.symbol, row);
  }
  return index;
}

export function computeTspQuotePollDelta(input: TspQuotePollDeltaInput) {
  const { tradingDate, requestedSymbols, previous, current, volumeUnit, amountUnit, rule } = input;
  if (!isDailyDate(tradingDate) || !["hand", "share", "unknown"].includes(volumeUnit) ||
    !["CNY", "CNY-thousand", "unknown"].includes(amountUnit) || !Array.isArray(requestedSymbols) || !requestedSymbols.length ||
    requestedSymbols.some(symbol => typeof symbol !== "string" || !stock.test(symbol)) ||
    (rule !== undefined && (!rule || (rule.metric !== "volume" && rule.metric !== "amount") ||
      !Number.isFinite(rule.threshold) || rule.threshold < 1))) throw new Error("Invalid quote poll scope, units or rule");
  const scope = new Set(requestedSymbols);
  if (scope.size !== requestedSymbols.length) throw new Error("Duplicate quote poll symbol");
  const currentRows = indexCapture(current, scope);
  const previousRows = previous === undefined ? undefined : indexCapture(previous, scope);
  if (previous && previous.observedAt >= current.observedAt) throw new Error("Quote polls must be in strictly increasing order");
  const session = continuousSession(current.observedAt, tradingDate);
  const previousSession = previous ? continuousSession(previous.observedAt, tradingDate) : null;
  const status = session === null ? "outside-session" : !previous ? "missing-previous" :
    session !== previousSession ? "session-boundary" : "comparable";
  const rows = requestedSymbols.map(symbol => {
    const before = previousRows?.get(symbol) ?? null;
    const after = currentRows.get(symbol) ?? null;
    const evidence = { symbol, previous: before && { ...before }, current: after && { ...after } };
    const unavailable = { ...evidence, nativeVolumeDelta: null, nativeAmountDelta: null, volumeDeltaHands: null,
      amountDeltaCny: null, triggered: null };
    if (status !== "comparable") return { ...unavailable, availability: status };
    if (!before || !after) return { ...unavailable, availability: before ? "missing-current" as const : "missing-previous" as const };
    if (continuousSession(before.timestamp, tradingDate) !== session || continuousSession(after.timestamp, tradingDate) !== session) {
      return { ...unavailable, availability: "off-session-quote" as const };
    }
    if (after.timestamp <= before.timestamp) return { ...unavailable, availability: "nonadvancing-quote" as const };
    const nativeVolumeDelta = after.volume - before.volume;
    const nativeAmountDelta = after.amount === null || before.amount === null ? null : after.amount - before.amount;
    if (nativeVolumeDelta < 0 || (nativeAmountDelta !== null && nativeAmountDelta < 0)) {
      return { ...unavailable, availability: "counter-reset" as const };
    }
    const volumeDeltaHands = volumeUnit === "unknown" ? null : nativeVolumeDelta / (volumeUnit === "share" ? 100 : 1);
    const amountDeltaCny = amountUnit === "unknown" || nativeAmountDelta === null ? null
      : finiteStatistic(nativeAmountDelta * (amountUnit === "CNY-thousand" ? 1000 : 1));
    const metric = rule?.metric === "volume" ? volumeDeltaHands : amountDeltaCny;
    return { ...evidence, availability: "observed" as const, nativeVolumeDelta, nativeAmountDelta, volumeDeltaHands, amountDeltaCny,
      triggered: !rule ? null : nativeVolumeDelta === 0 ? false : metric === null ? null : metric >= rule.threshold };
  });
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_quote_poll_delta" as const, version: TSP_QUOTE_POLL_DELTA_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, status, session, previousObservedAt: previous?.observedAt ?? null, currentObservedAt: current.observedAt,
    pollSpanMs: status === "comparable" ? current.observedAt - previous!.observedAt : null,
    volumeUnit, amountUnit, rule: rule ? { ...rule } : null,
    observedSymbols: rows.filter(row => row.availability === "observed").length,
    rows,
  };
}

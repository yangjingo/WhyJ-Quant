import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_DEPTH_SEAL_FORMULA_VERSION = 1;
export const TSP_DEPTH_QUEUE_FORMULA_VERSION = 1;

export interface TspDepthLimitCandidate {
  symbol: string;
  side: "up" | "down";
}

export interface TspDepthQuote {
  symbol: string;
  timestamp: number;
  bestBidVolume: number | null;
  bestAskVolume: number | null;
}

export interface TspDepthSnapshot {
  asOf: number;
  maxAgeMs: number;
  quotes: readonly TspDepthQuote[];
}

export interface TspDepthSealInput extends TspDepthSnapshot {
  tradingDate: string;
  candidates: readonly TspDepthLimitCandidate[];
}

export interface TspDepthQueueRule {
  metric: "sealed_vol" | "sealed_amount";
  threshold: number;
}

export interface TspDepthQueueInput extends Omit<TspDepthSealInput, "candidates"> {
  candidates: readonly (TspDepthLimitCandidate & { closeCny: number | null })[];
  volumeUnit: "hand" | "share" | "unknown";
  rule?: TspDepthQueueRule;
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const shanghai = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const instant = (value: number) => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const volume = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);

function depthFreshness(timestamp: number, input: TspDepthSealInput) {
  if (shanghai.format(timestamp) !== input.tradingDate) return "off-date" as const;
  if (timestamp > input.asOf) return "after-cutoff" as const;
  if (input.asOf - timestamp > input.maxAgeMs) return "stale" as const;
  return "observed" as const;
}

function assess(candidate: TspDepthLimitCandidate, quote: TspDepthQuote | undefined, input: TspDepthSealInput) {
  if (!quote) return { ...candidate, sealed: null, timestamp: null, opposingVolume: null, availability: "missing-book" as const };
  const { timestamp } = quote;
  const opposingVolume = candidate.side === "up" ? quote.bestAskVolume : quote.bestBidVolume;
  const entry = { ...candidate, timestamp, opposingVolume };
  const freshness = depthFreshness(timestamp, input);
  if (freshness !== "observed") return { ...entry, sealed: null, availability: freshness };
  if (opposingVolume === null) return { ...entry, sealed: null, availability: "missing-level" as const };
  return { ...entry, sealed: opposingVolume === 0, availability: "observed" as const };
}

function counts(rows: readonly ReturnType<typeof assess>[], side: TspDepthLimitCandidate["side"]) {
  const candidates = rows.filter(row => row.side === side);
  const observedSealed = candidates.filter(row => row.sealed === true).length;
  const observedUnsealed = candidates.filter(row => row.sealed === false).length;
  const missing = candidates.length - observedSealed - observedUnsealed;
  return { priceLimitCount: candidates.length, observedSealed, observedUnsealed, missing,
    correctedCount: candidates.length - observedUnsealed };
}

function indexDepthQuotes(input: TspDepthSealInput) {
  const { tradingDate, asOf, maxAgeMs, candidates, quotes } = input;
  if (!isDailyDate(tradingDate) || !instant(asOf) || shanghai.format(asOf) !== tradingDate ||
    !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new Error("Invalid depth seal scope");
  const symbols = new Set<string>();
  for (const { symbol, side } of candidates) {
    if (!stock.test(symbol) || symbols.has(symbol) || (side !== "up" && side !== "down")) {
      throw new Error("Invalid or duplicate depth seal candidate");
    }
    symbols.add(symbol);
  }
  const bySymbol = new Map<string, TspDepthQuote>();
  for (const quote of quotes) {
    if (!symbols.has(quote.symbol) || bySymbol.has(quote.symbol) || !instant(quote.timestamp) ||
      !volume(quote.bestBidVolume) || !volume(quote.bestAskVolume)) throw new Error("Invalid or duplicate depth seal quote");
    bySymbol.set(quote.symbol, quote);
  }
  return bySymbol;
}

/** Apply the pinned opposing-side rule to the caller's exact price-limited candidates. */
export function computeTspDepthSeal(input: TspDepthSealInput) {
  const { tradingDate, asOf, maxAgeMs, candidates } = input;
  const bySymbol = indexDepthQuotes(input);
  const rows = candidates.map(candidate => assess(candidate, bySymbol.get(candidate.symbol), input))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const up = counts(rows, "up"), down = counts(rows, "down");
  const missing = up.missing + down.missing;
  const coverage = missing === 0 ? "complete" as const : missing === candidates.length ? "unavailable" as const : "partial" as const;
  return {
    producer: "whyj" as const, formula: { id: "tsp_depth_seal" as const, version: TSP_DEPTH_SEAL_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, asOf, maxAgeMs, coverage, up, down, rows,
  };
}

/** Measure the queued own-side level for already scoped limit candidates. */
export function computeTspDepthQueue(input: TspDepthQueueInput) {
  const { tradingDate, asOf, maxAgeMs, candidates, volumeUnit, rule } = input;
  if (!["hand", "share", "unknown"].includes(volumeUnit) ||
    (rule !== undefined && (!rule || (rule.metric !== "sealed_vol" && rule.metric !== "sealed_amount") ||
      !Number.isFinite(rule.threshold) || rule.threshold < 0))) throw new Error("Invalid depth queue rule or units");
  const bySymbol = indexDepthQuotes(input);
  const rows = candidates.map(candidate => {
    const { symbol, side, closeCny } = candidate;
    if (closeCny !== null && (!Number.isFinite(closeCny) || closeCny <= 0)) throw new Error("Invalid depth queue close");
    const quote = bySymbol.get(symbol);
    const nativeVolume = (side === "up" ? quote?.bestBidVolume : quote?.bestAskVolume) ?? null;
    const freshness = quote ? depthFreshness(quote.timestamp, input) : "missing-book" as const;
    const availability = freshness === "observed" && nativeVolume === null ? "missing-level" as const : freshness;
    const queueShares = availability === "observed" && nativeVolume !== null && volumeUnit !== "unknown"
      ? nativeVolume * (volumeUnit === "hand" ? 100 : 1) : null;
    if (queueShares !== null && !Number.isSafeInteger(queueShares)) throw new Error("Depth queue share count overflow");
    const queueHands = queueShares === null ? null : queueShares / 100;
    const queueAmountCny = queueShares === null || closeCny === null ? null : finiteStatistic(queueShares * closeCny);
    const comparison = rule?.metric === "sealed_vol" ? queueHands : queueAmountCny;
    return {
      symbol, side, closeCny, timestamp: quote?.timestamp ?? null, availability, nativeVolume,
      queueShares, queueHands, queueAmountCny,
      triggered: rule && comparison !== null ? comparison > 0 && comparison <= rule.threshold : null,
    };
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  return {
    producer: "whyj" as const,
    formula: { id: "tsp_depth_queue" as const, version: TSP_DEPTH_QUEUE_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, asOf, maxAgeMs, volumeUnit, rule: rule ? { ...rule } : null,
    observedCandidates: rows.filter(row => row.availability === "observed").length,
    rows,
  };
}

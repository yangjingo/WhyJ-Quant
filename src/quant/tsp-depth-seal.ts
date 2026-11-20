import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_DEPTH_SEAL_FORMULA_VERSION = 1;

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

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const shanghai = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const instant = (value: number) => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const volume = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);

function assess(candidate: TspDepthLimitCandidate, quote: TspDepthQuote | undefined, input: TspDepthSealInput) {
  if (!quote) return { ...candidate, sealed: null, timestamp: null, opposingVolume: null, availability: "missing-book" as const };
  const { timestamp } = quote;
  const opposingVolume = candidate.side === "up" ? quote.bestAskVolume : quote.bestBidVolume;
  const entry = { ...candidate, timestamp, opposingVolume };
  if (shanghai.format(timestamp) !== input.tradingDate) return { ...entry, sealed: null, availability: "off-date" as const };
  if (timestamp > input.asOf) return { ...entry, sealed: null, availability: "after-cutoff" as const };
  if (input.asOf - timestamp > input.maxAgeMs) return { ...entry, sealed: null, availability: "stale" as const };
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

/** Apply the pinned opposing-side rule to the caller's exact price-limited candidates. */
export function computeTspDepthSeal(input: TspDepthSealInput) {
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

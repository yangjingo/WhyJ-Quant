import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { isTspMinuteBar, tspMinuteIndex, type TspCompletedMinuteBar } from "./tsp-intraday.ts";

export const TSP_LIST_INTRADAY_FORMULA_VERSION = 1;

export const TSP_LIST_QUOTE_TAIL_FORMULA_VERSION = 1;

export interface TspListQuoteTailInput {
  symbol: string;
  tradeDate: string;
  bars: readonly TspCompletedMinuteBar[];
  frameObservedAt: number;
  asOf: number;
  maxQuoteAgeMs: number;
  quote: { symbol: string; timestamp: number; price: number } | null;
}

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const shanghaiTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const isTimestamp = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;

export function projectTspListQuoteTail(input: TspListQuoteTailInput) {
  const { symbol, tradeDate, bars: inputBars, frameObservedAt, asOf, maxQuoteAgeMs, quote } = input;
  if (typeof symbol !== "string" || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol) ||
    typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !Array.isArray(inputBars) || inputBars.length > 240 ||
    !isTimestamp(frameObservedAt) || !isTimestamp(asOf) || frameObservedAt > asOf ||
    !Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs < 0) throw new Error("Invalid list quote tail inputs");
  const bars: readonly TspCompletedMinuteBar[] = inputBars;
  const asOfMinute = tspMinuteIndex(shanghaiTime.format(asOf));
  let lastSlot = -1;
  for (const bar of bars) {
    const slot = typeof bar?.minute === "string" ? tspMinuteIndex(bar.minute) : -1;
    if (slot <= lastSlot || bar.tradingDate !== tradeDate || !isTspMinuteBar(bar)) throw new Error("Invalid list quote tail minute bars");
    lastSlot = slot;
  }
  const formula = { id: "tsp_list_quote_tail" as const, version: TSP_LIST_QUOTE_TAIL_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION };
  const baseline = { producer: "whyj" as const, formula, symbol, tradeDate, frameObservedAt, asOf };
  const unchanged = (reason: "empty" | "out-of-session" | "missing-quote" | "mismatched-quote" | "stale-quote" | "covered") =>
    ({ ...baseline, status: "unchanged" as const, reason, bars, applied: null });
  const last = bars.at(-1);
  if (!last) return unchanged("empty");
  const weekday = new Date(tradeDate + "T00:00:00Z").getUTCDay();
  if (weekday === 0 || weekday === 6 || asOfMinute < 0 ||
    shanghaiDate.format(asOf) !== tradeDate || shanghaiDate.format(frameObservedAt) !== tradeDate) {
    return unchanged("out-of-session");
  }
  if (quote === null) return unchanged("missing-quote");
  if (!quote || !isTimestamp(quote.timestamp) || !Number.isFinite(quote.price) || quote.price <= 0 ||
    quote.symbol !== symbol || shanghaiDate.format(quote.timestamp) !== tradeDate) return unchanged("mismatched-quote");
  const minute = shanghaiTime.format(quote.timestamp);
  const slot = tspMinuteIndex(minute);
  if (slot < 0 || (slot >= 120) !== (asOfMinute >= 120)) return unchanged("out-of-session");
  if (quote.timestamp > asOf || asOf - quote.timestamp > maxQuoteAgeMs) return unchanged("stale-quote");
  if (slot < lastSlot || quote.timestamp <= frameObservedAt) return unchanged("covered");

  const applied = { quoteTimestamp: quote.timestamp, price: quote.price, minute, finality: "provisional" as const };
  const price = quote.price;
  if (slot === lastSlot) return { ...baseline, status: "updated" as const, applied,
    bars: [...bars.slice(0, -1), { ...last, close: price,
      high: last.high === null ? null : Math.max(last.high, price),
      low: last.low === null ? null : Math.min(last.low, price) }] };
  return { ...baseline, status: "appended" as const, applied,
    bars: [...bars, { tradingDate: tradeDate, minute, open: price, high: price, low: price, close: price,
      volumeShares: null, amountCny: null }] };
}

export interface TspListIntradayInput {
  tradeDate: string;
  bars: readonly Pick<TspCompletedMinuteBar, "tradingDate" | "minute" | "open" | "close">[];
  previousClose: number | null;
  /** A supplied return must refer to the same last observed close. */
  sameCloseChangeFraction?: number | null;
}

export function computeTspListIntraday(input: TspListIntradayInput) {
  const { tradeDate, bars, previousClose, sameCloseChangeFraction = null } = input;
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !Array.isArray(bars) ||
    (previousClose !== null && (!Number.isFinite(previousClose) || previousClose <= 0)) ||
    (sameCloseChangeFraction !== null && (!Number.isFinite(sameCloseChangeFraction) || sameCloseChangeFraction <= -1))) {
    throw new Error("Invalid stock-list intraday chart inputs");
  }

  const observations = bars as TspListIntradayInput["bars"];
  let previousSlot = -1, runningClose = 0;
  const points = observations.map((bar, i) => {
    const slot = typeof bar?.minute === "string" ? tspMinuteIndex(bar.minute) : -1;
    if (slot <= previousSlot || bar.tradingDate !== tradeDate || !Number.isFinite(bar.close) || bar.close <= 0 ||
      (bar.open !== null && (!Number.isFinite(bar.open) || bar.open <= 0))) {
      throw new Error("Invalid or unordered stock-list intraday observation");
    }
    previousSlot = slot;
    runningClose = finiteStatistic(runningClose + bar.close);
    return { minute: bar.minute, close: bar.close, averageClose: runningClose / (i + 1),
      previousCloseReturnFraction: previousClose === null ? null : finiteStatistic(bar.close / previousClose - 1) };
  });

  const first = observations[0], last = points.at(-1);
  let plotBaseline: { kind: "previous-close" | "implied-from-last-return" | "first-observed-open" | "first-observed-close"; value: number } | null = null;
  if (first && last) {
    if (previousClose !== null) plotBaseline = { kind: "previous-close", value: previousClose };
    else if (sameCloseChangeFraction !== null && sameCloseChangeFraction !== 0) {
      plotBaseline = { kind: "implied-from-last-return", value: finiteStatistic(last.close / (1 + sameCloseChangeFraction)) };
    } else {
      plotBaseline = { kind: first.open === null ? "first-observed-close" : "first-observed-open", value: first.open ?? first.close };
    }
  }
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_list_intraday" as const, version: TSP_LIST_INTRADAY_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradeDate, plotBaseline,
    latestReturnFraction: last?.previousCloseReturnFraction ?? null,
    points,
  };
}

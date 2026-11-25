import { isDailyDate } from "../../market/bars.ts";
import { isDatedBenchmarkIndexSymbol } from "../../market/symbols.ts";
import { computeTspDailyIndicators, TSP_DAILY_INDICATOR_FORMULA_VERSION, TSP_INDICATOR_REVISION, type TspDailyIndicatorRow } from "../../quant/index.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveDatedIndexDailyBars, loadDatedIndexDailyArchive, type DatedIndexDailyArchiveRef, type StoredDatedIndexDailyBar } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

interface IndexDailyDateRange {
  start: string;
  end: string;
}

export interface DatedIndexDailyCollectionRequest extends IndexDailyDateRange {
  symbol: string;
}

export interface DatedIndexDailyReplayRequest {
  ref: DatedIndexDailyArchiveRef;
  displayRange?: IndexDailyDateRange;
}

export interface DatedIndexDailyQuoteRequest extends DatedIndexDailyReplayRequest {
  calendar: { revision: string; previousTradeDate: string; tradeDate: string };
}

function indexDailyIndicatorBar(row: StoredDatedIndexDailyBar) {
  return { date: row.tradeDate, open: row.openPoints, high: row.highPoints, low: row.lowPoints, close: row.closePoints, volume: row.volume };
}

function indexChartIndicators({ date, ma5, ma10, ma20, ma60, macd_dif, macd_dea, macd_hist, rsi_6, rsi_14, rsi_24,
  kdj_k, kdj_d, kdj_j, boll_upper, boll_lower }: TspDailyIndicatorRow) {
  return { date, ma5, ma10, ma20, ma60, macd_dif, macd_dea, macd_hist, rsi_6, rsi_14, rsi_24,
    kdj_k, kdj_d, kdj_j, boll_upper, boll_lower };
}

function validDateRange({ start, end }: IndexDailyDateRange): boolean {
  return typeof start === "string" && typeof end === "string" &&
    isDailyDate(start) && isDailyDate(end) && start >= "0001-01-01" && start <= end;
}

export async function collectDatedIndexDailyBars(request: DatedIndexDailyCollectionRequest, options: SourceRequestOptions = {}) {
  const { symbol, start, end } = request;
  const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!isDatedBenchmarkIndexSymbol(code) || !validDateRange({ start, end })) {
    throw new TypeError("Invalid dated index daily request.");
  }
  const control = { ...options };
  control.signal?.throwIfAborted();
  const selected = await createConfiguredMarketDataSource(control.signal);
  const { source, endpoint, market, coverage, observedAt, data } = await selected.fetchDatedIndexDailyBars({
    symbol: code, market: "A", start, end,
  }, control);
  if (source !== "tickflow" || endpoint !== "/v1/klines" || market !== "A" || data.symbol !== code ||
    data.requested.start !== start || data.requested.end !== end) throw new Error("Dated index daily response does not match its scope.");
  const { rows, ...metadata } = data;
  const evidence = { ...metadata, source, endpoint, market, coverage, observedAt } as const;
  const ref = await archiveDatedIndexDailyBars({ ...evidence, rows }, control.signal);
  return { ...evidence, ref, rowCount: rows.length, status: rows.length ? "archived" as const : "empty" as const };
}

export async function replayDatedIndexDailyBars(request: DatedIndexDailyReplayRequest, signal?: AbortSignal) {
  const ref = { ...request.ref };
  const requestedDisplay = request.displayRange && { ...request.displayRange };
  const daily = await loadDatedIndexDailyArchive(ref, signal);
  const displayRange = requestedDisplay ?? daily.requested;
  if (!validDateRange(displayRange) || displayRange.start < daily.requested.start || displayRange.end > daily.requested.end) {
    throw new RangeError("Index chart display range must fit within its archived request.");
  }
  const bars = daily.rows.filter(row => row.tradeDate <= displayRange.end);
  signal?.throwIfAborted();
  const indicators = computeTspDailyIndicators(bars.map(indexDailyIndicatorBar));
  return {
    input: { daily: { ref, ...daily } },
    metrics: {
      producer: "whyj" as const,
      formulaVersion: TSP_DAILY_INDICATOR_FORMULA_VERSION,
      referenceRevision: TSP_INDICATOR_REVISION,
      displayRange,
      calculationWindow: { firstDate: bars[0]?.tradeDate ?? null, lastDate: bars.at(-1)?.tradeDate ?? null, rowCount: bars.length },
      rows: indicators.filter(row => row.date >= displayRange.start).map(indexChartIndicators),
    },
  };
}

const shanghaiDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Preview today's chart additions from one quote and one immutable history revision. */
export async function readDatedIndexDailyWithQuote(request: DatedIndexDailyQuoteRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  const { signal } = control;
  signal?.throwIfAborted();
  const { revision, tradeDate, previousTradeDate } = request.calendar;
  if (typeof revision !== "string" || !revision.trim() || previousTradeDate === tradeDate ||
    !validDateRange({ start: previousTradeDate, end: tradeDate })) throw new Error("Invalid index quote calendar.");
  const fixed = await replayDatedIndexDailyBars(request, signal);
  const result = { fixed, calendar: { revision, tradeDate, previousTradeDate } };
  if (tradeDate !== shanghaiDay.format()) return { ...result, provisional: { status: "outside-current-day" as const } };

  const daily = fixed.input.daily;
  let batch;
  try {
    const selected = await createConfiguredMarketDataSource(signal);
    batch = await selected.fetchQuotes({ symbols: [daily.symbol] }, control);
  } catch {
    signal?.throwIfAborted();
    return { ...result, provisional: { status: "unavailable" as const } };
  }
  signal?.throwIfAborted();
  const { source, endpoint, observedAt, units, data } = batch;
  const observedTime = Date.parse(observedAt);
  if (source !== daily.source || endpoint !== "/v1/quotes" || !Number.isFinite(observedTime)) {
    return { ...result, provisional: { status: "unavailable" as const } };
  }
  const quote = data.find(row => row.symbol === daily.symbol);
  const observation = { source, endpoint, observedAt, units, sourceTimestamp: quote?.timestamp ?? null };
  if (!quote) return { ...result, provisional: { ...observation, status: "missing" as const } };
  if (quote.timestamp > observedTime) return { ...result, provisional: { ...observation, status: "future-timestamp" as const } };
  if (shanghaiDay.format(quote.timestamp) !== tradeDate || shanghaiDay.format(observedTime) !== tradeDate) {
    return { ...result, provisional: { ...observation, status: "different-session" as const } };
  }

  const closePoints = quote.lastPrice;
  const openPoints = quote.open || closePoints;
  const highPoints = quote.high || closePoints;
  const lowPoints = quote.low || closePoints;
  if (closePoints <= 0 || highPoints < Math.max(openPoints, closePoints) || lowPoints > Math.min(openPoints, closePoints)) {
    return { ...result, provisional: { ...observation, status: "invalid-candle" as const, snapshot: quote } };
  }
  const substitutedFields = (["open", "high", "low"] as const).filter(field => quote[field] === 0);
  const candle = { tradeDate, priceUnit: "index-points" as const, openPoints, highPoints, lowPoints, closePoints, substitutedFields };
  const changePoints = quote.previousClose > 0 ? closePoints - quote.previousClose : null;
  const changeFraction = changePoints === null ? null : changePoints / quote.previousClose;
  const change = { producer: "whyj" as const, changePoints, changeFraction: Number.isFinite(changeFraction) ? changeFraction : null };

  const history = daily.rows.filter(row => row.tradeDate < tradeDate);
  const available = {
    ...observation, status: "available" as const, finality: "provisional" as const, snapshot: quote, candle, change,
  };
  if (history.at(-1)?.tradeDate !== previousTradeDate) {
    return { ...result, provisional: { ...available, metrics: { status: "missing-previous-session" as const } } };
  }
  const bars = history.map(indexDailyIndicatorBar);
  bars.push({ date: tradeDate, open: openPoints, high: highPoints, low: lowPoints, close: closePoints, volume: quote.volume });
  const row = computeTspDailyIndicators(bars).at(-1)!;
  signal?.throwIfAborted();
  return { ...result, provisional: { ...available, metrics: {
    status: "available" as const, producer: "whyj" as const, formulaVersion: TSP_DAILY_INDICATOR_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    calculationWindow: { firstDate: bars[0]!.date, lastDate: tradeDate, rowCount: bars.length },
    row: { ...indexChartIndicators(row), ma30: row.ma30, atr_14: row.atr_14, vol_ratio_5d: null },
    volumeRatioStatus: "quote-and-history-units-unconfirmed" as const,
  } } };
}

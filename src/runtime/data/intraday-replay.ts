import { computeTspIntraday, TSP_INDICATOR_REVISION, TSP_INTRADAY_FORMULA_VERSION } from "../../quant/index.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import {
  archiveHistoricalMinuteObservations, loadDailyTradingLimitArchive, loadHistoricalMinuteArchive,
  type HistoricalMinuteArchiveRef, type TradingLimitArchiveRef,
} from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface HistoricalMinuteCollectionRequest {
  symbol: string;
  startDate: string;
  endDate: string;
}

export type HistoricalMinuteCollectionReceipt = {
  source: string;
  endpoint: string;
  observedAt: string;
} & (
  | { status: "empty"; rowCount: 0; ref: null }
  | { status: "archived"; rowCount: number; ref: HistoricalMinuteArchiveRef }
);

export async function collectHistoricalMinuteObservations(
  request: HistoricalMinuteCollectionRequest,
  options: SourceRequestOptions = {},
): Promise<HistoricalMinuteCollectionReceipt> {
  if (typeof request?.symbol !== "string" || typeof request.startDate !== "string" || typeof request.endDate !== "string") {
    throw new Error("Invalid historical minute collection request");
  }
  const { symbol, startDate, endDate } = request;
  const control = { ...options };
  control.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(control.signal);
  control.signal?.throwIfAborted();
  const response = await source.fetchHistoricalMinuteBars({ symbol, market: "A", start: startDate, end: endDate }, control);
  control.signal?.throwIfAborted();

  const { source: provider, market, endpoint, observedAt, coverage, data } = response;
  if (provider !== "tushare" || market !== "A" || endpoint !== "stk_mins") {
    throw new Error("Unsupported historical minute observation");
  }
  const { bars, requested, ...layout } = data;
  const metadata = { source: provider, endpoint, observedAt };
  const first = bars[0];
  if (!first) return { ...metadata, status: "empty", rowCount: 0, ref: null };
  const ref = await archiveHistoricalMinuteObservations({
    ...layout,
    source: provider,
    endpoint,
    observedAt,
    symbol: first.symbol,
    market,
    coverage,
    requested: { startDate: requested.start, endDate: requested.end },
    rows: bars.map(({ symbol: _symbol, tradeDate: _date, ...row }) => row),
  }, control.signal);
  return { ...metadata, status: "archived", rowCount: bars.length, ref };
}

export interface IntradayReplayOptions {
  signal?: AbortSignal;
  previousClose?: {
    ref: TradingLimitArchiveRef;
    priceBasis: "caller-confirmed-same-basis";
  };
}

function rightEdgeToMinuteStart(tradeTime: string): string {
  const wallMinute = Number(tradeTime.slice(11, 13)) * 60 + Number(tradeTime.slice(14, 16));
  const start = wallMinute - 1;
  if (!((start >= 570 && start < 690) || (start >= 780 && start < 900))) {
    throw new Error("Unsupported Tushare historical minute label: " + tradeTime);
  }
  const hour = String(Math.floor(start / 60)).padStart(2, "0");
  const minute = String(start % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

export async function resolveTspArchiveIntraday(ref: HistoricalMinuteArchiveRef, options: IntradayReplayOptions = {}) {
  const archiveRef = { ...ref };
  const { signal } = options;
  const previousClose = options.previousClose && { ...options.previousClose, ref: { ...options.previousClose.ref } };
  if (previousClose && previousClose.priceBasis !== "caller-confirmed-same-basis") {
    throw new Error("Confirm compatible price bases before replaying previous close");
  }

  const { rows: rawRows, ...input } = await loadHistoricalMinuteArchive(archiveRef, signal);
  const closeByDate: Record<string, number> = {};
  let previousCloseInput;
  if (previousClose) {
    const limits = await loadDailyTradingLimitArchive(previousClose.ref, signal);
    if (limits.symbol !== input.symbol || limits.source !== input.source || limits.market !== input.market) {
      throw new Error("Previous close archive does not match the minute archive");
    }
    for (const { tradeDate, previousClose: close } of limits.rows) {
      if (close !== null && tradeDate >= input.requested.startDate && tradeDate <= input.requested.endDate) {
        closeByDate[tradeDate] = close;
      }
    }
    previousCloseInput = { archiveRef: previousClose.ref, priceBasis: previousClose.priceBasis, source: limits.source, endpoint: limits.endpoint,
      observedAt: limits.observedAt, priceUnit: limits.priceUnit, requested: limits.requested };
  }
  signal?.throwIfAborted();

  const openingBoundaries = rawRows.filter(row => row.openingBoundary);
  const completed = rawRows.filter(row => !row.openingBoundary).map(row => ({
    tradingDate: row.tradeTime.slice(0, 10),
    minute: rightEdgeToMinuteStart(row.tradeTime),
    originalTradeTime: row.tradeTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volumeShares: row.volume,
    amountCny: row.amount,
  }));
  const calculated = computeTspIntraday(completed, closeByDate);
  const preview = {
    archiveRef,
    producer: "whyj" as const,
    formula: { id: "tsp_intraday" as const, version: TSP_INTRADAY_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    input: { ...input, labelConvention: "tushare-stk-mins-end-time-v1" as const, previousClose: previousCloseInput ?? null },
    openingBoundaries,
    rows: calculated.map((row, index) => ({ ...row, originalTradeTime: completed[index]!.originalTradeTime })),
  };
  return { completed, preview };
}

/** Calculate WhyJ metrics from exact local references and retain the provider's raw time labels. */
export async function deriveTspArchiveIntraday(ref: HistoricalMinuteArchiveRef, options: IntradayReplayOptions = {}) {
  return (await resolveTspArchiveIntraday(ref, options)).preview;
}

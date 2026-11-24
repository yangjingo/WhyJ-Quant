/** Explicit selected-source collection and immutable replay. No scheduler or TSP transport. */
import { computeTspDailyIndicatorsAndSignals, tspTradingLimitThresholds, TSP_DAILY_INDICATOR_FORMULA_VERSION, TSP_DAILY_SIGNAL_FIELDS, TSP_DAILY_SIGNAL_FORMULA_VERSION, TSP_INDICATOR_FORMULA_VERSION, TSP_INDICATOR_REVISION } from "../../quant/index.ts";
import { toBarObservations, toFactorObservations, toTradingDateBarObservations, TSP_DAILY_INDICATOR_FIELDS, type KlineAdjustment, type KlineInterval, type SourceRequestOptions, type TradingDateKlineRequest } from "../../source/index.ts";
import { archiveObservations, loadObservationArchive, archiveTradingDateObservations, loadTradingDateArchive, archiveDailyTradingLimits,
  loadDailyTradingLimitArchive, type ObservationArchiveRef, type StoredTradingDateBarObservation, type TradingDateArchiveRef,
  type TradingLimitArchiveRef } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export type ObservationCollectionRequest =
  | { dataset: "bars"; symbol: string; interval: KlineInterval; adjustment: KlineAdjustment; startTime?: number; endTime?: number; count?: number }
  | { dataset: "adjustment_factor"; symbol: string; startTime?: number; endTime?: number };
export type ObservationCollectionReceipt = {
  source: string; endpoint: string; observedAt: string;
} & ({ status: "empty"; rowCount: 0; ref: null } | { status: "archived"; rowCount: number; ref: ObservationArchiveRef });

/** Performs one explicit selected-provider request and commits its response as one immutable batch. */
export async function collectObservations(request: ObservationCollectionRequest, options: SourceRequestOptions = {}): Promise<ObservationCollectionReceipt> {
  if (!request || (request.dataset !== "bars" && request.dataset !== "adjustment_factor")) throw new Error("Invalid observation collection request");
  const input = { ...request };
  options.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(options.signal);
  options.signal?.throwIfAborted();
  const response = input.dataset === "bars"
    ? await source.fetchKlines({ symbol: input.symbol, interval: input.interval, adjustment: input.adjustment,
        startTime: input.startTime, endTime: input.endTime, count: input.count }, options)
    : await source.fetchAdjustmentFactors({ symbols: [input.symbol], startTime: input.startTime, endTime: input.endTime }, options);
  options.signal?.throwIfAborted();
  const rows = input.dataset === "bars" ? toBarObservations(response as Awaited<ReturnType<typeof source.fetchKlines>>)
    : toFactorObservations(response as Awaited<ReturnType<typeof source.fetchAdjustmentFactors>>);
  const metadata = { source: response.source, endpoint: response.endpoint, observedAt: response.observedAt };
  if (!rows.length) return { ...metadata, status: "empty", rowCount: 0, ref: null };
  const ref = await archiveObservations(rows, options.signal);
  // Once storage has committed, return the reference even if cancellation arrives afterward.
  return { ...metadata, status: "archived", rowCount: rows.length, ref };
}

/** Read only the requested committed revision; no provider request or fallback. */
export const replayObservations = loadObservationArchive;

export type TradingDateCollectionReceipt = {
  source: string; endpoint: string; observedAt: string;
} & ({ status: "empty"; rowCount: 0; ref: null } | { status: "archived"; rowCount: number; ref: TradingDateArchiveRef });

/** Explicit collection; a trading date is never converted to a synthetic instant. */
export async function collectTradingDateObservations(request: TradingDateKlineRequest, options: SourceRequestOptions = {}): Promise<TradingDateCollectionReceipt> {
  if (!request || typeof request !== "object" || request.timeMode !== "trading-date") throw new Error("Invalid trading-date collection request");
  const input = { ...request }, control = { ...options };
  control.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(control.signal);
  control.signal?.throwIfAborted();
  const response = await source.fetchKlines(input, control);
  control.signal?.throwIfAborted();
  const rows = toTradingDateBarObservations(response);
  const metadata = { source: response.source, endpoint: response.endpoint, observedAt: response.observedAt };
  if (!rows.length) return { ...metadata, status: "empty", rowCount: 0, ref: null };
  const ref = await archiveTradingDateObservations(rows, control.signal);
  return { ...metadata, status: "archived", rowCount: rows.length, ref };
}

/** Read only the requested immutable v2 revision; no provider request or fallback. */
export const replayTradingDateObservations = loadTradingDateArchive;

export type TradingLimitCollectionReceipt = {
  source: string; endpoint: string; observedAt: string;
} & ({ status: "empty"; rowCount: 0; ref: null } | { status: "archived"; rowCount: number; ref: TradingLimitArchiveRef });

export async function collectTradingLimitObservations(request: { symbol: string; startDate: string; endDate: string },
  options: SourceRequestOptions = {}): Promise<TradingLimitCollectionReceipt> {
  const { symbol, startDate, endDate } = request;
  const control = { ...options };
  control.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(control.signal);
  control.signal?.throwIfAborted();
  const response = await source.fetchDailyTradingLimits({ symbol, market: "A", start: startDate, end: endDate }, control);
  control.signal?.throwIfAborted();
  const metadata = { source: response.source, endpoint: response.endpoint, observedAt: response.observedAt };
  const [first] = response.data;
  if (!first) return { ...metadata, status: "empty", rowCount: 0, ref: null };
  if (response.source !== "tushare" || response.endpoint !== "stk_limit" || response.market !== "A") throw new Error("Invalid trading limit source");
  const rows = response.data.map(({ tradeDate, previousClose, limitUp, limitDown }) => ({ tradeDate, previousClose, limitUp, limitDown }));
  const ref = await archiveDailyTradingLimits({
    symbol: first.symbol, market: response.market, source: response.source, endpoint: response.endpoint, observedAt: response.observedAt,
    coverage: response.coverage, priceUnit: first.priceUnit, requested: { startDate, endDate }, rows,
  }, control.signal);
  return { ...metadata, status: "archived", rowCount: rows.length, ref };
}

export interface DailySignalExchangeRefs {
  tradingLimitArchiveRef: TradingLimitArchiveRef;
  rawArchiveRef?: TradingDateArchiveRef;
}

async function readExchangeInputs(
  records: readonly StoredTradingDateBarObservation[], archiveRef: TradingDateArchiveRef,
  exchange: DailySignalExchangeRefs, signal?: AbortSignal,
) {
  const rawRef = exchange.rawArchiveRef ?? archiveRef;
  const [raw, limits] = await Promise.all([
    exchange.rawArchiveRef ? replayTradingDateObservations(rawRef, signal) : records,
    loadDailyTradingLimitArchive(exchange.tradingLimitArchiveRef, signal),
  ]);
  signal?.throwIfAborted();
  const firstRaw = raw[0]!;
  const symbol = records[0]!.symbol;
  if (firstRaw.adjustment !== "none" || firstRaw.symbol !== symbol || limits.symbol !== symbol) {
    throw new Error("Exchange signals require unadjusted prices and limits for the same symbol");
  }
  return {
    tradingLimits: { ref: exchange.tradingLimitArchiveRef, ...limits },
    rawByDate: new Map(raw.map(row => [row.tradeDate, row.values])),
    limitByDate: new Map(limits.rows.map(row => [row.tradeDate, row])),
    evidence: {
      raw: { ref: rawRef, source: firstRaw.source, endpoint: firstRaw.endpoint, observedAt: firstRaw.observedAt, requested: firstRaw.requested },
      limits: { ref: exchange.tradingLimitArchiveRef, source: limits.source, endpoint: limits.endpoint, observedAt: limits.observedAt, requested: limits.requested },
    },
  };
}

export async function resolveTspArchiveIndicators(ref: TradingDateArchiveRef, signal?: AbortSignal, exchange?: DailySignalExchangeRefs) {
  const archiveRef = { ...ref };
  const exchangeRefs = exchange && {
    tradingLimitArchiveRef: { ...exchange.tradingLimitArchiveRef },
    rawArchiveRef: exchange.rawArchiveRef && { ...exchange.rawArchiveRef },
  };
  const records = await replayTradingDateObservations(archiveRef, signal);
  signal?.throwIfAborted();
  records.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const first = records[0]!; // Storage validates that the batch is nonempty and homogeneous.
  const inputs = exchangeRefs ? await readExchangeInputs(records, archiveRef, exchangeRefs, signal) : undefined;
  const bars = records.map(({ tradeDate, values }) => {
    const raw = inputs?.rawByDate.get(tradeDate);
    const limits = inputs?.limitByDate.get(tradeDate);
    return {
      date: tradeDate, ...values,
      raw_close: raw?.close, raw_high: raw?.high, raw_low: raw?.low,
      ...(limits && tspTradingLimitThresholds(limits.limitUp, limits.limitDown)),
    };
  });
  const { indicators: daily, signals } = computeTspDailyIndicatorsAndSignals(bars);

  const preview = {
    archiveRef,
    formula: { version: TSP_INDICATOR_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    input: {
      symbol: first.symbol,
      source: first.source,
      endpoint: first.endpoint,
      observedAt: first.observedAt,
      calendarTimeZone: first.calendarTimeZone,
      adjustment: first.adjustment,
      requested: first.requested,
      firstTradeDate: first.tradeDate,
      lastTradeDate: records.at(-1)!.tradeDate,
      coverage: first.coverage,
      finality: "unknown" as const,
    },
    rows: daily.map(row => ({ date: row.date, rsi6: row.rsi_6, rsi14: row.rsi_14, rsi24: row.rsi_24, atr14: row.atr_14 })),
    daily: {
      producer: "whyj" as const,
      formula: { id: "tsp_daily_ohlcv" as const, version: TSP_DAILY_INDICATOR_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
      fields: TSP_DAILY_INDICATOR_FIELDS,
      rows: daily.map(({ date, ...values }) => ({ date, values })),
    },
    dailySignals: {
      producer: "whyj" as const,
      formula: { id: "tsp_daily_signals" as const, version: TSP_DAILY_SIGNAL_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
      fields: TSP_DAILY_SIGNAL_FIELDS,
      rows: signals,
      ...(inputs && { exchangeInputs: inputs.evidence }),
    },
  };
  return { records, preview, ...(inputs && { tradingLimits: inputs.tradingLimits }) };
}

/** Calculate a preview over one immutable daily archive, seeded by its earliest bar. */
export async function deriveTspArchiveIndicators(ref: TradingDateArchiveRef, signal?: AbortSignal, exchange?: DailySignalExchangeRefs) {
  return (await resolveTspArchiveIndicators(ref, signal, exchange)).preview;
}

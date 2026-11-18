import { createTickFlowMarketDataAdapter } from "./tickflow-market-data.ts";
import { fetchTradingDateKlines } from "./trading-date-klines.ts";
import { fetchSelectedDailyBars, selectedDailyBarMarkets } from "./source-providers.ts";
import type { ProviderSource } from "./source-contracts.ts";
import type { Bar, Market, PriceAdjustment } from "../../types/data.ts";

/** Timestamps are UTC milliseconds; callers must specify the requested price basis. */
export type KlineInterval = "1d" | "1m" | "5m" | "10m" | "15m" | "30m" | "60m";
export type KlineAdjustment = "forward" | "none";
export interface TimeWindow { startTime?: number; endTime?: number }
export interface KlineRequest extends TimeWindow { symbol: string; interval: KlineInterval; adjustment: KlineAdjustment; count?: number }
/** Trading dates identify sessions, not instants or proof of historical availability. */
export interface TradingDateKlineRequest { timeMode: "trading-date"; symbol: string; assetType: "stock"; interval: "1d"; adjustment: KlineAdjustment; startDate: string; endDate: string }
export interface TradingDateKline { tradeDate: string; sourceTimestamp: number | null; open: number; high: number; low: number; close: number; volume: number; amount: number | null }
export interface TradingDateKlineResult { timeMode: "trading-date"; symbol: string; market: "A"; assetType: "stock"; calendarTimeZone: "Asia/Shanghai"; requested: { startDate: string; endDate: string }; interval: "1d"; adjustment: KlineAdjustment; source: ProviderSource; endpoint: string; observedAt: string; coverage: "unknown"; volumeUnit: "hand" | "unknown"; amountUnit: "CNY-thousand" | "unknown"; data: TradingDateKline[] }
/** Date bounds are inclusive. Omit adjustment to accept the adapter's existing daily price basis. */
export interface DailyBarsRequest { symbol: string; market: Market; start?: string; end?: string; adjustment?: PriceAdjustment }
export interface DailyBarsResult {
  symbol: string;
  market: Market;
  requested: { start: string | null; end: string | null };
  data: Bar[];
  adjustment: PriceAdjustment;
  source: ProviderSource;
  endpoint: string | null;
  observedAt: string;
  coverage: "unknown";
  volumeUnit: "hand" | "unknown";
  amountUnit: "CNY-thousand" | "unknown";
}
export interface FactorRequest extends TimeWindow { symbols: readonly string[] }
export interface QuoteRequest { symbols: readonly string[] }
export interface OrderBookRequest { symbol: string }
export interface OrderBookLevel { price: number; volume: number }
/** Levels retain provider order and zero values; their units and empty-level semantics are unknown. */
export interface OrderBook { symbol: string; timestamp: number; bids: OrderBookLevel[]; asks: OrderBookLevel[] }
export interface Kline { timestamp: number; open: number; high: number; low: number; close: number; volume: number; amount: number | null }
export interface AdjustmentFactor { timestamp: number; factor: number }
export interface Quote { symbol: string; timestamp: number; lastPrice: number; previousClose: number; open: number; high: number; low: number; volume: number; amount: number | null }
export interface ObservationResult<T> { data: T; source: ProviderSource; endpoint: string; observedAt: string; units: "unknown" }
export interface KlineResult extends ObservationResult<Kline[]> { symbol: string; interval: KlineInterval; adjustment: KlineAdjustment }
export interface QuoteResult extends ObservationResult<Quote[]> { missingSymbols: string[] }
export interface SourceRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export type FinancialKind = "income" | "balance-sheet" | "cash-flow" | "metrics" | "shares";
export interface FinancialRequest { symbols: readonly string[]; kind: FinancialKind; startDate?: string; endDate?: string; latest?: boolean }
/** Fields are canonical named values; missing values remain null, with unknown currency and units. */
export interface FinancialRecord { symbol: string; periodEnd: string; announcementDate: string | null; values: Record<string, number | null>; currency: null }
export interface QuoteSubscriptionRequest { symbols: readonly string[] }
export interface QuoteEvent { source: ProviderSource; observedAt: string; data: Quote[] }
export interface QuoteSubscription { close(): void; readonly closed: Promise<void> }
export interface QuoteSubscriptionHandlers { onQuotes(event: QuoteEvent): void; onError(error: Error): void }
export interface MarketDataSource {
  fetchKlines(request: KlineRequest, options?: SourceRequestOptions): Promise<KlineResult>;
  fetchAdjustmentFactors(request: FactorRequest, options?: SourceRequestOptions): Promise<ObservationResult<Record<string, AdjustmentFactor[]>>>;
  fetchQuotes(request: QuoteRequest, options?: SourceRequestOptions): Promise<QuoteResult>;
  fetchFinancials(request: FinancialRequest, options?: SourceRequestOptions): Promise<ObservationResult<FinancialRecord[]>>;
  subscribeQuotes(request: QuoteSubscriptionRequest, handlers: QuoteSubscriptionHandlers, options?: SourceRequestOptions): Promise<QuoteSubscription>;
}
/** Extended facade returned by the factory; existing MarketDataSource implementations remain valid. */
export interface OrderBookMarketDataSource extends MarketDataSource {
  fetchOrderBook(request: OrderBookRequest, options?: SourceRequestOptions): Promise<ObservationResult<OrderBook>>;
}
/** Factory facade adds the dated overload without changing legacy implementations. */
export interface TradingDateMarketDataSource extends OrderBookMarketDataSource {
  fetchKlines(request: TradingDateKlineRequest, options?: SourceRequestOptions): Promise<TradingDateKlineResult>;
  fetchKlines(request: KlineRequest, options?: SourceRequestOptions): Promise<KlineResult>;
}
export interface DailyBarsMarketDataSource extends TradingDateMarketDataSource {
  fetchDailyBars(request: DailyBarsRequest, options?: SourceRequestOptions): Promise<DailyBarsResult>;
}
export interface SourceConnection { source: ProviderSource; apiKey?: string; baseUrl?: string; env?: Record<string, string | undefined> }

/** Adapter implementation metadata, not a provider connectivity or entitlement check. */
export interface MarketDataCapabilities {
  source: ProviderSource;
  operations: Record<"klines" | "adjustmentFactors" | "quotes" | "financials" | "quoteSubscription", "implemented" | "not-implemented">;
  entitlement: "unknown";
  connectivity: "unknown";
}
export interface OrderBookMarketDataCapabilities extends MarketDataCapabilities {
  operations: MarketDataCapabilities["operations"] & Record<"orderBook", "implemented" | "not-implemented">;
}
export interface TradingDateMarketDataCapabilities extends OrderBookMarketDataCapabilities {
  dailyByTradingDate: { status: "implemented"; markets: ["A"]; assetTypes: ["stock"]; adjustments: KlineAdjustment[]; maxCalendarDays: 366; timeZone: "Asia/Shanghai" }
    | { status: "not-implemented" };
}
export interface DailyBarsMarketDataCapabilities extends TradingDateMarketDataCapabilities {
  dailyBars: { status: "implemented"; markets: Market[] };
}

/** Describes the selected-source facade only; legacy provider APIs have separate capabilities. */
export function getMarketDataCapabilities(source: ProviderSource): DailyBarsMarketDataCapabilities {
  const supported: Record<ProviderSource, boolean> = {
    tickflow: true, tushare: false, akshare: false, "llmquant-data": false, "financial-datasets": false,
  };
  if (!Object.hasOwn(supported, source)) {
    throw new Error("Unknown market data source");
  }
  const status = supported[source] ? "implemented" : "not-implemented";
  return { source, operations: { klines: status, adjustmentFactors: status, quotes: status, orderBook: status, financials: status, quoteSubscription: status },
    dailyBars: { status: "implemented", markets: selectedDailyBarMarkets(source) },
    dailyByTradingDate: source === "tickflow" || source === "tushare"
      ? { status: "implemented", markets: ["A"], assetTypes: ["stock"], adjustments: source === "tickflow" ? ["none", "forward"] : ["none"], maxCalendarDays: 366, timeZone: "Asia/Shanghai" }
      : { status: "not-implemented" },
    entitlement: "unknown", connectivity: "unknown" };
}

/** A selected provider only; this facade never silently falls back or reads a cache. */
export function createMarketDataSource(connection: SourceConnection): DailyBarsMarketDataSource {
  const datedConnection = { ...connection, env: connection.env ? { ...connection.env } : undefined };
  const unsupported = async (): Promise<never> => { throw new Error(`Source capability not implemented: ${connection.source}`); };
  const base: OrderBookMarketDataSource = connection.source === "tickflow" ? createTickFlowMarketDataAdapter(connection)
    : { fetchKlines: unsupported, fetchAdjustmentFactors: unsupported, fetchQuotes: unsupported, fetchOrderBook: unsupported, fetchFinancials: unsupported, subscribeQuotes: unsupported };
  function fetchKlines(request: TradingDateKlineRequest, options?: SourceRequestOptions): Promise<TradingDateKlineResult>;
  function fetchKlines(request: KlineRequest, options?: SourceRequestOptions): Promise<KlineResult>;
  function fetchKlines(request: KlineRequest | TradingDateKlineRequest, options?: SourceRequestOptions): Promise<KlineResult | TradingDateKlineResult> {
    if (request && "timeMode" in request) {
      if (request.timeMode !== "trading-date") return Promise.reject(new Error("Invalid trading-date kline request"));
      return fetchTradingDateKlines(request, datedConnection, options);
    }
    return base.fetchKlines(request, options);
  }
  return { ...base, fetchKlines, fetchDailyBars: (request, options) => fetchSelectedDailyBars(request, datedConnection, options) };
}

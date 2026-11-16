import { createTickFlowMarketDataAdapter } from "./tickflow-market-data.ts";
import type { ProviderSource } from "./source-contracts.ts";

/** Timestamps are UTC milliseconds; callers must specify the requested price basis. */
export type KlineInterval = "1d" | "1m" | "5m" | "10m" | "15m" | "30m" | "60m";
export type KlineAdjustment = "forward" | "none";
export interface TimeWindow { startTime?: number; endTime?: number }
export interface KlineRequest extends TimeWindow { symbol: string; interval: KlineInterval; adjustment: KlineAdjustment; count?: number }
export interface FactorRequest extends TimeWindow { symbols: readonly string[] }
export interface QuoteRequest { symbols: readonly string[] }
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
export interface QuoteSubscriptionHandlers { onQuotes(event: QuoteEvent): void; onError(error: Error): void }export interface MarketDataSource {
  fetchKlines(request: KlineRequest, options?: SourceRequestOptions): Promise<KlineResult>;
  fetchAdjustmentFactors(request: FactorRequest, options?: SourceRequestOptions): Promise<ObservationResult<Record<string, AdjustmentFactor[]>>>;
  fetchQuotes(request: QuoteRequest, options?: SourceRequestOptions): Promise<QuoteResult>;
  fetchFinancials(request: FinancialRequest, options?: SourceRequestOptions): Promise<ObservationResult<FinancialRecord[]>>;
  subscribeQuotes(request: QuoteSubscriptionRequest, handlers: QuoteSubscriptionHandlers, options?: SourceRequestOptions): Promise<QuoteSubscription>;
}
export interface SourceConnection { source: ProviderSource; apiKey?: string; baseUrl?: string; env?: Record<string, string | undefined> }

/** A selected provider only; this facade never silently falls back or reads a cache. */
export function createMarketDataSource(connection: SourceConnection): MarketDataSource {
  if (connection.source === "tickflow") return createTickFlowMarketDataAdapter(connection);
  const unsupported = async (): Promise<never> => { throw new Error(`Source capability not implemented: ${connection.source}`); };
  return { fetchKlines: unsupported, fetchAdjustmentFactors: unsupported, fetchQuotes: unsupported, fetchFinancials: unsupported, subscribeQuotes: unsupported };
}
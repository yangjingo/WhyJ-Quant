import { fetchTickFlowFinancials } from "./tickflow-financials.ts";
import { subscribeTickFlowQuotes } from "./tickflow-stream.ts";
import { fetchTickFlowFactors, fetchTickFlowKlines, fetchTickFlowQuotes, fetchTickFlowOrderBook } from "./tickflow.ts";
import type { MarketDataSource, SourceConnection, SourceRequestOptions } from "./market-data.ts";

/** Translate the provider-neutral Source contract to the TickFlow REST adapter. */
export function createTickFlowMarketDataAdapter(connection: SourceConnection): MarketDataSource {
  const options = (request?: SourceRequestOptions) => ({ apiKey: connection.apiKey, baseUrl: connection.baseUrl,
    env: connection.env, signal: request?.signal, timeoutMs: request?.timeoutMs });
  const metadata = (endpoint: string) => ({ source: "tickflow" as const, endpoint, observedAt: new Date().toISOString(), units: "unknown" as const });
  return {
    async fetchKlines(request, control) {
      if (!request || !["1d", "1m", "5m", "10m", "15m", "30m", "60m"].includes(request.interval)
        || !["forward", "none"].includes(request.adjustment)) throw new Error("Invalid kline request");
      const result = await fetchTickFlowKlines(request.symbol, { period: request.interval, adjustment: request.adjustment,
        startTime: request.startTime, endTime: request.endTime, count: request.count }, options(control));
      return { ...metadata("/v1/klines"), symbol: result.symbol, interval: result.period, adjustment: result.adjustment, data: result.rows };
    },
    async fetchAdjustmentFactors(request, control) {
      const data = await fetchTickFlowFactors(request.symbols, request, options(control));
      return { ...metadata("/v1/klines/ex-factors"), data };
    },
    async fetchFinancials(request, control) {
      const data = await fetchTickFlowFinancials(request, options(control));
      return { ...metadata(`/v1/financials/${request.kind}`), data };
    },
    subscribeQuotes(request, handlers, control) { return subscribeTickFlowQuotes(request, handlers, connection, control); },
    async fetchQuotes(request, control) {
      const result = await fetchTickFlowQuotes(request.symbols, options(control));
      return { ...metadata("/v1/quotes"), data: result.quotes, missingSymbols: result.missingSymbols };
    },
    async fetchOrderBook(request, control) {
      const data = await fetchTickFlowOrderBook(request?.symbol, options(control));
      return { ...metadata("/v1/depth"), data };
    },
  };
}

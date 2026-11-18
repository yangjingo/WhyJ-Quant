import { isDailyDate, validateDateRange } from "../../market/bars.ts";
import type { Market } from "../../types/data.ts";
import { fetchAkshareAIndexSpotDetailed, fetchAkshareFundNav, fetchAkshareIndexConstituents, fetchAkshareIndexInfo } from "./akshare.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";
import { ProviderBudget } from "./provider-budget.ts";
import type { ProviderSource } from "./source-contracts.ts";
import { fetchSelectedDailyBars } from "./source-providers.ts";
import { searchTushareSymbols } from "./tushare.ts";

export interface MarketReferenceResult<T> {
  source: ProviderSource;
  endpoint: string | null;
  market: "A";
  observedAt: string;
  coverage: "unknown";
  data: T[];
}
export interface InstrumentReference {
  symbol: string;
  name: string;
  exchange: "SSE" | "SZSE" | "BSE";
  assetType: "stock";
  listedOn: string | null;
}
export interface FundNavObservation {
  symbol: string;
  date: string;
  unitNav: number;
  accumulatedNav: number | null;
  adjustedNav: number | null;
  dailyReturnPct: number | null;
}
export interface IndexReference { code: string; name: string; publishedOn: string | null }
export interface IndexMemberReference {
  indexCode: string;
  code: string;
  name: string;
  includedOn: string | null;
  exchange: string | null;
  weight: number | null;
}
export interface IndexQuoteObservation {
  code: string;
  name: string;
  lastPrice: number;
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  amount: number | null;
  change: number | null;
  changePct: number | null;
  sourceDate: string | null;
  sourceTime: string | null;
  sourceTimeZone: "Asia/Shanghai" | null;
}

export interface MarketReferenceSource {
  searchInstruments(request: { market: Market; keyword: string }, options?: SourceRequestOptions): Promise<MarketReferenceResult<InstrumentReference>>;
  fetchFundNav(request: { symbol: string; market: Market; start?: string; end?: string }, options?: SourceRequestOptions): Promise<MarketReferenceResult<FundNavObservation>>;
  fetchIndexMetadata(request: { market: Market; keyword?: string; limit?: number }, options?: SourceRequestOptions): Promise<MarketReferenceResult<IndexReference>>;
  fetchIndexConstituents(request: { market: Market; code: string }, options?: SourceRequestOptions): Promise<MarketReferenceResult<IndexMemberReference>>;
  fetchIndexQuotes(request: { market: Market; codes: readonly string[] }, options?: SourceRequestOptions): Promise<MarketReferenceResult<IndexQuoteObservation>>;
}
export type MarketReferenceCapabilities = Record<keyof MarketReferenceSource,
  { status: "implemented"; markets: ["A"] } | { status: "not-implemented" }>;

const providers = {
  searchInstruments: ["tushare"],
  fetchFundNav: ["akshare", "tushare"],
  fetchIndexMetadata: ["akshare"],
  fetchIndexConstituents: ["akshare"],
  fetchIndexQuotes: ["akshare"],
} satisfies Record<keyof MarketReferenceSource, ProviderSource[]>;

function supports(operation: keyof MarketReferenceSource, source: ProviderSource): boolean {
  const sources: readonly ProviderSource[] = providers[operation];
  return sources.includes(source);
}

export function referenceCapabilities(source: ProviderSource): MarketReferenceCapabilities {
  const status = (operation: keyof MarketReferenceSource): MarketReferenceCapabilities[typeof operation] =>
    supports(operation, source) ? { status: "implemented", markets: ["A"] } : { status: "not-implemented" };
  return {
    searchInstruments: status("searchInstruments"), fetchFundNav: status("fetchFundNav"),
    fetchIndexMetadata: status("fetchIndexMetadata"), fetchIndexConstituents: status("fetchIndexConstituents"),
    fetchIndexQuotes: status("fetchIndexQuotes"),
  };
}

function dateOrNull(input: string | undefined | null): string | null {
  const date = input?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  return date && isDailyDate(date) ? date : null;
}

function instrument(code: string, name: string, listDate?: string): InstrumentReference {
  const symbol = code.toUpperCase();
  const exchange = symbol.endsWith(".SH") ? "SSE" : symbol.endsWith(".SZ") ? "SZSE" : "BSE";
  if (!/^\d{6}\.(?:SH|SZ|BJ)$/.test(symbol)) throw new Error("Provider instrument identity invalid");
  return { symbol, name, exchange, assetType: "stock", listedOn: dateOrNull(listDate) };
}

export function createMarketReferenceSource(connection: SourceConnection): MarketReferenceSource {
  const { source, apiKey, baseUrl, env } = connection;
  const validate = (operation: keyof MarketReferenceSource, market: Market) => {
    if (market !== "A" || !supports(operation, source)) throw new Error("Source reference capability not implemented for this provider and market");
  };
  const result = <T>(endpoint: string | null, data: T[], observedAt = new Date().toISOString()): MarketReferenceResult<T> =>
    ({ source, market: "A", endpoint, data, observedAt, coverage: "unknown" });
  return {
    async searchInstruments({ keyword, market }, options) {
      validate("searchInstruments", market);
      if (typeof keyword !== "string" || !keyword.trim()) throw new Error("Invalid instrument search");
      const rows = await read(options, signal => searchTushareSymbols(keyword.trim(), { token: apiKey, baseUrl, env, signal }));
      return result("stock_basic", rows.map(row => instrument(row.code, row.name, row.listDate)));
    },
    async fetchFundNav({ symbol, market, start, end }, options) {
      validate("fetchFundNav", market);
      if (typeof symbol !== "string" || !/^\d{6}(?:\.OF)?$/i.test(symbol)) throw new Error("Invalid open fund symbol");
      validateDateRange(start, end);
      const code = symbol.slice(0, 6);
      const fundSymbol = code + ".OF";
      if (source === "tushare") {
        const series = await fetchSelectedDailyBars({ symbol: fundSymbol, market, start, end, adjustment: "unit-nav" }, connection, options);
        return result(series.endpoint, series.data.map(row => ({
          symbol: fundSymbol, date: row.date, unitNav: row.close, adjustedNav: row.adjClose ?? null,
          accumulatedNav: null, dailyReturnPct: null,
        })), series.observedAt);
      }
      const series = await read(options, signal => fetchAkshareFundNav(code, signal));
      if (series.symbol !== code || series.nav.some(row => row.fundCode !== code || !isDailyDate(row.navDate) || !(row.unitNav > 0))
        || new Set(series.nav.map(row => row.navDate)).size !== series.nav.length)
        throw new Error("Provider NAV identity or observation invalid");
      if (!series.nav.length && series.attempts.length && series.attempts.every(attempt => attempt.status === "error")) throw new Error("Provider reference request failed");
      const rows = series.nav.filter(row => (!start || row.navDate >= start) && (!end || row.navDate <= end));
      return result(series.endpoint ?? null, rows.map(row => ({
        symbol: fundSymbol, date: row.navDate, unitNav: row.unitNav, accumulatedNav: row.accumulatedNav,
        adjustedNav: null, dailyReturnPct: row.dailyReturnPct,
      })).sort((a, b) => a.date.localeCompare(b.date)));
    },
    async fetchIndexMetadata({ market, keyword, limit }, options) {
      validate("fetchIndexMetadata", market);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid index metadata limit");
      const response = await read(options, signal => fetchAkshareIndexInfo(keyword, limit, signal));
      return result("index_stock_info", response.rows.map(row =>
        ({ code: row.indexCode, name: row.displayName, publishedOn: dateOrNull(row.publishDate) })));
    },
    async fetchIndexConstituents({ market, code }, options) {
      validate("fetchIndexConstituents", market);
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new Error("Invalid index code");
      const response = await read(options, signal => fetchAkshareIndexConstituents(code, undefined, signal));
      if (response.constituents.some(row => row.indexCode !== code)) throw new Error("Provider index identity mismatch");
      if (!response.source && response.attempts.length && response.attempts.every(attempt => attempt.status === "error"))
        throw new Error("Provider reference request failed");
      return result(response.source, response.constituents.map(row => ({
        indexCode: row.indexCode, code: row.stockCode, name: row.stockName,
        includedOn: dateOrNull(row.inclusionDate), exchange: row.exchange, weight: row.weight,
      })));
    },
    async fetchIndexQuotes({ market, codes }, options) {
      validate("fetchIndexQuotes", market);
      if (!Array.isArray(codes) || !codes.length || codes.some(code => typeof code !== "string" || !/^\d{6}$/.test(code))) throw new Error("Invalid index quote codes");
      const requested = [...new Set(codes)];
      const response = await read(options, signal => fetchAkshareAIndexSpotDetailed(requested, signal));
      return result(response.endpoint, response.data.filter(row => requested.includes(row.code)).map(row => ({
        code: row.code, name: row.name, lastPrice: row.price, previousClose: row.prevClose,
        open: row.open, high: row.high, low: row.low, volume: row.volume, amount: row.amount,
        change: row.change, changePct: row.changePct,
        sourceDate: dateOrNull(row.asOfDate), sourceTime: row.asOfTime ?? null,
        sourceTimeZone: row.asOfDate && row.asOfTime && response.endpoint === "sina:index-spot" ? "Asia/Shanghai" : null,
      })));
    },
  };
}

async function read<T>(options: SourceRequestOptions | undefined, operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const budget = new ProviderBudget(options?.signal, options?.timeoutMs);
  try {
    const data = await budget.run(() => operation(budget.signal));
    if (budget.exhausted) throw new Error("Provider request timed out");
    return data;
  } catch {
    options?.signal?.throwIfAborted();
    throw new Error(budget.exhausted ? "Provider request timed out" : "Provider reference request failed");
  } finally { budget.close(); }
}

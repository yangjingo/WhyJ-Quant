import { isDailyDate, validateDateRange } from "../../market/bars.ts";
import { isAIndexSymbol, normalizeSymbol } from "../../market/symbols.ts";
import type { Market } from "../../types/data.ts";
import { runPython } from "./akshare-python.ts";
import { fetchFinancialDatasetsSnapshot } from "./financial-datasets.ts";
import { fetchMainboardUniverse } from "./mainboard-universe.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { MarketDataSource, SourceConnection, SourceRequestOptions } from "./market-data.ts";
import { readReference } from "./market-reference.ts";
import type { ProviderSource } from "./source-contracts.ts";
import { fetchTushareDailyTradingLimits, fetchTushareDailyValuation } from "./tushare.ts";

export interface MarketObservation<T> {
  source: ProviderSource;
  endpoint: string;
  market: Market;
  observedAt: string;
  coverage: "unknown";
  data: T;
}
export interface PriceSnapshot {
  symbol: string;
  lastPrice: number;
  dayChange: number | null;
  dayChangePct: number | null;
  sourceTimestamp: number | null;
}
export interface DailyValuation {
  symbol: string;
  tradeDate: string;
  close: number | null;
  pe: number | null;
  peTtm: number | null;
  pb: number | null;
  totalMarketValue: number | null;
  circulatingMarketValue: number | null;
  marketValueUnit: "CNY-ten-thousand";
}
export interface DailyTradingLimit {
  symbol: string;
  tradeDate: string;
  previousClose: number | null;
  limitUp: number | null;
  limitDown: number | null;
  priceUnit: "CNY";
}
export interface TradingCalendar {
  zone: "Asia/Shanghai";
  start: string;
  end: string;
  sessions: string[];
}
export interface InstrumentUniverse {
  universe: "mainboard";
  source: "akshare";
  market: "A";
  coverage: "unknown";
  members: Awaited<ReturnType<typeof fetchMainboardUniverse>>["members"];
  sources: Awaited<ReturnType<typeof fetchMainboardUniverse>>["sources"];
}

export interface MarketObservationSource {
  fetchPriceSnapshot(request: { symbol: string; market: Market }, options?: SourceRequestOptions): Promise<MarketObservation<PriceSnapshot | null>>;
  fetchDailyValuation(request: { symbol: string; market: Market; tradeDate: string }, options?: SourceRequestOptions): Promise<MarketObservation<DailyValuation | null>>;
  fetchDailyTradingLimits(request: { symbol: string; market: Market; start: string; end: string }, options?: SourceRequestOptions): Promise<MarketObservation<DailyTradingLimit[]>>;
  fetchTradingCalendar(request: { market: Market; start: string; end: string }, options?: SourceRequestOptions): Promise<MarketObservation<TradingCalendar>>;
  fetchInstrumentUniverse(request: { market: Market; universe: "mainboard" }, options?: SourceRequestOptions): Promise<InstrumentUniverse>;
}
export type MarketObservationCapabilities = Record<keyof MarketObservationSource,
  { status: "implemented"; markets: Market[] } | { status: "not-implemented" }>;
const markets: Record<keyof MarketObservationSource, Partial<Record<ProviderSource, Market>>> = {
  fetchPriceSnapshot: { tickflow: "A", "financial-datasets": "US" },
  fetchDailyValuation: { tushare: "A" },
  fetchDailyTradingLimits: { tushare: "A" },
  fetchTradingCalendar: { akshare: "A" },
  fetchInstrumentUniverse: { akshare: "A" },
};
const CALENDAR_SCRIPT = `import json,sys,akshare as ak
start,end=sys.argv[1:]
days=ak.tool_trade_date_hist_sina()
print(json.dumps(sorted(str(x)[:10] for x in days.iloc[:,0] if start<=str(x)[:10]<=end)))`;

export function marketObservationCapabilities(source: ProviderSource): MarketObservationCapabilities {
  const status = (operation: keyof MarketObservationSource): MarketObservationCapabilities[typeof operation] => {
    const market = markets[operation][source];
    return market ? { status: "implemented", markets: [market] } : { status: "not-implemented" };
  };
  return {
    fetchPriceSnapshot: status("fetchPriceSnapshot"), fetchDailyValuation: status("fetchDailyValuation"),
    fetchDailyTradingLimits: status("fetchDailyTradingLimits"),
    fetchTradingCalendar: status("fetchTradingCalendar"), fetchInstrumentUniverse: status("fetchInstrumentUniverse"),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Provider observation field invalid");
  return value;
}

function isAStock(symbol: string): boolean {
  return !isAIndexSymbol(symbol) && /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:[48]\d{5}|92\d{4})\.BJ)$/.test(symbol);
}

export function createMarketObservationSource(connection: SourceConnection, fetchQuotes: MarketDataSource["fetchQuotes"]): MarketObservationSource {
  const { source, apiKey, baseUrl, env } = connection;
  function validate(operation: keyof MarketObservationSource, market: Market) {
    const supported = markets[operation][source];
    if (!supported || supported !== market)
      throw new SourceRequestError("unsupported", "Source observation capability not implemented for this provider and market");
  }
  const result = <T>(market: Market, endpoint: string, data: T, observedAt = new Date().toISOString()): MarketObservation<T> =>
    ({ source, endpoint, market, data, observedAt, coverage: "unknown" });
  return {
    async fetchPriceSnapshot({ symbol: input, market }, options) {
      validate("fetchPriceSnapshot", market);
      const symbol = normalizeSymbol(input, market);
      if (source === "tickflow") {
        const response = await fetchQuotes({ symbols: [symbol] }, options);
        const row = response.data[0];
        const dayChange = row && row.previousClose > 0 ? row.lastPrice - row.previousClose : null;
        return result(market, response.endpoint, row ? {
          symbol, lastPrice: row.lastPrice, dayChange,
          dayChangePct: dayChange === null ? null : nullableNumber(dayChange / row.previousClose * 100),
          sourceTimestamp: row.timestamp,
        } : null, response.observedAt);
      }
      const row = await readReference(options, signal => fetchFinancialDatasetsSnapshot(symbol, { apiKey, baseUrl, env, signal }));
      if (!Object.keys(row).length) return result(market, "/prices/snapshot", null);
      if (typeof row.ticker !== "string" || row.ticker.toUpperCase() !== symbol) throw new Error("Provider price snapshot identity mismatch");
      const price = nullableNumber(row.price), sourceTimestamp = nullableNumber(row.time_milliseconds);
      if (price === null || price <= 0 || (sourceTimestamp !== null &&
        (!Number.isSafeInteger(sourceTimestamp) || sourceTimestamp <= 0 || !Number.isFinite(new Date(sourceTimestamp).getTime()))))
        throw new Error("Provider price snapshot invalid");
      return result(market, "/prices/snapshot", {
        symbol, lastPrice: price, sourceTimestamp,
        dayChange: nullableNumber(row.day_change), dayChangePct: nullableNumber(row.day_change_percent),
      });
    },
    async fetchDailyValuation({ symbol: input, market, tradeDate }, options) {
      validate("fetchDailyValuation", market);
      const symbol = normalizeSymbol(input, market);
      if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !isAStock(symbol)) throw new Error("Invalid daily valuation request");
      const row = await readReference(options, signal => fetchTushareDailyValuation(symbol, tradeDate, { token: apiKey, baseUrl, env, signal }));
      return result(market, "daily_basic", row ? {
        symbol, tradeDate, close: nullableNumber(row.close), pe: nullableNumber(row.pe), peTtm: nullableNumber(row.pe_ttm),
        pb: nullableNumber(row.pb), totalMarketValue: nullableNumber(row.total_mv), circulatingMarketValue: nullableNumber(row.circ_mv),
        marketValueUnit: "CNY-ten-thousand" as const,
      } : null);
    },
    async fetchDailyTradingLimits({ symbol: input, market, start, end }, options) {
      validate("fetchDailyTradingLimits", market);
      const symbol = normalizeSymbol(input, market);
      if (!isAStock(symbol) || typeof start !== "string" || typeof end !== "string") throw new Error("Invalid daily trading limits request");
      validateDateRange(start, end);
      if (Date.parse(end) - Date.parse(start) > 365 * 86_400_000) throw new Error("Daily trading limits window is too large");
      const rows = await readReference(options, signal => fetchTushareDailyTradingLimits(symbol, start, end, { token: apiKey, baseUrl, env, signal }));
      const seen = new Set<string>();
      const data = rows.map(row => {
        const { tradeDate } = row;
        const previousClose = nullableNumber(row.pre_close), limitUp = nullableNumber(row.up_limit), limitDown = nullableNumber(row.down_limit);
        if (!isDailyDate(tradeDate) || tradeDate < start || tradeDate > end || seen.has(tradeDate) ||
          [previousClose, limitUp, limitDown].some(value => value !== null && value <= 0) ||
          (limitUp !== null && limitDown !== null && limitUp < limitDown)) throw new Error("Provider trading limits observation invalid");
        seen.add(tradeDate);
        return { symbol, tradeDate, previousClose, limitUp, limitDown, priceUnit: "CNY" as const };
      }).sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
      return result(market, "stk_limit", data);
    },
    async fetchTradingCalendar({ market, start, end }, options) {
      validate("fetchTradingCalendar", market);
      if (typeof start !== "string" || typeof end !== "string") throw new Error("Invalid trading calendar request");
      validateDateRange(start, end);
      const { stdout } = await readReference(options, signal => runPython(CALENDAR_SCRIPT, [start, end], { signal }));
      const sessions: unknown = JSON.parse(stdout);
      if (!Array.isArray(sessions) || sessions.some((day, i) => typeof day !== "string" || !isDailyDate(day)
        || day < start || day > end || (i > 0 && day <= sessions[i - 1]))) throw new Error("Provider trading calendar invalid");
      return result(market, "tool_trade_date_hist_sina", { zone: "Asia/Shanghai" as const, start, end, sessions });
    },
    async fetchInstrumentUniverse({ market, universe }, options) {
      validate("fetchInstrumentUniverse", market);
      if (universe !== "mainboard") throw new Error("Source instrument universe not implemented");
      const response = await readReference(options, signal => fetchMainboardUniverse({ signal }));
      return { ...response, source: "akshare", market: "A", universe, coverage: "unknown" };
    },
  };
}

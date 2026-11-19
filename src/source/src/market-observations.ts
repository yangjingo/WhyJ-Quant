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
import { fetchTushareDailyTradingLimits, fetchTushareDailyValuation, fetchTushareFinancialDisclosureDates,
  fetchTushareHistoricalUniverse, fetchTushareHistoricalMinutes, fetchTushareMarketDate, fetchTushareReportFinancialIndicators,
  fetchTushareSectorCatalog, fetchTushareSectorMembers } from "./tushare.ts";

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
export interface ReportFinancialIndicator {
  symbol: string;
  periodEnd: string;
  announcementDate: string | null;
  updateFlag: string | null;
  bookValuePerShare: number | null;
  bookValueCurrency: "unknown";
  roe: number | null;
  grossProfitMargin: number | null;
  netProfitMargin: number | null;
  operatingRevenueYoyPct: number | null;
  totalOperatingRevenueYoyPct: number | null;
  parentNetProfitYoyPct: number | null;
  debtToAssets: number | null;
  ratioUnit: "provider-native";
}
export interface FinancialDisclosureDate {
  symbol: string;
  periodEnd: string;
  planAnnouncementDate: string | null;
  plannedDisclosureDate: string | null;
  actualDisclosureDate: string | null;
  modificationRecord: string | null;
}
export interface DailyMarketBar {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  exRightsPreviousClose: number | null;
  changeCny: number | null;
  returnPct: number | null;
  volume: number | null;
  amount: number | null;
}

export interface DailyMarketBars {
  tradeDate: string;
  adjustment: "none";
  priceUnit: "CNY";
  volumeUnit: "hand";
  amountUnit: "CNY-thousand";
  rows: DailyMarketBar[];
}

export interface DailyMarketBasic {
  symbol: string;
  close: number | null;
  turnoverPct: number | null;
  freeFloatTurnoverPct: number | null;
  providerVolumeRatio: number | null;
  totalShares: number | null;
  floatShares: number | null;
  freeFloatShares: number | null;
  pe: number | null;
  peTtm: number | null;
  pb: number | null;
  totalMarketValue: number | null;
  circulatingMarketValue: number | null;
}

export interface DailyMarketBasics {
  tradeDate: string;
  priceUnit: "CNY";
  shareUnit: "ten-thousand-shares";
  marketValueUnit: "CNY-ten-thousand";
  rows: DailyMarketBasic[];
}
export interface DatedSectorCatalog {
  tradeDate: string;
  taxonomy: "eastmoney";
  kind: "concept" | "industry";
  providerType: "概念板块" | "行业板块";
  groups: { code: string; name: string; level: string | null }[];
}

export interface DatedSectorMembers {
  tradeDate: string;
  taxonomy: "eastmoney";
  sectorCode: string;
  members: { symbol: string; name: string | null }[];
}

export interface TradingCalendar {
  zone: "Asia/Shanghai";
  start: string;
  end: string;
  sessions: string[];
}
export interface HistoricalMinuteBar {
  symbol: string;
  tradeDate: string;
  /** Original Shanghai wall-clock label, including the seconds the provider supplied. */
  tradeTime: string;
  openingBoundary: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number | null;
}
export interface HistoricalMinuteObservation {
  timeZone: "Asia/Shanghai";
  interval: "1m";
  volumeUnit: "share";
  amountUnit: "CNY";
  adjustment: "unknown";
  finality: "unknown";
  requested: { start: string; end: string };
  bars: HistoricalMinuteBar[];
}
export interface InstrumentUniverse {
  universe: "mainboard";
  source: "akshare";
  market: "A";
  coverage: "unknown";
  members: Awaited<ReturnType<typeof fetchMainboardUniverse>>["members"];
  sources: Awaited<ReturnType<typeof fetchMainboardUniverse>>["sources"];
}

export interface HistoricalStockUniverse {
  universe: "provider-dated-stocks";
  tradeDate: string;
  members: {
    symbol: string;
    name: string;
    industry: string | null;
    listedOn: string | null;
  }[];
}

export interface MarketObservationSource {
  fetchPriceSnapshot(request: { symbol: string; market: Market }, options?: SourceRequestOptions): Promise<MarketObservation<PriceSnapshot | null>>;
  fetchDailyValuation(request: { symbol: string; market: Market; tradeDate: string }, options?: SourceRequestOptions): Promise<MarketObservation<DailyValuation | null>>;
  fetchDailyTradingLimits(request: { symbol: string; market: Market; start: string; end: string }, options?: SourceRequestOptions): Promise<MarketObservation<DailyTradingLimit[]>>;
  fetchReportFinancialIndicators(request: { symbol: string; market: Market; startPeriod: string; endPeriod: string }, options?: SourceRequestOptions):
    Promise<MarketObservation<ReportFinancialIndicator[]>>;
  fetchFinancialDisclosureDates(request: { symbol: string; market: Market; periodEnd: string }, options?: SourceRequestOptions):
    Promise<MarketObservation<FinancialDisclosureDate[]>>;
  fetchDailyMarketBars(request: { market: Market; tradeDate: string }, options?: SourceRequestOptions): Promise<MarketObservation<DailyMarketBars>>;
  fetchDailyMarketBasics(request: { market: Market; tradeDate: string }, options?: SourceRequestOptions): Promise<MarketObservation<DailyMarketBasics>>;
  fetchDatedSectorCatalog(request: { market: Market; tradeDate: string; kind: DatedSectorCatalog["kind"] }, options?: SourceRequestOptions):
    Promise<MarketObservation<DatedSectorCatalog>>;
  fetchDatedSectorMembers(request: { market: Market; tradeDate: string; sectorCode: string }, options?: SourceRequestOptions):
    Promise<MarketObservation<DatedSectorMembers>>;
  fetchTradingCalendar(request: { market: Market; start: string; end: string }, options?: SourceRequestOptions): Promise<MarketObservation<TradingCalendar>>;
  fetchInstrumentUniverse(request: { market: Market; universe: "mainboard" }, options?: SourceRequestOptions): Promise<InstrumentUniverse>;
  fetchHistoricalStockUniverse(request: { market: Market; tradeDate: string }, options?: SourceRequestOptions):
    Promise<MarketObservation<HistoricalStockUniverse>>;
  fetchHistoricalMinuteBars(request: { symbol: string; market: Market; start: string; end: string }, options?: SourceRequestOptions):
    Promise<MarketObservation<HistoricalMinuteObservation>>;
}
export type MarketObservationCapabilities = Record<keyof MarketObservationSource,
  { status: "implemented"; markets: Market[] } | { status: "not-implemented" }>;
const markets: Record<keyof MarketObservationSource, Partial<Record<ProviderSource, Market>>> = {
  fetchPriceSnapshot: { tickflow: "A", "financial-datasets": "US" },
  fetchDailyValuation: { tushare: "A" },
  fetchDailyTradingLimits: { tushare: "A" },
  fetchReportFinancialIndicators: { tushare: "A" },
  fetchFinancialDisclosureDates: { tushare: "A" },
  fetchDailyMarketBars: { tushare: "A" },
  fetchDailyMarketBasics: { tushare: "A" },
  fetchDatedSectorCatalog: { tushare: "A" },
  fetchDatedSectorMembers: { tushare: "A" },
  fetchTradingCalendar: { akshare: "A" },
  fetchInstrumentUniverse: { akshare: "A" },
  fetchHistoricalStockUniverse: { tushare: "A" },
  fetchHistoricalMinuteBars: { tushare: "A" },
};
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
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
    fetchReportFinancialIndicators: status("fetchReportFinancialIndicators"),
    fetchFinancialDisclosureDates: status("fetchFinancialDisclosureDates"),
    fetchDailyMarketBars: status("fetchDailyMarketBars"), fetchDailyMarketBasics: status("fetchDailyMarketBasics"),
    fetchDatedSectorCatalog: status("fetchDatedSectorCatalog"), fetchDatedSectorMembers: status("fetchDatedSectorMembers"),
    fetchTradingCalendar: status("fetchTradingCalendar"), fetchInstrumentUniverse: status("fetchInstrumentUniverse"),
    fetchHistoricalStockUniverse: status("fetchHistoricalStockUniverse"),
    fetchHistoricalMinuteBars: status("fetchHistoricalMinuteBars"),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Provider observation field invalid");
  return value;
}

function financialDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) throw new Error("Provider financial date invalid");
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (!isDailyDate(date)) throw new Error("Provider financial date invalid");
  return date;
}

function financialText(value: unknown): string | null {
  if (value === null || (typeof value === "string" && value.trim())) return value;
  throw new Error("Provider financial revision field invalid");
}

function nonnegativeObservation(value: unknown): number | null {
  const parsed = nullableNumber(value);
  if (parsed !== null && parsed < 0) throw new Error("Provider market observation field invalid");
  return parsed;
}

function isAStock(symbol: string): boolean {
  return !isAIndexSymbol(symbol) && /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:[48]\d{5}|92\d{4})\.BJ)$/.test(symbol);
}

const eastmoneySectorCode = /^BK\d{4,8}\.DC$/;

export function createMarketObservationSource(connection: SourceConnection, fetchQuotes: MarketDataSource["fetchQuotes"]): MarketObservationSource {
  const { source, apiKey, baseUrl, env } = connection;
  function validate(operation: keyof MarketObservationSource, market: Market) {
    const supported = markets[operation][source];
    if (!supported || supported !== market)
      throw new SourceRequestError("unsupported", "Source observation capability not implemented for this provider and market");
  }
  async function marketDate(endpoint: "daily" | "daily_basic", tradeDate: string, options?: SourceRequestOptions) {
    if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || tradeDate < "0001-01-01" || tradeDate > "9998-12-31") {
      throw new Error("Invalid market observation date");
    }
    const rows = await readReference(options, signal => fetchTushareMarketDate(endpoint, tradeDate, { token: apiKey, baseUrl, env, signal }));
    const seen = new Set<string>();
    return rows.map(row => {
      const symbol = row.ts_code;
      if (typeof symbol !== "string" || !isAStock(symbol) || /^899\d{3}\.BJ$/.test(symbol) || seen.has(symbol)) {
        throw new Error("Provider market observation identity invalid");
      }
      seen.add(symbol);
      return { symbol, row };
    }).sort((left, right) => left.symbol.localeCompare(right.symbol));
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
    async fetchReportFinancialIndicators({ symbol: input, market, startPeriod, endPeriod }, options) {
      validate("fetchReportFinancialIndicators", market);
      const symbol = normalizeSymbol(input, market);
      if (!isAStock(symbol) || typeof startPeriod !== "string" || typeof endPeriod !== "string") {
        throw new Error("Invalid report financial indicator request");
      }
      validateDateRange(startPeriod, endPeriod);
      const rows = await readReference(options, signal =>
        fetchTushareReportFinancialIndicators(symbol, startPeriod, endPeriod, { token: apiKey, baseUrl, env, signal }));
      const data = rows.map((row): ReportFinancialIndicator => {
        const periodEnd = financialDate(row.end_date);
        if (periodEnd === null || periodEnd < startPeriod || periodEnd > endPeriod) {
          throw new Error("Provider financial report period outside request");
        }
        return {
          symbol, periodEnd, announcementDate: financialDate(row.ann_date), updateFlag: financialText(row.update_flag),
          bookValuePerShare: nullableNumber(row.bps), bookValueCurrency: "unknown", roe: nullableNumber(row.roe),
          grossProfitMargin: nullableNumber(row.grossprofit_margin), netProfitMargin: nullableNumber(row.netprofit_margin),
          operatingRevenueYoyPct: nullableNumber(row.or_yoy), totalOperatingRevenueYoyPct: nullableNumber(row.tr_yoy),
          parentNetProfitYoyPct: nullableNumber(row.netprofit_yoy), debtToAssets: nullableNumber(row.debt_to_assets),
          ratioUnit: "provider-native",
        };
      });
      return result(market, "fina_indicator", data);
    },
    async fetchFinancialDisclosureDates({ symbol: input, market, periodEnd }, options) {
      validate("fetchFinancialDisclosureDates", market);
      const symbol = normalizeSymbol(input, market);
      if (!isAStock(symbol) || typeof periodEnd !== "string" || !isDailyDate(periodEnd)) {
        throw new Error("Invalid financial disclosure date request");
      }
      const rows = await readReference(options, signal =>
        fetchTushareFinancialDisclosureDates(symbol, periodEnd, { token: apiKey, baseUrl, env, signal }));
      const data = rows.map((row): FinancialDisclosureDate => {
        if (financialDate(row.end_date) !== periodEnd) throw new Error("Provider financial disclosure period outside request");
        return {
          symbol, periodEnd, planAnnouncementDate: financialDate(row.ann_date), plannedDisclosureDate: financialDate(row.pre_date),
          actualDisclosureDate: financialDate(row.actual_date), modificationRecord: financialText(row.modify_date),
        };
      });
      return result(market, "disclosure_date", data);
    },
    async fetchDailyMarketBars({ market, tradeDate }, options) {
      validate("fetchDailyMarketBars", market);
      const rows = (await marketDate("daily", tradeDate, options)).map(({ symbol, row }): DailyMarketBar => {
        const open = nullableNumber(row.open), high = nullableNumber(row.high), low = nullableNumber(row.low), close = nullableNumber(row.close);
        const exRightsPreviousClose = nullableNumber(row.pre_close), returnPct = nullableNumber(row.pct_chg);
        if (open === null || high === null || low === null || close === null || low <= 0 ||
          high < Math.max(open, close) || low > Math.min(open, close) ||
          (exRightsPreviousClose !== null && exRightsPreviousClose <= 0) || (returnPct !== null && returnPct < -100)) {
          throw new Error("Provider market daily bar invalid");
        }
        return { symbol, open, high, low, close, exRightsPreviousClose, returnPct, changeCny: nullableNumber(row.change),
          volume: nonnegativeObservation(row.vol), amount: nonnegativeObservation(row.amount) };
      });
      return result<DailyMarketBars>(market, "daily", { tradeDate, adjustment: "none", priceUnit: "CNY",
        volumeUnit: "hand", amountUnit: "CNY-thousand", rows });
    },
    async fetchDailyMarketBasics({ market, tradeDate }, options) {
      validate("fetchDailyMarketBasics", market);
      const rows = (await marketDate("daily_basic", tradeDate, options)).map(({ symbol, row }): DailyMarketBasic => ({
        symbol, close: nonnegativeObservation(row.close), turnoverPct: nonnegativeObservation(row.turnover_rate),
        freeFloatTurnoverPct: nonnegativeObservation(row.turnover_rate_f), providerVolumeRatio: nonnegativeObservation(row.volume_ratio),
        totalShares: nonnegativeObservation(row.total_share), floatShares: nonnegativeObservation(row.float_share),
        freeFloatShares: nonnegativeObservation(row.free_share), pe: nullableNumber(row.pe), peTtm: nullableNumber(row.pe_ttm),
        pb: nullableNumber(row.pb), totalMarketValue: nonnegativeObservation(row.total_mv),
        circulatingMarketValue: nonnegativeObservation(row.circ_mv),
      }));
      return result<DailyMarketBasics>(market, "daily_basic", { tradeDate, priceUnit: "CNY",
        shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows });
    },
    async fetchDatedSectorCatalog({ market, tradeDate, kind }, options) {
      validate("fetchDatedSectorCatalog", market);
      if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || (kind !== "concept" && kind !== "industry")) {
        throw new Error("Invalid sector catalog request");
      }
      const providerType = kind === "concept" ? "概念板块" : "行业板块";
      const rows = await readReference(options, signal => fetchTushareSectorCatalog(tradeDate, providerType, { token: apiKey, baseUrl, env, signal }));
      const compactDate = tradeDate.replaceAll("-", "");
      const seen = new Set<string>();
      const groups = rows.map(row => {
        const { ts_code: code, name, level } = row;
        if (row.trade_date !== compactDate || row.idx_type !== providerType || typeof code !== "string" || !eastmoneySectorCode.test(code) ||
          seen.has(code) || typeof name !== "string" || !name.trim() || (level !== null && typeof level !== "string")) {
          throw new Error("Provider sector catalog observation invalid");
        }
        seen.add(code);
        return { code, name: name.trim(), level: level?.trim() || null };
      }).sort((left, right) => left.code.localeCompare(right.code));
      return result<DatedSectorCatalog>(market, "dc_index", { tradeDate, taxonomy: "eastmoney", kind, providerType, groups });
    },
    async fetchDatedSectorMembers({ market, tradeDate, sectorCode: input }, options) {
      validate("fetchDatedSectorMembers", market);
      const sectorCode = typeof input === "string" ? input.trim().toUpperCase() : "";
      if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || tradeDate < "2024-12-20" || !eastmoneySectorCode.test(sectorCode)) {
        throw new Error("Invalid dated sector membership request");
      }
      const rows = await readReference(options, signal => fetchTushareSectorMembers(tradeDate, sectorCode, { token: apiKey, baseUrl, env, signal }));
      const compactDate = tradeDate.replaceAll("-", "");
      const seen = new Set<string>();
      const members = rows.map(row => {
        const { con_code: symbol, name } = row;
        if (row.trade_date !== compactDate || row.ts_code !== sectorCode || typeof symbol !== "string" || !isAStock(symbol) ||
          seen.has(symbol) || (name !== null && typeof name !== "string")) throw new Error("Provider dated sector membership invalid");
        seen.add(symbol);
        return { symbol, name: name?.trim() || null };
      }).sort((left, right) => left.symbol.localeCompare(right.symbol));
      return result<DatedSectorMembers>(market, "dc_member", { tradeDate, taxonomy: "eastmoney", sectorCode, members });
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
    async fetchHistoricalStockUniverse({ market, tradeDate }, options) {
      validate("fetchHistoricalStockUniverse", market);
      if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || tradeDate < "2016-01-01") {
        throw new Error("Invalid historical stock universe request");
      }
      const rows = await readReference(options, signal => fetchTushareHistoricalUniverse(tradeDate, { token: apiKey, baseUrl, env, signal }));
      const seen = new Set<string>();
      const members = rows.map(row => {
        const { code: symbol, name, industry, listedOn } = row;
        if (typeof symbol !== "string" || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(symbol) ||
          seen.has(symbol) || typeof name !== "string" || !name.trim() || (industry !== null && typeof industry !== "string") ||
          (listedOn !== null && (!isDailyDate(listedOn) || listedOn < "0001-01-01" || listedOn > tradeDate))) {
          throw new Error("Provider historical stock universe observation invalid");
        }
        seen.add(symbol);
        return { symbol, name: name.trim(), industry: industry?.trim() || null, listedOn };
      }).sort((left, right) => left.symbol.localeCompare(right.symbol));
      return result<HistoricalStockUniverse>(market, "bak_basic", { universe: "provider-dated-stocks", tradeDate, members });
    },
    async fetchHistoricalMinuteBars({ symbol: input, market, start, end }, options) {
      validate("fetchHistoricalMinuteBars", market);
      const symbol = normalizeSymbol(input, market);
      if (!/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(symbol) ||
        typeof start !== "string" || typeof end !== "string") throw new Error("Invalid historical minute request");
      validateDateRange(start, end);
      if (start < "2010-01-01" || end >= shanghaiDate.format() || Date.parse(end) - Date.parse(start) > 30 * 86_400_000) {
        throw new Error("Historical minute bars require a past Shanghai window of at most 31 days");
      }
      const rows = await readReference(options, signal => fetchTushareHistoricalMinutes(symbol, start, end, { token: apiKey, baseUrl, env, signal }));
      const seen = new Set<string>();
      const bars = rows.map((row): HistoricalMinuteBar => {
        const tradeTime = row.trade_time;
        if (typeof tradeTime !== "string" || !/^\d{4}-\d{2}-\d{2} (?:09:[3-5]\d|10:[0-5]\d|11:[0-2]\d|11:30|1[34]:[0-5]\d|15:00):00$/.test(tradeTime) ||
          seen.has(tradeTime)) throw new Error("Provider historical minute time invalid");
        const tradeDate = tradeTime.slice(0, 10);
        if (!isDailyDate(tradeDate) || tradeDate < start || tradeDate > end) throw new Error("Provider historical minute date invalid");
        seen.add(tradeTime);
        const open = nullableNumber(row.open), high = nullableNumber(row.high), low = nullableNumber(row.low), close = nullableNumber(row.close);
        const volume = nullableNumber(row.vol), amount = nullableNumber(row.amount);
        if (open === null || high === null || low === null || close === null || volume === null ||
          low <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close) ||
          !Number.isSafeInteger(volume) || volume < 0 || (amount !== null && amount < 0)) {
          throw new Error("Provider historical minute values invalid");
        }
        return { symbol, tradeDate, tradeTime, openingBoundary: tradeTime.endsWith("09:30:00"),
          open, high, low, close, volume, amount };
      }).sort((left, right) => left.tradeTime.localeCompare(right.tradeTime));
      return result<HistoricalMinuteObservation>(market, "stk_mins", {
        timeZone: "Asia/Shanghai", interval: "1m", volumeUnit: "share", amountUnit: "CNY",
        adjustment: "unknown", finality: "unknown", requested: { start, end }, bars,
      });
    },
  };
}

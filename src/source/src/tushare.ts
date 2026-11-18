import { isAIndexSymbol } from "../../market/symbols.ts";
import type { Bar, SymbolInfo, PriceAdjustment } from "../../types/data.ts";
import { postJson, postJsonLimited } from "./http.ts";

export const DEFAULT_TUSHARE_BASE_URL = "https://api.tushare.pro";

export interface TushareOptions {
  signal?: AbortSignal;
  token?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}

interface TushareResponse<T> {
  code: number;
  msg?: string;
  data?: {
    fields: string[];
    items: T[];
  };
}

type TusharePrimitive = string | number | null;

function token(options: TushareOptions = {}): string {
  const env = options.env ?? process.env;
  const value = options.token || env.WHYJ_QUANT_TUSHARE_TOKEN;
  if (!value) throw new Error("WHYJ_QUANT_TUSHARE_TOKEN is not configured");
  return value;
}

async function callTushare<T extends TusharePrimitive[]>(
  apiName: string,
  params: Record<string, unknown>,
  fields: string[],
  options: TushareOptions = {},
): Promise<Array<Record<string, TusharePrimitive>>> {
  const result = await postJson<TushareResponse<T>>(options.baseUrl || options.env?.TUSHARE_BASE_URL || process.env.TUSHARE_BASE_URL || DEFAULT_TUSHARE_BASE_URL, {
    api_name: apiName,
    token: token(options),
    params,
    fields: fields.join(","),
  }, {}, { signal: options.signal });
  if (result.code !== 0) {
    throw new Error(result.msg || `${apiName} failed`);
  }
  const resultFields = result.data?.fields || fields;
  const items = result.data?.items || [];
  return items.map((row) => Object.fromEntries(resultFields.map((field, index) => [field, row[index] ?? null])));
}

function formatDate(d: string): string {
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

function assertResponseSymbol(rows: Array<Record<string, TusharePrimitive>>, symbol: string): void {
  if (rows.some(row => typeof row.ts_code !== "string" || row.ts_code.toUpperCase() !== symbol.toUpperCase())) {
    throw new Error("Tushare response identity mismatch");
  }
}

function barsEndpoint(symbol: string): "fund_nav" | "index_daily" | "fund_daily" | "daily" {
  return /\.OF$/i.test(symbol) ? "fund_nav" : isAIndexSymbol(symbol) ? "index_daily"
    : /^(?:5\d{5}\.SH|1[56]\d{4}\.SZ)$/i.test(symbol) ? "fund_daily" : "daily";
}

export async function fetchFromTushareDetailed(symbol: string, start?: string, end?: string, options: TushareOptions = {}) {
  const endpoint = barsEndpoint(symbol);
  const bars = await fetchFromTushare(symbol, start, end, options);
  const adjustment: PriceAdjustment = endpoint === "fund_nav" ? "unit-nav" : endpoint === "index_daily" ? "index-level" : "unadjusted";
  return { bars, endpoint, adjustment };
}

export async function fetchFromTushare(symbol: string, start?: string, end?: string, options: TushareOptions = {}): Promise<Bar[]> {
  const dateParams = {
    ...(start ? { start_date: start.replace(/-/g, "") } : {}),
    ...(end ? { end_date: end.replace(/-/g, "") } : {}),
  };

  const endpoint = barsEndpoint(symbol);
  if (endpoint === "fund_nav") {
    const rows = await callTushare("fund_nav", { ts_code: symbol, ...dateParams }, ["ts_code", "nav_date", "unit_nav", "adj_nav"], options);
    assertResponseSymbol(rows, symbol);
    return rows.map(row => {
      const close = Number(row.unit_nav);
      return { date: formatDate(String(row.nav_date || "")), open: close, high: close, low: close, close,
        volume: 0, amount: null, ...(row.adj_nav != null ? { adjClose: Number(row.adj_nav) } : {}),
      };
    });
  }
  const rows = await callTushare(endpoint, { ts_code: symbol, ...dateParams }, DAILY_FIELDS, options);
  assertResponseSymbol(rows, symbol);
  // Bar.volume cannot represent missing data; do not turn an absent value into an observed zero.
  if (rows.some(row => (typeof row.vol !== "number" && typeof row.vol !== "string") || (typeof row.vol === "string" && !row.vol.trim())
    || !Number.isFinite(Number(row.vol)) || Number(row.vol) < 0)) throw new Error("Tushare daily volume invalid");

  return rows.map((row) => ({
    date: formatDate(String(row.trade_date || "")),
    open: Number(row.open || 0),
    high: Number(row.high || 0),
    low: Number(row.low || 0),
    close: Number(row.close || 0),
    volume: Number(row.vol),
    amount: row.amount == null ? null : Number(row.amount),
  }));
}

const DAILY_FIELDS = ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"];
const VALUATION_FIELDS = ["ts_code", "trade_date", "close", "pe", "pe_ttm", "pb", "total_mv", "circ_mv"];

export async function fetchTushareDailyValuation(symbol: string, date: string, options: TushareOptions) {
  const rows = await callTushare("daily_basic", { ts_code: symbol, trade_date: date.replace(/-/g, "") }, VALUATION_FIELDS, options);
  assertResponseSymbol(rows, symbol);
  if (rows.length > 1 || rows.some(row => formatDate(String(row.trade_date)) !== date)) throw new Error("Provider response invalid");
  return rows[0] ?? null;
}

const TRADING_LIMIT_FIELDS = ["ts_code", "trade_date", "pre_close", "up_limit", "down_limit"];

export async function fetchTushareDailyTradingLimits(symbol: string, start: string, end: string, options: TushareOptions) {
  const env = options.env ?? process.env;
  const url = new URL(options.baseUrl ?? env.TUSHARE_BASE_URL ?? DEFAULT_TUSHARE_BASE_URL);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Invalid Tushare base URL");
  const result = await postJsonLimited<TushareResponse<TusharePrimitive[]>>(url.href, {
    api_name: "stk_limit", token: token(options),
    params: { ts_code: symbol, start_date: start.replaceAll("-", ""), end_date: end.replaceAll("-", "") },
    fields: TRADING_LIMIT_FIELDS.join(","),
  }, 2 * 1024 * 1024, { signal: options.signal });
  const fields = result?.data?.fields;
  const items = result?.data?.items;
  if (result?.code !== 0 || !Array.isArray(fields) || fields.length !== TRADING_LIMIT_FIELDS.length ||
    !TRADING_LIMIT_FIELDS.every(field => fields.includes(field)) || !Array.isArray(items) || items.length > 366 ||
    items.some(row => !Array.isArray(row) || row.length !== fields.length)) throw new Error("Provider trading limits response invalid");
  const rows = items.map(row => Object.fromEntries(fields.map((field, i) => [field, row[i]!])));
  assertResponseSymbol(rows, symbol);
  return rows.map(row => {
    if (typeof row.trade_date !== "string" || !/^\d{8}$/.test(row.trade_date)) throw new Error("Provider trading limit date invalid");
    return { tradeDate: formatDate(row.trade_date), pre_close: row.pre_close, up_limit: row.up_limit, down_limit: row.down_limit };
  });
}

export async function searchTushareSymbols(keyword: string, options: TushareOptions = {}): Promise<SymbolInfo[]> {
  const rows = await callTushare(
    "stock_basic",
    { name: keyword, list_status: "L" },
    ["ts_code", "name", "area", "industry", "market", "list_date"],
    options,
  );
  return rows.map((row) => ({
    code: String(row.ts_code || ""),
    name: String(row.name || row.ts_code || ""),
    market: "A",
    exchange: String(row.ts_code || "").endsWith(".SH") ? "SSE" : "SZSE",
    type: "stock",
    listDate: String(row.list_date || ""),
  }));
}

export async function fetchTushareSnapshot(symbol: string, options: TushareOptions = {}): Promise<Record<string, unknown>> {
  const rows = await callTushare(
    "daily_basic",
    { ts_code: symbol },
    VALUATION_FIELDS,
    options,
  );
  assertResponseSymbol(rows, symbol);
  return rows[0] || {};
}

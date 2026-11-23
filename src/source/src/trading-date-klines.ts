import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol } from "../../market/symbols.ts";
import { postJsonLimited } from "./http.ts";
import { fetchTickFlowKlines } from "./tickflow.ts";
import type { SourceConnection, SourceRequestOptions, TradingDateKline, TradingDateKlineRequest, TradingDateKlineResult } from "./market-data.ts";

const DAY = 86_400_000;
const invalid = () => new Error("Invalid trading-date kline request");
const badResponse = () => new Error("Provider response invalid");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const shanghai = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function parts(ms: number): Record<string, string> { return Object.fromEntries(shanghai.formatToParts(ms).map(part => [part.type, part.value])); }
function tradingDate(ms: number): string { const p = parts(ms); return `${p.year!.padStart(4, "0")}-${p.month}-${p.day}`; }
/** Resolve a Shanghai local midnight using timezone data, including historical offset changes. */
function localMidnight(date: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`); let result = utc;
  for (let i = 0; i < 3; i++) {
    const p = parts(result);
    const represented = Date.parse(`${p.year!.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    result += utc - represented;
  }
  const p = parts(result);
  if (tradingDate(result) !== date || p.hour !== "00" || p.minute !== "00" || p.second !== "00") throw invalid();
  return result;
}
function nextDate(date: string): string { return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10); }
function validate(request: TradingDateKlineRequest, options?: SourceRequestOptions): void {
  if (!request || typeof request !== "object" || Object.keys(request).sort().join(",") !== "adjustment,assetType,endDate,interval,startDate,symbol,timeMode"
    || request.timeMode !== "trading-date" || request.assetType !== "stock" || request.interval !== "1d" || !["none", "forward"].includes(request.adjustment)
    || typeof request.symbol !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(request.symbol) || isAIndexSymbol(request.symbol)
    || !(/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(request.symbol))
    || typeof request.startDate !== "string" || typeof request.endDate !== "string" || !isDailyDate(request.startDate) || !isDailyDate(request.endDate)
    || request.startDate < "0001-01-01" || request.startDate > request.endDate || request.endDate > "9998-12-31" || Date.parse(request.endDate) - Date.parse(request.startDate) > 365 * DAY
    || (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000))) throw invalid();
}
function validateRows<T extends TradingDateKline>(rows: T[], request: Pick<TradingDateKlineRequest, "startDate" | "endDate">): T[] {
  if (rows.length > 366) throw badResponse();
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isDailyDate(r.tradeDate) || r.tradeDate < request.startDate || r.tradeDate > request.endDate || seen.has(r.tradeDate)
      || ![r.open, r.high, r.low, r.close, r.volume].every(finite) || Math.min(r.open, r.high, r.low, r.close) <= 0 || r.volume < 0
      || r.high < Math.max(r.open, r.low, r.close) || r.low > Math.min(r.open, r.close)
      || (r.amount !== null && (!finite(r.amount) || r.amount < 0))) throw badResponse();
    seen.add(r.tradeDate);
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

export async function fetchTickFlowTradingDateRows(request: Pick<TradingDateKlineRequest, "symbol" | "startDate" | "endDate" | "adjustment">,
  connection: SourceConnection, options?: SourceRequestOptions) {
  const result = await fetchTickFlowKlines(request.symbol, { period: "1d", adjustment: request.adjustment,
    startTime: localMidnight(request.startDate), endTime: localMidnight(nextDate(request.endDate)) - 1 },
    { apiKey: connection.apiKey, baseUrl: connection.baseUrl, env: connection.env, signal: options?.signal, timeoutMs: options?.timeoutMs });
  return validateRows(result.rows.map(({ timestamp, ...row }) => ({ tradeDate: tradingDate(timestamp), sourceTimestamp: timestamp, ...row })), request);
}

export async function fetchTushareTradingDateRows(
  request: Pick<TradingDateKlineRequest, "symbol" | "startDate" | "endDate" | "adjustment">,
  endpoint: "daily" | "fund_daily",
  connection: SourceConnection,
  options?: SourceRequestOptions,
): Promise<TradingDateKline[]> {
  if (request.adjustment !== "none") throw new Error("Source capability not implemented: tushare forward-adjusted daily bars");
  options?.signal?.throwIfAborted();
  const env = connection.env ?? process.env, key = connection.apiKey ?? env.WHYJ_QUANT_TUSHARE_TOKEN;
  if (typeof key !== "string" || !key.trim()) throw new Error("WHYJ_QUANT_TUSHARE_TOKEN is not configured");
  let url: URL;
  try { url = new URL(connection.baseUrl ?? env.TUSHARE_BASE_URL ?? "https://api.tushare.pro"); }
  catch { throw new Error("Invalid Tushare base URL"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Invalid Tushare base URL");
  let payload: unknown;
  try {
    payload = await postJsonLimited(url.href, { api_name: endpoint, token: key, params: { ts_code: request.symbol,
      start_date: request.startDate.replaceAll("-", ""), end_date: request.endDate.replaceAll("-", "") },
      fields: "ts_code,trade_date,open,high,low,close,vol,amount" }, 2 * 1024 * 1024, options);
  } catch (error) {
    options?.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : "", status = /\bHTTP ([1-5]\d{2})\b/.exec(message)?.[1];
    throw new Error(status ? `HTTP ${status}` : /timed out/i.test(message) ? "Provider request timed out" : /truncated/.test(message) ? "Provider response truncated" : "Provider response invalid or unavailable");
  }
  if (!record(payload) || payload.code !== 0 || !record(payload.data) || !Array.isArray(payload.data.fields) || !Array.isArray(payload.data.items)) throw badResponse();
  const fields = payload.data.fields, required = ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"];
  if (fields.length !== required.length || new Set(fields).size !== required.length || required.some(field => !fields.includes(field)) || payload.data.items.length > 366) throw badResponse();
  const rows = payload.data.items.map(item => {
    if (!Array.isArray(item) || item.length !== fields.length) throw badResponse();
    const row = Object.fromEntries(fields.map((field, i) => [field, item[i]]));
    if (row.ts_code !== request.symbol || typeof row.trade_date !== "string" || !/^\d{8}$/.test(row.trade_date)) throw badResponse();
    return { tradeDate: `${row.trade_date.slice(0, 4)}-${row.trade_date.slice(4, 6)}-${row.trade_date.slice(6, 8)}`,
      sourceTimestamp: null, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.vol, amount: row.amount } as TradingDateKline;
  });
  return validateRows(rows, request);
}

/** This mode preserves session date separately from any provider timestamp. */
export async function fetchTradingDateKlines(request: TradingDateKlineRequest, connection: SourceConnection, options?: SourceRequestOptions): Promise<TradingDateKlineResult> {
  const input = { ...request }, selected = { ...connection, env: connection.env ? { ...connection.env } : undefined }, control = options ? { ...options } : undefined;
  validate(input, control);
  control?.signal?.throwIfAborted();
  if (selected.source !== "tickflow" && selected.source !== "tushare") throw new Error(`Source capability not implemented: ${selected.source}`);
  const data = selected.source === "tushare" ? await fetchTushareTradingDateRows(input, "daily", selected, control)
    : await fetchTickFlowTradingDateRows(input, selected, control);
  control?.signal?.throwIfAborted();
  return { timeMode: "trading-date", symbol: input.symbol, market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
    requested: { startDate: input.startDate, endDate: input.endDate }, interval: "1d", adjustment: input.adjustment, source: selected.source,
    endpoint: selected.source === "tushare" ? "daily" : "/v1/klines", observedAt: new Date().toISOString(), coverage: "unknown",
    volumeUnit: selected.source === "tushare" ? "hand" : "unknown", amountUnit: selected.source === "tushare" ? "CNY-thousand" : "unknown", data };
}

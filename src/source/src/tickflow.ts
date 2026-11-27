import { validateDateRange } from "../../market/bars.ts";
import { isAIndexSymbol, normalizeSymbol } from "../../market/symbols.ts";
import type { Bar, PriceAdjustment } from "../../types/data.ts";
import { getText } from "./http.ts";
import type { OrderBook, OrderBookLevel, Quote } from "./market-data.ts";

export const DEFAULT_TICKFLOW_BASE_URL = "https://api.tickflow.org";
export const TICKFLOW_SYMBOL_BATCH_SIZE = 100;
export interface TickFlowOptions {
  apiKey?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type TickFlowPeriod = "1d" | "1m" | "5m" | "10m" | "15m" | "30m" | "60m";
export type TickFlowAdjustment = "forward" | "none";
export interface TickFlowWindow { startTime?: number; endTime?: number }
export interface TickFlowKlineRequest extends TickFlowWindow {
  period?: TickFlowPeriod;
  count?: number;
  adjustment?: TickFlowAdjustment;
}
export interface TickFlowKline extends Omit<Bar, "date" | "adjClose"> { timestamp: number }
export interface TickFlowKlines {
  symbol: string;
  period: TickFlowPeriod;
  adjustment: TickFlowAdjustment;
  rows: TickFlowKline[];
}
export interface TickFlowFactor { timestamp: number; factor: number }

const MAX_BYTES = 8 * 1024 * 1024, MAX_ROWS = 10_000;
const invalid = () => new Error("Provider response invalid");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): value is number => number(value) && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
function nativeSymbol(input: string): string {
  const symbol = normalizeSymbol(input, "A");
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) throw new Error("TickFlow adapter supports SH/SZ/BJ instruments only");
  return symbol;
}
export function symbolsFor(inputs: readonly string[]): string[] {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > TICKFLOW_SYMBOL_BATCH_SIZE) throw new Error("TickFlow requires 1 to 100 symbols");
  return [...new Set(inputs.map(nativeSymbol))];
}
function timeQuery(window: TickFlowWindow): Record<string, string> {
  if ((window.startTime !== undefined && !timestamp(window.startTime)) || (window.endTime !== undefined && !timestamp(window.endTime))
    || (window.startTime !== undefined && window.endTime !== undefined && window.startTime > window.endTime)) throw new Error("Invalid TickFlow time window");
  return { ...(window.startTime === undefined ? {} : { start_time: String(window.startTime) }),
    ...(window.endTime === undefined ? {} : { end_time: String(window.endTime) }) };
}
function inWindow(time: number, window: TickFlowWindow): boolean {
  return (window.startTime === undefined || time >= window.startTime) && (window.endTime === undefined || time <= window.endTime);
}
function identity(value: Record<string, unknown>, symbol: string): void {
  if (value.symbol !== undefined && value.symbol !== symbol) throw new Error("Provider identity mismatch");
}

export async function request(path: string, query: Record<string, string>, options: TickFlowOptions): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const key = options.apiKey ?? env.WHYJ_QUANT_TICKFLOW_API_KEY;
  if (!key?.trim()) throw new Error("WHYJ_QUANT_TICKFLOW_API_KEY is not configured");
  let base: URL;
  try { base = new URL(options.baseUrl ?? env.TICKFLOW_BASE_URL ?? DEFAULT_TICKFLOW_BASE_URL); }
  catch { throw new Error("Invalid TickFlow base URL"); }
  if (base.username || base.password || base.search || base.hash
    || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))))
    throw new Error("Invalid TickFlow base URL");
  try {
    const text = await getText(`${base.href.replace(/\/$/, "")}${path}?${new URLSearchParams(query)}`, MAX_BYTES,
      { signal: options.signal, timeoutMs: options.timeoutMs, redirect: "error" }, { "x-api-key": key });
    const payload: unknown = JSON.parse(text);
    if (!record(payload) || !record(payload.data) && !Array.isArray(payload.data)) throw invalid();
    return payload;
  } catch (error) {
    options.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : "";
    const status = /\bHTTP ([1-5]\d{2})\b/.exec(message)?.[1];
    // Never export provider bodies, URLs, credentials or arbitrary transport exceptions.
    throw new Error(status ? `HTTP ${status}` : /timed out/i.test(message) ? "Provider request timed out"
      : /response truncated/.test(message) ? "Provider response truncated" : "Provider response invalid or unavailable");
  }
}

/** Exact compact-column response mapped to timestamped observations; no calendar/finality inference. */
export async function fetchTickFlowKlines(input: string, query: TickFlowKlineRequest = {}, options: TickFlowOptions = {}): Promise<TickFlowKlines> {
  const symbol = nativeSymbol(input), period = query.period ?? "1d", adjustment = query.adjustment ?? "forward";
  const count = query.count ?? (query.startTime !== undefined || query.endTime !== undefined ? MAX_ROWS : 100);
  if (!["1d", "1m", "5m", "10m", "15m", "30m", "60m"].includes(period) || !["forward", "none"].includes(adjustment)
    || !Number.isSafeInteger(count) || count < 1 || count > MAX_ROWS) throw new Error("Invalid TickFlow kline request");
  const payload = await request("/v1/klines", { symbol, period, adjust: adjustment, count: String(count), ...timeQuery(query) }, options);
  identity(payload, symbol);
  return { symbol, period, adjustment, rows: compactKlines(payload.data, symbol, count, query) };
}

function compactKlines(data: unknown, symbol: string, count: number, window: TickFlowWindow = {}): TickFlowKline[] {
  if (!record(data) || !Array.isArray(data.timestamp) || data.timestamp.length > count) throw invalid();
  identity(data, symbol);
  const times = data.timestamp;
  if ((window.startTime !== undefined || window.endTime !== undefined) && times.length === count) throw new Error("Provider response truncated");
  for (const field of ["open", "high", "low", "close", "volume", ...(data.amount === undefined ? [] : ["amount"])])
    if (!Array.isArray(data[field]) || data[field].length !== times.length) throw invalid();
  const rows = times.map((time, index) => {
    if (!timestamp(time) || !inWindow(time, window)) throw invalid();
    const values = ["open", "high", "low", "close", "volume"].map(field => (data[field] as unknown[])[index]);
    if (!values.every(number)) throw invalid();
    const [open, high, low, close, volume] = values as number[];
    const amount = data.amount === undefined ? null : (data.amount as unknown[])[index];
    if (Math.min(open!, high!, low!, close!) <= 0 || high! < Math.max(open!, low!, close!) || low! > Math.min(open!, close!)
      || volume! < 0 || (amount !== null && (!number(amount) || amount < 0))) throw invalid();
    return { timestamp: time, open: open!, high: high!, low: low!, close: close!, volume: volume!, amount } as TickFlowKline;
  }).sort((a, b) => a.timestamp - b.timestamp);
  if (new Set(times).size !== times.length) throw invalid();
  return rows;
}

/** Latest-session compact frames use their enclosing symbol key. */
export async function fetchTickFlowIntradayBatch(inputs: readonly string[], options: TickFlowOptions = {}) {
  const symbols = symbolsFor(inputs);
  const rowLimitPerSymbol = 300;
  const payload = await request("/v1/klines/intraday/batch", { symbols: symbols.join(","), period: "1m", count: String(rowLimitPerSymbol) }, options);
  const data = payload.data;
  if (!record(data) || Object.keys(data).some(symbol => !symbols.includes(symbol))) throw invalid();
  return {
    rowLimitPerSymbol,
    rowsBySymbol: new Map(Object.entries(data).map(([symbol, frame]) => [symbol, compactKlines(frame, symbol, rowLimitPerSymbol)])),
  };
}

/** Daily facade for the shared provider/cache pipeline. Minute rows never enter a daily cache. */
export async function fetchFromTickFlowDetailed(symbol: string, start?: string, end?: string, options: TickFlowOptions = {}): Promise<{ bars: Bar[]; endpoint: string; adjustment: PriceAdjustment }> {
  validateDateRange(start, end);
  const result = await fetchTickFlowKlines(symbol, { period: "1d", adjustment: "forward", count: start || end ? MAX_ROWS : 30,
    ...(start ? { startTime: Date.parse(`${start}T00:00:00+08:00`) } : {}),
    ...(end ? { endTime: Date.parse(`${end}T23:59:59.999+08:00`) } : {}) }, options);
  const bars = result.rows.map(({ timestamp: time, ...bar }) => ({ date: new Date(time + 8 * 3600_000).toISOString().slice(0, 10), ...bar }));
  if (new Set(bars.map(bar => bar.date)).size !== bars.length) throw invalid();
  return { bars, endpoint: "tickflow_daily_forward", adjustment: isAIndexSymbol(result.symbol) ? "index-level" : "forward-adjusted" };
}

export async function fetchTickFlowFactors(inputs: readonly string[], window: TickFlowWindow = {}, options: TickFlowOptions = {}): Promise<Record<string, TickFlowFactor[]>> {
  const symbols = symbolsFor(inputs), payload = await request("/v1/klines/ex-factors", { symbols: symbols.join(","), ...timeQuery(window) }, options);
  if (!record(payload.data)) throw invalid();
  const data = payload.data, result: Record<string, TickFlowFactor[]> = {};
  if (Object.keys(data).some(symbol => !symbols.includes(symbol))) throw new Error("Provider identity mismatch");
  for (const symbol of symbols) {
    const rows = data[symbol];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw invalid();
    result[symbol] = rows.map(row => {
      if (!record(row) || !timestamp(row.timestamp) || !inWindow(row.timestamp, window) || !number(row.ex_factor) || row.ex_factor <= 0) throw invalid();
      return { timestamp: row.timestamp, factor: row.ex_factor };
    }).sort((a, b) => a.timestamp - b.timestamp);
    if (new Set(result[symbol]!.map(row => row.timestamp)).size !== rows.length) throw invalid();
  }
  return result;
}

export function tickFlowReportedQuoteMetrics(ext: unknown):
  Pick<Quote, "reportedChangeAmount" | "reportedChangeFraction" | "reportedAmplitudeFraction" | "reportedTurnoverFraction"> {
  if (!record(ext)) return {};
  const { change_amount: amount, change_pct: change, amplitude, turnover_rate: turnover } = ext;
  return {
    ...(number(amount) ? { reportedChangeAmount: amount } : {}),
    ...(number(change) ? { reportedChangeFraction: change } : {}),
    ...(number(amplitude) && amplitude >= 0 ? { reportedAmplitudeFraction: amplitude } : {}),
    ...(number(turnover) && turnover >= 0 ? { reportedTurnoverFraction: turnover } : {}),
  };
}

/** A snapshot retains its source timestamp; an old tick is not relabeled as a current quote. */
export async function fetchTickFlowQuotes(inputs: readonly string[], options: TickFlowOptions = {}): Promise<{ quotes: Quote[]; missingSymbols: string[] }> {
  const symbols = symbolsFor(inputs), payload = await request("/v1/quotes", { symbols: symbols.join(",") }, options);
  if (!Array.isArray(payload.data) || payload.data.length > symbols.length) throw invalid();
  const seen = new Set<string>();
  const quotes = payload.data.map(row => {
    if (!record(row) || typeof row.symbol !== "string" || !symbols.includes(row.symbol) || row.region !== "CN") throw new Error("Provider identity mismatch");
    if (seen.has(row.symbol) || !timestamp(row.timestamp)) throw invalid();
    seen.add(row.symbol);
    if (![row.last_price, row.prev_close, row.open, row.high, row.low, row.volume].every(value => number(value) && value >= 0)
      || row.amount !== null && (!number(row.amount) || row.amount < 0)) throw invalid();
    return { symbol: row.symbol, timestamp: row.timestamp, lastPrice: row.last_price as number, previousClose: row.prev_close as number,
      open: row.open as number, high: row.high as number, low: row.low as number, volume: row.volume as number, amount: row.amount as number | null,
      ...tickFlowReportedQuoteMetrics(row.ext) };
  });
  return { quotes, missingSymbols: symbols.filter(symbol => !seen.has(symbol)) };
}

function orderBook(symbol: string, row: unknown): OrderBook {
  if (!record(row) || row.symbol !== symbol || row.region !== "CN") throw new Error("Provider identity mismatch");
  if (!timestamp(row.timestamp)) throw invalid();
  const levels = (prices: unknown, volumes: unknown, descending: boolean): OrderBookLevel[] => {
    if (!Array.isArray(prices) || !Array.isArray(volumes) || prices.length !== volumes.length || prices.length > 5) throw invalid();
    let previous: number | undefined;
    return prices.map((price, i) => {
      const volume = volumes[i];
      if (!number(price) || price < 0 || !number(volume) || !Number.isSafeInteger(volume) || volume < 0) throw invalid();
      if (price > 0) {
        if (previous !== undefined && (descending ? price > previous : price < previous)) throw invalid();
        previous = price;
      }
      return { price, volume };
    });
  };
  return { symbol, timestamp: row.timestamp, bids: levels(row.bid_prices, row.bid_volumes, true), asks: levels(row.ask_prices, row.ask_volumes, false) };
}

/** Preserve each reported level, including zero values, without inferring volume units. */
export async function fetchTickFlowOrderBook(input: string, options: TickFlowOptions = {}): Promise<OrderBook> {
  if (typeof input !== "string") throw new Error("Invalid order book request");
  const symbol = nativeSymbol(input), payload = await request("/v1/depth", { symbol }, options);
  return orderBook(symbol, payload.data);
}

/** Read one native batch and keep missing requested identities explicit. */
export async function fetchTickFlowOrderBookBatch(inputs: readonly string[], options: TickFlowOptions = {}) {
  const requestedSymbols = symbolsFor(inputs);
  const payload = await request("/v1/depth/batch", { symbols: requestedSymbols.join(",") }, options);
  if (!record(payload.data)) throw invalid();
  const wanted = new Set(requestedSymbols);
  const books = new Map<string, OrderBook>();
  for (const [symbol, row] of Object.entries(payload.data)) {
    if (!wanted.has(symbol)) throw new Error("Provider identity mismatch");
    books.set(symbol, orderBook(symbol, row));
  }
  return { requestedSymbols, books: requestedSymbols.flatMap(symbol => {
    const book = books.get(symbol);
    return book ? [book] : [];
  }), missingSymbols: requestedSymbols.filter(symbol => !books.has(symbol)) };
}

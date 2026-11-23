import type { Market } from "../types/data.ts";

export interface MarketSymbol {
  code: string;
  name?: string;
}

export function baseCode(symbol: string): string {
  const text = symbol.trim();
  return text.replace(/\.(SH|SZ|BJ|OF|HK)$/i, "");
}

export function isMarketSymbol(symbol: string): boolean {
  return /^(?:\d{6}(?:\.(?:SH|SZ|BJ|OF))?|\d{4,5}\.HK|[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*)$/i.test(symbol);
}

/** Keep exchange and instrument identity intact across provider and cache keys. */
export function normalizeSymbol(symbol: string, market: Market = inferMarket(symbol)): string {
  const text = symbol.trim().toUpperCase();
  if (!isMarketSymbol(text)) throw new Error(`Invalid market symbol: ${symbol}`);
  const normalized = market !== "A" || !/^\d{6}$/.test(text) ? text
    : /^[56]/.test(text) ? `${text}.SH` : /^[48]/.test(text) ? `${text}.BJ` : `${text}.SZ`;
  if (inferMarket(normalized) !== market) throw new Error(`Symbol ${normalized} does not match market ${market}.`);
  return normalized;
}

export function inferMarket(symbol: string): Market {
  const text = symbol.trim();
  if (/\.HK$/i.test(text)) return "HK";
  if (/^[A-Z][A-Z0-9.-]*$/i.test(text) && !/^\d{6}/.test(text)) return "US";
  return "A";
}

export function isAIndexSymbol(symbol: string): boolean {
  return /^(?:000\d{3}\.SH|399\d{3}(?:\.SZ)?|000300)$/i.test(symbol.trim());
}

/** Dated benchmark archives use an exact exchange-qualified identity. */
export function isDatedBenchmarkIndexSymbol(symbol: string): boolean {
  return /^(?:000\d{3}\.SH|399\d{3}\.SZ|899050\.BJ)$/.test(symbol);
}

/** Trading code ranges for Shanghai and Shenzhen ETF requests. Listing status is separate. */
export function isDatedEtfSymbol(symbol: string): boolean {
  return symbol !== "159900.SZ" &&
    /^(?:(?:51[0-35-8]|526|530|551|56[0-35-7]|58[1789])\d{3}\.SH|520[5-9]\d{2}\.SH|15[89]\d{3}\.SZ)$/.test(symbol);
}

import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_AUCTION_PERFORMANCE_FORMULA_VERSION = 1;
const HIGH_OPEN_PCT = 5;
const STOCK_SYMBOL = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

export interface TspAuctionPerformanceInput {
  calendar: { revision: string; tradeDate: string; previousTradeDate: string | null; nextTradeDate: string | null };
  priceBasis: "none";
  watchlist: readonly { symbol: string; auctionReturnPct: number | null }[];
  prices: readonly { symbol: string; tradeDate: string; open: number | null; close: number | null }[];
}

function priceChange(end: number | null | undefined, start: number | null | undefined): number | null {
  if (end == null || start == null) return null;
  const change = end / start - 1;
  if (!Number.isFinite(change)) throw new Error("Auction price change is out of range");
  return change;
}

/** Evaluate the pinned auction watchlist metrics against explicitly identified neighboring sessions. */
export function computeTspAuctionPerformance(input: TspAuctionPerformanceInput) {
  const { calendar, priceBasis, prices, watchlist } = input;
  const { revision, tradeDate, previousTradeDate, nextTradeDate } = calendar;
  if (typeof revision !== "string" || !revision.trim() || !isDailyDate(tradeDate)
    || (previousTradeDate !== null && (!isDailyDate(previousTradeDate) || previousTradeDate >= tradeDate))
    || (nextTradeDate !== null && (!isDailyDate(nextTradeDate) || nextTradeDate <= tradeDate))) {
    throw new Error("Invalid auction session calendar");
  }
  if (priceBasis !== "none") throw new Error("Auction performance requires unadjusted prices");

  const symbols = new Set<string>();
  for (const { symbol, auctionReturnPct } of watchlist) {
    if (!STOCK_SYMBOL.test(symbol) || symbols.has(symbol)
      || (auctionReturnPct !== null && !Number.isFinite(auctionReturnPct))) throw new Error("Invalid or duplicate auction watchlist row");
    symbols.add(symbol);
  }

  const sessions = new Set([previousTradeDate, tradeDate, nextTradeDate].filter((date): date is string => date !== null));
  const bySession = new Map<string, TspAuctionPerformanceInput["prices"][number]>();
  for (const price of prices) {
    const key = `${price.tradeDate}/${price.symbol}`;
    if (!STOCK_SYMBOL.test(price.symbol) || !sessions.has(price.tradeDate) || bySession.has(key)
      || [price.open, price.close].some(value => value !== null && (!Number.isFinite(value) || value <= 0))) {
      throw new Error("Invalid or duplicate auction price evidence");
    }
    bySession.set(key, price);
  }

  const rows = watchlist.map(({ symbol, auctionReturnPct }) => {
    const current = bySession.get(`${tradeDate}/${symbol}`);
    const previous = previousTradeDate === null ? null : bySession.get(`${previousTradeDate}/${symbol}`);
    const next = nextTradeDate === null ? null : bySession.get(`${nextTradeDate}/${symbol}`);
    return {
      symbol,
      openToClose: priceChange(current?.close, current?.open),
      previousCloseToClose: priceChange(current?.close, previous?.close),
      closeToNextClose: priceChange(next?.close, current?.close),
      highOpenFlag: auctionReturnPct === null ? null : auctionReturnPct >= HIGH_OPEN_PCT,
    };
  });
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_auction_performance" as const, version: TSP_AUCTION_PERFORMANCE_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    calendar: { ...calendar },
    priceBasis,
    returnUnit: "fraction" as const,
    highOpenThresholdPct: HIGH_OPEN_PCT,
    rows,
  };
}

import { TICKFLOW_SYMBOL_BATCH_SIZE, type SourceRequestOptions } from "../../source/index.ts";
import { loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";
import { archivedListLiquidity } from "./list-liquidity.ts";
import { deriveTspArchiveIndicators, type DailySignalExchangeRefs } from "./observation-collection.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface TspListRowsRequest {
  marketRef: MarketCrossSectionArchiveRef;
  adjustment: "none" | "forward";
  stocks: readonly { symbol: string; history?: { ref: TradingDateArchiveRef; exchange?: DailySignalExchangeRefs } }[];
}

/** Join fixed market observations and same-day WHYJ calculations for either stock list. */
export async function replayTspListRows(request: TspListRowsRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { marketRef, adjustment, stocks } = structuredClone(request);
  if (adjustment !== "none" && adjustment !== "forward") throw new Error("Invalid list price basis");
  const { source, market, tradeDate, universe, bars, basics } = await loadMarketCrossSectionArchive(marketRef, signal);
  const { members, ...rosterObservation } = universe;
  const { rows: barRows, ...dailyObservation } = bars;
  const { rows: basicRows, ...dailyBasicObservation } = basics;
  const roster = new Map(members.map(member => [member.symbol, member]));
  const symbols = stocks.map(stock => stock.symbol);
  if (new Set(symbols).size !== symbols.length || symbols.some(symbol => !roster.has(symbol))) {
    throw new Error("Duplicate list symbol or symbol absent from the archived roster");
  }
  const barsBySymbol = new Map(barRows.map(row => [row.symbol, row]));
  const basicsBySymbol = new Map(basicRows.map(row => [row.symbol, row]));
  const rows = [];
  for (const { symbol, history } of stocks) {
    signal?.throwIfAborted();
    const bar = barsBySymbol.get(symbol) ?? null;
    const basic = basicsBySymbol.get(symbol) ?? null;
    const { volumeShares, metrics: liquidity } = archivedListLiquidity(bar, basic);
    const amountCny = bar?.amount != null ? bar.amount * 1_000 : null;
    if (amountCny !== null && !Number.isFinite(amountCny)) throw new Error("List traded amount overflow");
    const derived = history ? await deriveTspArchiveIndicators(history.ref, signal, history.exchange) : null;
    if (derived && (derived.input.symbol !== symbol || derived.input.adjustment !== adjustment ||
      derived.input.lastTradeDate > tradeDate)) throw new Error("List history has a mismatched symbol, price basis or future trade date");
    const sameDay = derived?.input.lastTradeDate === tradeDate;
    rows.push({
      instrument: roster.get(symbol)!,
      observations: { bar, basic, quantities: { volumeShares, amountCny } },
      metrics: {
        liquidity,
        history: derived && { ref: derived.archiveRef, ...derived.input },
        daily: sameDay ? { producer: derived.daily.producer, formula: derived.daily.formula, ...derived.daily.rows.at(-1)! } : null,
        signals: sameDay ? {
          producer: derived.dailySignals.producer, formula: derived.dailySignals.formula,
          exchangeInputs: derived.dailySignals.exchangeInputs ?? null, ...derived.dailySignals.rows.at(-1)!,
        } : null,
      },
    });
  }
  signal?.throwIfAborted();
  return {
    marketRef, source, market, tradeDate, adjustment, rows,
    observations: { roster: rosterObservation, daily: dailyObservation, dailyBasic: dailyBasicObservation },
  };
}

const shanghaiDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Read display-only quotes without replacing the fixed market observations or WHYJ calculations. */
export async function replayTspListRowsWithLiveQuotes(request: TspListRowsRequest, options: SourceRequestOptions = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  if (request.stocks.length > TICKFLOW_SYMBOL_BATCH_SIZE) throw new Error("Stock list quote scope exceeds one provider batch");
  const fixed = await replayTspListRows(request, signal);
  if (fixed.tradeDate !== shanghaiDay.format()) return { fixed, quotes: { status: "outside-current-day" as const } };
  if (!fixed.rows.length) return { fixed, quotes: { status: "empty" as const } };
  const symbols = fixed.rows.map(row => row.instrument.symbol);
  let batch;
  try {
    const source = await createConfiguredMarketDataSource(signal);
    batch = await source.fetchQuotes({ symbols }, options);
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    return { fixed, quotes: { status: "unavailable" as const } };
  }
  const { data, source, endpoint, observedAt, units } = batch;
  const quoteBySymbol = new Map(data.map(quote => [quote.symbol, quote]));
  const observedTime = Date.parse(observedAt);
  const rows = symbols.map(symbol => {
    const quote = quoteBySymbol.get(symbol);
    if (!quote) return { symbol, status: "missing" as const, sourceTimestamp: null };
    const sourceTimestamp = quote.timestamp;
    if (sourceTimestamp > observedTime) return { symbol, status: "future-timestamp" as const, sourceTimestamp };
    if (shanghaiDay.format(sourceTimestamp) !== fixed.tradeDate || shanghaiDay.format(observedTime) !== fixed.tradeDate) {
      return { symbol, status: "different-session" as const, sourceTimestamp };
    }
    if (quote.lastPrice <= 0) return { symbol, status: "missing-price" as const, sourceTimestamp };
    const changeAmount = quote.previousClose > 0 ? quote.lastPrice - quote.previousClose : null;
    const fraction = changeAmount === null ? null : changeAmount / quote.previousClose;
    return {
      symbol, status: "available" as const, sourceTimestamp, snapshot: quote,
      change: { producer: "whyj" as const, changeAmount, changeFraction: Number.isFinite(fraction) ? fraction : null },
    };
  });
  return { fixed, quotes: { status: "observed" as const, source, endpoint, observedAt, units, rows } };
}

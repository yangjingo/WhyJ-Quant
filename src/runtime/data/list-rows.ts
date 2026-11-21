import { loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";
import { archivedListLiquidity } from "./list-liquidity.ts";
import { deriveTspArchiveIndicators, type DailySignalExchangeRefs } from "./observation-collection.ts";

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

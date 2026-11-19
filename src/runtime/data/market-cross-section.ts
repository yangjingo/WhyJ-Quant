import { isDailyDate } from "../../market/bars.ts";
import { computeTspMarketBreadth, TSP_INDICATOR_REVISION, TSP_MARKET_BREADTH_FORMULA_VERSION } from "../../quant/index.ts";
import type { MarketObservation, SourceRequestOptions } from "../../source/index.ts";
import { archiveMarketCrossSection, loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef } from "../../storage/index.ts";
import { loadMarketBreadthHistory, type MarketBreadthHistory } from "./market-breadth-history.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

function marketSlice<Endpoint extends string, T extends { tradeDate: string }>(
  observation: MarketObservation<T>,
  endpoint: Endpoint,
  date: string,
) {
  if (observation.source !== "tushare" || observation.market !== "A" || observation.endpoint !== endpoint ||
    observation.data.tradeDate !== date) throw new Error("Incompatible dated market observation");
  return { ...observation.data, endpoint, observedAt: observation.observedAt, coverage: observation.coverage };
}

/** Fetch one dated roster before reading its market inputs, then commit the whole cross-section. */
export async function collectMarketCrossSection(tradeDate: string, options: SourceRequestOptions = {}) {
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || tradeDate < "2016-01-01" ||
    tradeDate > new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format()) throw new Error("Invalid market cross-section date");
  const control = { ...options };
  control.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(control.signal);
  const request = { market: "A" as const, tradeDate };
  const universe = marketSlice(await source.fetchHistoricalStockUniverse(request, control), "bak_basic", tradeDate);
  control.signal?.throwIfAborted();
  const receipt = { tradeDate, source: "tushare" as const };
  if (!universe.members.length) {
    return { ...receipt, status: "empty" as const, ref: null, universe: {
      endpoint: universe.endpoint, observedAt: universe.observedAt, coverage: universe.coverage, rowCount: 0,
    } };
  }
  const bars = marketSlice(await source.fetchDailyMarketBars(request, control), "daily", tradeDate);
  control.signal?.throwIfAborted();
  const basics = marketSlice(await source.fetchDailyMarketBasics(request, control), "daily_basic", tradeDate);
  control.signal?.throwIfAborted();
  const ref = await archiveMarketCrossSection({ ...receipt, market: "A", universe, bars, basics }, control.signal);
  return { ...receipt, status: "archived" as const, ref, counts: {
    universe: universe.members.length, bars: bars.rows.length, basics: basics.rows.length,
  } };
}

const scale = (value: number | null | undefined, factor: number) => value == null ? null : value * factor;

export async function deriveTspMarketBreadthArchive(
  ref: MarketCrossSectionArchiveRef,
  signal?: AbortSignal,
  history?: MarketBreadthHistory,
) {
  const archiveRef = { ...ref };
  const historyRefs = history && {
    priceArchives: history.priceArchives?.map(archive => ({ ...archive })) ?? [],
    volumeArchives: history.volumeArchives?.map(archive => ({ ...archive })) ?? [],
  };
  const snapshot = await loadMarketCrossSectionArchive(archiveRef, signal);
  const rolling = historyRefs && await loadMarketBreadthHistory(snapshot, historyRefs, signal);
  signal?.throwIfAborted();
  const { universe: { members, ...universe }, bars: { rows: barRows, ...bars },
    basics: { rows: basicRows, ...basics }, source, market, tradeDate: tradingDate } = snapshot;
  const barsBySymbol = new Map(barRows.map(row => [row.symbol, row]));
  const basicsBySymbol = new Map(basicRows.map(row => [row.symbol, row]));
  let matchingBars = 0, matchingBasics = 0;
  const observations = members.flatMap(({ symbol, name }) => {
    const bar = barsBySymbol.get(symbol), basic = basicsBySymbol.get(symbol);
    if (bar) matchingBars++;
    if (basic) matchingBasics++;
    if (!bar && !basic) return [];
    const prices = rolling?.priceWindows.get(symbol);
    return [{
      tradingDate, symbol, name, close: bar?.close ?? null,
      changeFraction: scale(bar?.returnPct, 0.01),
      volumeShares: scale(bar?.volume, 100),
      amountCny: scale(bar?.amount, 1_000),
      turnoverPct: basic?.turnoverPct ?? null,
      volumeRatio5d: rolling?.ratios.get(symbol) ?? null,
      ma5: prices?.ma5 ?? null, ma20: prices?.ma20 ?? null, ma60: prices?.ma60 ?? null,
      high60d: prices?.high_60d ?? null, low60d: prices?.low_60d ?? null,
      newHighSignal: null, newLowSignal: null,
    }];
  });
  const metrics = computeTspMarketBreadth({
    id: "tushare:bak_basic:provider-dated-stocks", revision: archiveRef.revision,
    tradingDate, symbols: members.map(member => member.symbol),
  }, observations);

  return {
    archiveRef,
    producer: "whyj" as const,
    formula: { id: "tsp_market_breadth" as const, version: TSP_MARKET_BREADTH_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    input: {
      source, market, universe: { ...universe, rowCount: members.length },
      bars: { ...bars, rowCount: barRows.length, matched: matchingBars, outOfRoster: barRows.length - matchingBars },
      basics: { ...basics, rowCount: basicRows.length, matched: matchingBasics, outOfRoster: basicRows.length - matchingBasics },
      rollingInputs: rolling?.evidence ?? ("unavailable" as const),
    },
    metrics,
  };
}

import { computeTspDailyIndicators } from "../../quant/index.ts";
import {
  loadMarketCrossSectionArchive, loadTradingDateArchive,
  type MarketCrossSectionArchiveRef, type StoredMarketCrossSection, type TradingDateArchiveRef,
} from "../../storage/index.ts";

export interface MarketBreadthHistory {
  priceArchives?: readonly TradingDateArchiveRef[];
  /** Earlier market revisions in ascending trade-date order. */
  volumeArchives?: readonly MarketCrossSectionArchiveRef[];
}

type PriceWindows = Pick<ReturnType<typeof computeTspDailyIndicators>[number], "ma5" | "ma20" | "ma60" | "high_60d" | "low_60d">;

export async function loadMarketBreadthHistory(
  snapshot: StoredMarketCrossSection,
  history: Required<MarketBreadthHistory>,
  signal?: AbortSignal,
) {
  const { tradeDate, source, market, universe, bars } = snapshot;
  if (history.priceArchives.length > universe.members.length || history.volumeArchives.length > 5) {
    throw new Error("Too many market breadth history archives");
  }
  const members = new Set(universe.members.map(row => row.symbol));
  const closes = new Map(bars.rows.map(row => [row.symbol, row.close]));
  const priceWindows = new Map<string, PriceWindows>();
  const seenPrices = new Set<string>();
  const priceEvidence = [];
  for (const archiveRef of history.priceArchives) {
    const records = await loadTradingDateArchive(archiveRef, signal);
    records.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
    const last = records.at(-1)!;
    if (!members.has(last.symbol) || seenPrices.has(last.symbol) || last.tradeDate !== tradeDate ||
      last.requested.endDate !== tradeDate || last.adjustment !== "forward" || last.market !== market) {
      throw new Error("Incompatible market breadth price archive");
    }
    seenPrices.add(last.symbol);
    const close = closes.get(last.symbol);
    const comparison = close === undefined ? "missing-current-close" : close === last.values.close ? "matched" : "different-current-close";
    if (comparison === "matched") {
      const daily = computeTspDailyIndicators(records.slice(-60).map(row => ({ date: row.tradeDate, ...row.values })));
      const { ma5, ma20, ma60, high_60d, low_60d } = daily.at(-1)!;
      priceWindows.set(last.symbol, { ma5, ma20, ma60, high_60d, low_60d });
    }
    priceEvidence.push({
      archiveRef, symbol: last.symbol, source: last.source, endpoint: last.endpoint, coverage: last.coverage,
      observedAt: last.observedAt, adjustment: last.adjustment, tradeDate, barCount: records.length, comparison,
    });
  }

  const volumeEvidence = [];
  const volumeWindows: Map<string, number | null>[] = [];
  let previousDate = "";
  for (const archiveRef of history.volumeArchives) {
    const archived = await loadMarketCrossSectionArchive(archiveRef, signal);
    if (archived.source !== source || archived.market !== market || archived.bars.volumeUnit !== bars.volumeUnit ||
      archived.tradeDate >= tradeDate || archived.tradeDate <= previousDate) {
      throw new Error("Incompatible market breadth volume archive order or basis");
    }
    previousDate = archived.tradeDate;
    const { endpoint, observedAt, coverage, volumeUnit, rows } = archived.bars;
    volumeEvidence.push({ archiveRef, source, endpoint, observedAt, coverage, volumeUnit, tradeDate: previousDate });
    volumeWindows.push(new Map(rows.map(row => [row.symbol, row.volume])));
  }

  const ratios = new Map<string, number>();
  if (volumeWindows.length === 5) {
    for (const { symbol, volume } of bars.rows) {
      if (!members.has(symbol) || volume === null) continue;
      const priorVolumes = volumeWindows.map(window => window.get(symbol));
      if (priorVolumes.some(value => value == null)) continue;
      const mean = priorVolumes.reduce<number>((sum, value) => sum + value!, 0) / priorVolumes.length;
      if (mean > 0 && Number.isFinite(mean)) ratios.set(symbol, volume / mean);
    }
  }
  signal?.throwIfAborted();
  return { priceWindows, ratios, evidence: { prices: priceEvidence, volumes: volumeEvidence } };
}

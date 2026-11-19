import { computeTspAuctionPerformance, type TspAuctionPerformanceInput } from "../../quant/index.ts";
import { fetchDatedAuctionBenchmark, type SourceRequestOptions } from "../../source/index.ts";
import {
  archiveAuctionBenchmark, loadAuctionBenchmarkArchive, loadMarketCrossSectionArchive,
  type AuctionBenchmarkArchiveRef, type MarketCrossSectionArchiveRef,
} from "../../storage/index.ts";

export async function collectAuctionBenchmark(tradeDate: string, options: SourceRequestOptions = {}) {
  const batch = await fetchDatedAuctionBenchmark(tradeDate, {}, options);
  const ref = await archiveAuctionBenchmark(batch, options.signal);
  const { rows, ...capture } = batch;
  return { ...capture, ref, status: rows.length ? "archived" as const : "empty" as const, rowCount: rows.length };
}

export interface AuctionBenchmarkReplayRequest {
  auctionRef: AuctionBenchmarkArchiveRef;
  calendar: TspAuctionPerformanceInput["calendar"];
  marketRefs: readonly MarketCrossSectionArchiveRef[];
}

/** Recompute WhyJ metrics from fixed watchlist and price evidence without contacting providers. */
export async function replayTspAuctionBenchmark(request: AuctionBenchmarkReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const auctionRef = { ...request.auctionRef };
  const calendar = { ...request.calendar };
  if (!Array.isArray(request.marketRefs) || request.marketRefs.length > 3) throw new Error("Invalid auction replay price references");
  const marketRefs = request.marketRefs.map(ref => ({ ...ref }));
  const watchlist = await loadAuctionBenchmarkArchive(auctionRef, signal);
  if (watchlist.tradeDate !== calendar.tradeDate) throw new Error("Auction observation date does not match replay calendar");

  const allowedDates = new Set([calendar.previousTradeDate, calendar.tradeDate, calendar.nextTradeDate]);
  const selected = new Set(watchlist.rows.map(row => row.symbol));
  const seen = new Set<string>();
  const prices = [];
  const priceEvidence = [];
  for (const ref of marketRefs) {
    const snapshot = await loadMarketCrossSectionArchive(ref, signal);
    const { source, tradeDate, bars } = snapshot;
    if (!allowedDates.has(tradeDate) || seen.has(tradeDate)) throw new Error("Unexpected or duplicate auction price session");
    seen.add(tradeDate);
    const matched = bars.rows.filter(row => selected.has(row.symbol));
    prices.push(...matched.map(({ symbol, open, close }) => ({ tradeDate, symbol, open, close })));
    priceEvidence.push({ ref, source, tradeDate, endpoint: bars.endpoint, observedAt: bars.observedAt,
      coverage: bars.coverage, rowsUsed: matched.length });
  }
  signal?.throwIfAborted();
  return {
    input: { auction: { ref: auctionRef, ...watchlist }, prices: priceEvidence.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)) },
    metrics: computeTspAuctionPerformance({ calendar, priceBasis: "none", watchlist: watchlist.rows, prices }),
  };
}

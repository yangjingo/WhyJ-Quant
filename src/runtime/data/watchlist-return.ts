import { isDailyDate } from "../../market/bars.ts";
import { normalizeSymbol } from "../../market/symbols.ts";
import { computeTspWatchlistReturn } from "../../quant/index.ts";
import { loadPanelPortfolio, loadTradingDateArchive, type TradingDateArchiveRef } from "../../storage/index.ts";

export interface WatchlistReturnReplayRequest {
  ref: TradingDateArchiveRef;
  asOf: string;
  membershipRevision?: string;
}

export async function replayTspWatchlistReturn(request: WatchlistReturnReplayRequest, signal?: AbortSignal) {
  const { asOf, membershipRevision } = request;
  const ref = { ...request.ref };
  if (typeof asOf !== "string" || !isDailyDate(asOf) || asOf < "0001-01-01" ||
    (membershipRevision !== undefined && !/^[a-f0-9]{64}$/.test(membershipRevision))) {
    throw new TypeError("Invalid watchlist return replay window or membership revision.");
  }
  signal?.throwIfAborted();
  const records = await loadTradingDateArchive(ref, signal);
  const first = records[0]!;
  if (first.adjustment !== "forward" || asOf < first.requested.startDate || asOf > first.requested.endDate) {
    throw new Error("Watchlist return requires forward-adjusted stock history covering the requested cutoff.");
  }
  signal?.throwIfAborted();
  const membership = loadPanelPortfolio();
  if (membershipRevision !== undefined && membership.revision !== membershipRevision) {
    throw new Error("Saved watchlist membership revision changed.");
  }
  const entry = membership.symbols.find(row => row.code === first.symbol) ??
    membership.symbols.find(row => /^\d{6}$/.test(row.code) && normalizeSymbol(row.code, "A") === first.symbol);
  if (!entry || entry.instrument === "fund") throw new Error("The archived stock is absent from the saved watchlist.");
  const closes = records.map(row => ({ tradeDate: row.tradeDate, close: row.values.close }))
    .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  return {
    input: {
      membership: { producer: "workspace" as const, revision: membership.revision!, code: entry.code, addedAt: entry.added || null },
      history: { ref, symbol: first.symbol, source: first.source, endpoint: first.endpoint, observedAt: first.observedAt,
        requested: first.requested, adjustment: first.adjustment, coverage: first.coverage, calendarTimeZone: first.calendarTimeZone },
    },
    metrics: computeTspWatchlistReturn({ assetType: first.assetType, adjustment: first.adjustment,
      asOf, addedAt: entry.added || null, closes }),
  };
}
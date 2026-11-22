import { isDailyDate } from "../../market/bars.ts";
import { computeTspPaperValuation, type TspPaperPriceMark, type TspPaperValuationInput } from "../../quant/index.ts";
import { loadQuotePollArchive, loadTradingDateArchive, type QuotePollArchiveRef,
  type TradingDateArchiveRef } from "../../storage/index.ts";

export type PaperValuationReplayRequest = Omit<TspPaperValuationInput, "basis" | "marks"> & {
  priceBasisConfirmation: "caller-confirmed-unadjusted-CNY";
} & (
  { basis: "finalized"; dailyRefs: readonly TradingDateArchiveRef[]; quoteRef?: never } |
  { basis: "snapshot"; quoteRef: QuotePollArchiveRef; dailyRefs?: never }
);

/** Revalue fixed private holdings using the exact dated market evidence supplied by the caller. */
export async function replayTspPaperValuation(request: PaperValuationReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { basis, priceBasisConfirmation, dailyRefs, quoteRef, ...scope } = structuredClone(request);
  const { currency, tradeDate, positions } = scope;
  if (!isDailyDate(tradeDate) || currency !== "CNY" || priceBasisConfirmation !== "caller-confirmed-unadjusted-CNY" ||
    !Array.isArray(positions)) throw new Error("Paper valuation replay requires exact dated unadjusted CNY evidence");
  const stocks = new Set(positions.filter(position => position?.assetType === "stock" && position.quantity > 0).map(position => position.symbol));
  const marks: TspPaperPriceMark[] = [];

  if (basis === "finalized") {
    if (!Array.isArray(dailyRefs) || quoteRef !== undefined) throw new Error("Invalid finalized paper valuation archive scope");
    const seen = new Set<string>();
    const evidence = [];
    for (const ref of dailyRefs as readonly TradingDateArchiveRef[]) {
      const bars = await loadTradingDateArchive(ref, signal);
      const { symbol, assetType, requested, adjustment, coverage, source, endpoint, observedAt } = bars[0]!;
      if (assetType !== "stock" || !stocks.has(symbol) || seen.has(symbol) || adjustment !== "none" ||
        tradeDate < requested.startDate || tradeDate > requested.endDate) throw new Error("Mismatched paper valuation daily archive");
      seen.add(symbol);
      const bar = bars.find(row => row.tradeDate === tradeDate);
      const price = bar?.values.close ?? null;
      if (price !== null && price > 0) {
        marks.push({ symbol, currency, tradeDate, basis, adjustment, source, revision: ref.revision, price });
      }
      evidence.push({ symbol, ref, requested, adjustment, coverage, source, endpoint, observedAt, price, sourceTimestamp: bar?.sourceTimestamp ?? null });
    }
    signal?.throwIfAborted();
    return {
      ...computeTspPaperValuation({ ...scope, basis, marks }),
      inputs: { priceBasisConfirmation, daily: evidence, noDailyReferenceSymbols: [...stocks].filter(symbol => !seen.has(symbol)).sort() },
    };
  }

  if (basis !== "snapshot" || !quoteRef || dailyRefs !== undefined) throw new Error("Invalid quote-poll paper valuation archive scope");
  const { rows, requestedSymbols, ...capture } = await loadQuotePollArchive(quoteRef, signal);
  if (capture.tradeDate !== tradeDate) throw new Error("Mismatched paper valuation quote-poll date");
  const quoted = new Map(rows.map(row => [row.symbol, row]));
  const requested = new Set(requestedSymbols);
  const quotes = [...stocks].sort().map(symbol => {
    const row = quoted.get(symbol);
    const price = row?.lastPrice ?? null;
    if (price !== null && price > 0) {
      marks.push({ symbol, currency, tradeDate, basis, adjustment: "none", source: capture.source, revision: quoteRef.revision, price });
    }
    return { symbol, requested: requested.has(symbol), price, sourceTimestamp: row?.timestamp ?? null, receivedAt: row?.receivedAt ?? null };
  });
  signal?.throwIfAborted();
  return {
    ...computeTspPaperValuation({ ...scope, basis, marks }),
    inputs: { priceBasisConfirmation, quotePoll: { ref: quoteRef, ...capture, quotes } },
  };
}

import { isDailyDate } from "../../market/bars.ts";
import { computeTspPaperValuation, type TspPaperPriceMark, type TspPaperValuationInput } from "../../quant/index.ts";
import { loadDatedEtfDailyArchive, loadQuotePollArchive, loadTradingDateArchive, loadValuationQuotePollArchive,
  type DatedEtfDailyArchiveRef, type QuotePollArchiveRef, type TradingDateArchiveRef, type ValuationQuotePollArchiveRef } from "../../storage/index.ts";

export type PaperValuationReplayRequest = Omit<TspPaperValuationInput, "basis" | "marks"> & {
  priceBasisConfirmation: "caller-confirmed-unadjusted-CNY";
} & (
  { basis: "finalized"; dailyRefs: readonly TradingDateArchiveRef[]; etfDailyRefs?: readonly DatedEtfDailyArchiveRef[];
    quoteRef?: never; valuationQuoteRef?: never } |
  ({ basis: "snapshot"; dailyRefs?: never; etfDailyRefs?: never } & (
    { quoteRef: QuotePollArchiveRef; valuationQuoteRef?: never } |
    { valuationQuoteRef: ValuationQuotePollArchiveRef; quoteRef?: never }
  ))
);

/** Revalue fixed private holdings using the exact dated market evidence supplied by the caller. */
export async function replayTspPaperValuation(request: PaperValuationReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { basis, priceBasisConfirmation, dailyRefs, etfDailyRefs, quoteRef, valuationQuoteRef, ...scope } = structuredClone(request);
  const { currency, tradeDate, positions } = scope;
  if (!isDailyDate(tradeDate) || currency !== "CNY" || priceBasisConfirmation !== "caller-confirmed-unadjusted-CNY" ||
    !Array.isArray(positions)) throw new Error("Paper valuation replay requires exact dated unadjusted CNY evidence");
  const stocks = new Set(positions.filter(position => position?.assetType === "stock" && position.quantity > 0).map(position => position.symbol));
  const marks: TspPaperPriceMark[] = [];

  if (basis === "finalized") {
    if (!Array.isArray(dailyRefs) || (etfDailyRefs !== undefined && !Array.isArray(etfDailyRefs)) ||
      quoteRef !== undefined || valuationQuoteRef !== undefined) {
      throw new Error("Invalid finalized paper valuation archive scope");
    }
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
    const etfs = new Set(positions.filter(position => position?.assetType === "etf" && position.quantity > 0).map(position => position.symbol));
    const etfEvidence = [];
    for (const ref of (etfDailyRefs ?? []) as readonly DatedEtfDailyArchiveRef[]) {
      const { rows, ...batch } = await loadDatedEtfDailyArchive(ref, signal);
      const { symbol, requested, adjustment, source } = batch;
      if (!etfs.has(symbol) || seen.has(symbol) || tradeDate < requested.start || tradeDate > requested.end) {
        throw new Error("Mismatched paper valuation ETF daily archive");
      }
      seen.add(symbol);
      const bar = rows.find(row => row.tradeDate === tradeDate);
      if (bar) marks.push({ symbol, currency, tradeDate, basis, adjustment, source, revision: ref.revision, price: bar.close });
      etfEvidence.push({ ...batch, ref, price: bar?.close ?? null, sourceTimestamp: bar?.sourceTimestamp ?? null });
    }
    signal?.throwIfAborted();
    return {
      ...computeTspPaperValuation({ ...scope, basis, marks }),
      inputs: {
        priceBasisConfirmation, daily: evidence, etfDaily: etfEvidence,
        noDailyReferenceSymbols: [...stocks].filter(symbol => !seen.has(symbol)).sort(),
        noEtfDailyReferenceSymbols: [...etfs].filter(symbol => !seen.has(symbol)).sort(),
      },
    };
  }

  const ref = valuationQuoteRef ?? quoteRef;
  if (basis !== "snapshot" || !ref || (valuationQuoteRef !== undefined && quoteRef !== undefined) ||
    dailyRefs !== undefined || etfDailyRefs !== undefined) {
    throw new Error("Invalid quote-poll paper valuation archive scope");
  }
  const { rows, requestedSymbols, ...capture } = valuationQuoteRef !== undefined
    ? await loadValuationQuotePollArchive(valuationQuoteRef, signal)
    : await loadQuotePollArchive(quoteRef!, signal);
  if (capture.tradeDate !== tradeDate) throw new Error("Mismatched paper valuation quote-poll date");
  const quoted = new Map(rows.map(row => [row.symbol, row]));
  const requested = new Set(requestedSymbols);
  const eligibleSymbols = valuationQuoteRef !== undefined
    ? [...stocks, ...positions.filter(position => position?.assetType === "etf" && position.quantity > 0).map(position => position.symbol)]
    : [...stocks];
  const quotes = eligibleSymbols.sort().map(symbol => {
    const row = quoted.get(symbol);
    const price = row?.lastPrice ?? null;
    if (price !== null && price > 0) {
      marks.push({ symbol, currency, tradeDate, basis, adjustment: "none", source: capture.source, revision: ref.revision, price });
    }
    return { symbol, requested: requested.has(symbol), price, sourceTimestamp: row?.timestamp ?? null, receivedAt: row?.receivedAt ?? null };
  });
  signal?.throwIfAborted();
  return {
    ...computeTspPaperValuation({ ...scope, basis, marks }),
    inputs: { priceBasisConfirmation, quotePoll: { ref, ...capture, quotes } },
  };
}

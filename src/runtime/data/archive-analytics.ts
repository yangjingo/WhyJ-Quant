import { computeTspPriceLevels, computeTspResearchFactors, TSP_INDICATOR_REVISION,
  TSP_PRICE_LEVEL_FORMULA_VERSION, TSP_RESEARCH_FACTOR_FORMULA_VERSION } from "../../quant/index.ts";
import { loadTradingDateArchive, type TradingDateArchiveRef } from "../../storage/index.ts";

/** Recompute the latest research and chart values from exactly one daily revision. */
export async function deriveTspArchiveAnalytics(ref: TradingDateArchiveRef, signal?: AbortSignal) {
  const archiveRef = { ...ref };
  const rows = await loadTradingDateArchive(archiveRef, signal);
  signal?.throwIfAborted();
  rows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  const first = rows[0]!;
  const volumeUnit = first.volumeUnit === "hand" ? first.volumeUnit : undefined;
  const bars = rows.map(({ tradeDate, values: { amount, ...values } }) => {
    const amountCny = first.amountUnit === "CNY-thousand" && amount !== null ? amount * 1000 : null;
    return { date: tradeDate, ...values, amountCny: amountCny !== null && Number.isFinite(amountCny) ? amountCny : null };
  });
  const factor = computeTspResearchFactors(bars, { volumeUnit }).at(-1)!;
  const levels = computeTspPriceLevels(bars);
  return {
    archiveRef,
    input: {
      symbol: first.symbol, source: first.source, endpoint: first.endpoint, observedAt: first.observedAt,
      requested: first.requested, adjustment: first.adjustment, calendarTimeZone: first.calendarTimeZone,
      firstTradeDate: first.tradeDate, lastTradeDate: rows.at(-1)!.tradeDate, rowCount: rows.length,
      volumeUnit: first.volumeUnit, amountUnit: first.amountUnit, coverage: first.coverage, finality: "unknown" as const,
      usableCnyAmounts: bars.filter(bar => bar.amountCny !== null).length,
    },
    researchFactors: {
      producer: "whyj" as const,
      formula: { id: "tsp_research_factors" as const, version: TSP_RESEARCH_FACTOR_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
      asOf: factor.date,
      values: factor.values,
    },
    priceLevels: {
      producer: "whyj" as const,
      formula: { id: "tsp_price_levels" as const, version: TSP_PRICE_LEVEL_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
      ...levels,
    },
  };
}

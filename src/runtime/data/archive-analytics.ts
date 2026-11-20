import { computeTspPriceLevels, computeTspResearchFactors, TSP_INDICATOR_REVISION,
  TSP_PRICE_LEVEL_FORMULA_VERSION, TSP_RESEARCH_FACTOR_FORMULA_VERSION } from "../../quant/index.ts";
import {
  loadMarketCrossSectionArchive, loadTradingDateArchive, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef,
} from "../../storage/index.ts";

export interface ArchiveAnalyticsSupplements {
  turnoverArchives?: readonly MarketCrossSectionArchiveRef[];
}

interface TurnoverInput {
  archiveRef: MarketCrossSectionArchiveRef;
  tradeDate: string;
  source: "tushare";
  endpoint: "daily_basic";
  observedAt: string;
  coverage: "unknown";
  unit: "percentage-point";
  value: number | null;
  availability: "reported" | "unreported" | "missing-symbol";
}

/** Recompute the latest research and chart values from exact daily and optional turnover revisions. */
export async function deriveTspArchiveAnalytics(
  ref: TradingDateArchiveRef,
  signal?: AbortSignal,
  supplements: ArchiveAnalyticsSupplements = {},
) {
  const archiveRef = { ...ref };
  const references = supplements.turnoverArchives ?? [];
  if (references.length > 366) throw new Error("Too many historical turnover archives");
  const turnoverRefs = references.map(reference => ({ ...reference }));
  const rows = await loadTradingDateArchive(archiveRef, signal);
  signal?.throwIfAborted();
  rows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  const first = rows[0]!;
  const turnover = new Map<string, TurnoverInput>();
  if (turnoverRefs.length) {
    const tradingDates = new Set(rows.map(row => row.tradeDate));
    for (const turnoverRef of turnoverRefs) {
      const { tradeDate, source, market, basics } = await loadMarketCrossSectionArchive(turnoverRef, signal);
      if (market !== first.market || !tradingDates.has(tradeDate) || turnover.has(tradeDate)) {
        throw new Error("Historical turnover archive date or market is incompatible");
      }
      const row = basics.rows.find(item => item.symbol === first.symbol);
      const value = row?.turnoverPct ?? null;
      turnover.set(tradeDate, {
        archiveRef: turnoverRef, tradeDate, source, endpoint: basics.endpoint, observedAt: basics.observedAt,
        coverage: basics.coverage, unit: "percentage-point", value,
        availability: row === undefined ? "missing-symbol" : value === null ? "unreported" : "reported",
      });
    }
  }
  signal?.throwIfAborted();
  const volumeUnit = first.volumeUnit === "hand" ? first.volumeUnit : undefined;
  const bars = rows.map(({ tradeDate, values: { amount, ...values } }) => {
    const amountCny = first.amountUnit === "CNY-thousand" && amount !== null ? amount * 1000 : null;
    return {
      date: tradeDate, ...values, turnoverPct: turnover.get(tradeDate)?.value ?? null,
      amountCny: amountCny !== null && Number.isFinite(amountCny) ? amountCny : null,
    };
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
      ...(turnover.size ? { turnoverInputs: rows.flatMap(row => {
        const observation = turnover.get(row.tradeDate);
        return observation ? [observation] : [];
      }) } : {}),
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

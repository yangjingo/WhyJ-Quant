import { isDailyDate } from "../../market/bars.ts";
import { computeTspPriceLevels, computeTspResearchFactors, TSP_INDICATOR_REVISION,
  TSP_PRICE_LEVEL_FORMULA_VERSION, TSP_RESEARCH_FACTOR_FORMULA_VERSION, type TspResearchFactorBar } from "../../quant/index.ts";
import {
  loadMarketCrossSectionArchive, loadTradingDateArchive, type FinancialObservationArchiveRef, type MarketCrossSectionArchiveRef,
  type StoredTradingDateBarObservation, type TradingDateArchiveRef,
} from "../../storage/index.ts";
import { replayFinancialResearchInputs, type FinancialInputReplayRow } from "./financial-input-replay.ts";

export interface ArchiveAnalyticsSupplements {
  turnoverArchives?: readonly MarketCrossSectionArchiveRef[];
  financialArchives?: readonly FinancialObservationArchiveRef[];
  bookValueBasis?: {
    reportRevision: string;
    periodEnd: string;
    basis: "caller-confirmed-unadjusted-CNY";
  };
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

export function researchFactorBar(
  row: StoredTradingDateBarObservation,
  supplements: Pick<TspResearchFactorBar, "turnoverPct" | "consecutiveLimitUps"> = {},
): TspResearchFactorBar {
  const { amount, ...values } = row.values;
  const amountCny = row.amountUnit === "CNY-thousand" && amount !== null ? amount * 1000 : null;
  return {
    date: row.tradeDate, ...values, ...supplements,
    amountCny: amountCny !== null && Number.isFinite(amountCny) ? amountCny : null,
  };
}

export function researchFinancialReport(
  financial: Extract<FinancialInputReplayRow, { status: "available" }>,
  compatibleBookValue: boolean,
) {
  return {
    announcementDate: financial.actualDisclosureDate,
    bps: compatibleBookValue ? financial.report.bookValuePerShare : null,
    roe: financial.report.roe,
    grossMargin: financial.report.grossProfitMargin,
    netMargin: financial.report.netProfitMargin,
    revenueYoy: financial.report.operatingRevenueYoyPct,
    netIncomeYoy: financial.report.parentNetProfitYoyPct,
    debtRatio: financial.report.debtToAssets,
  };
}

/** Recompute the latest research and chart values from exact daily and optional supplemental revisions. */
export async function deriveTspArchiveAnalytics(
  ref: TradingDateArchiveRef,
  signal?: AbortSignal,
  supplements: ArchiveAnalyticsSupplements = {},
) {
  const archiveRef = { ...ref };
  const references = supplements.turnoverArchives ?? [];
  if (references.length > 366) throw new Error("Too many historical turnover archives");
  const turnoverRefs = references.map(reference => ({ ...reference }));
  const financialRefs = (supplements.financialArchives ?? []).map(reference => ({ ...reference }));
  let bookValueBasis: ArchiveAnalyticsSupplements["bookValueBasis"];
  if (supplements.bookValueBasis) {
    const { reportRevision, periodEnd, basis } = supplements.bookValueBasis;
    if (basis !== "caller-confirmed-unadjusted-CNY" || typeof reportRevision !== "string" || !/^[a-f0-9]{64}$/.test(reportRevision) ||
      typeof periodEnd !== "string" || !isDailyDate(periodEnd) ||
      !financialRefs.some(reference => reference.kind === "report-financial-indicators" && reference.revision === reportRevision)) {
      throw new Error("Invalid research book value confirmation");
    }
    bookValueBasis = { reportRevision, periodEnd, basis };
  }
  const rows = await loadTradingDateArchive(archiveRef, signal);
  signal?.throwIfAborted();
  rows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  const first = rows[0]!;
  const asOf = rows.at(-1)!.tradeDate;
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
  const [financial] = financialRefs.length ? await replayFinancialResearchInputs({
    symbol: first.symbol, tradingDates: [asOf], references: financialRefs,
  }, signal) : [];
  const compatibleBookValue = financial?.status === "available" && bookValueBasis !== undefined && first.adjustment === "none" &&
    bookValueBasis.periodEnd === financial.periodEnd && financial.reportEvidence.some(({ ref }) => ref.revision === bookValueBasis.reportRevision);
  // The selected finance inputs are point-in-time for the final row returned here.
  const financialReports = financial?.status === "available" ? [researchFinancialReport(financial, compatibleBookValue)] : undefined;
  signal?.throwIfAborted();
  const volumeUnit = first.volumeUnit === "hand" ? first.volumeUnit : undefined;
  const bars = rows.map(row => researchFactorBar(row, { turnoverPct: turnover.get(row.tradeDate)?.value ?? null }));
  const factor = computeTspResearchFactors(bars, { volumeUnit, financialReports }).at(-1)!;
  const levels = computeTspPriceLevels(bars);
  return {
    archiveRef,
    input: {
      symbol: first.symbol, source: first.source, endpoint: first.endpoint, observedAt: first.observedAt,
      requested: first.requested, adjustment: first.adjustment, calendarTimeZone: first.calendarTimeZone,
      firstTradeDate: first.tradeDate, lastTradeDate: asOf, rowCount: rows.length,
      volumeUnit: first.volumeUnit, amountUnit: first.amountUnit, coverage: first.coverage, finality: "unknown" as const,
      usableCnyAmounts: bars.filter(bar => bar.amountCny !== null).length,
      ...(turnover.size ? { turnoverInputs: rows.flatMap(row => {
        const observation = turnover.get(row.tradeDate);
        return observation ? [observation] : [];
      }) } : {}),
      ...(financial ? { financialInput: { ...financial, ...(bookValueBasis ? {
        bookValueBasis: { ...bookValueBasis, compatible: compatibleBookValue },
      } : {}) } } : {}),
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

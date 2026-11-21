import { isDailyDate } from "../../market/bars.ts";
import {
  computeTspLimitStreaks, rankTspAbnormalSnapshot, TSP_ABNORMAL_SNAPSHOT_FORMULA_VERSION, TSP_ABNORMAL_SNAPSHOT_SIGNALS,
  TSP_INDICATOR_REVISION, TSP_LIMIT_STREAK_FORMULA_VERSION, type TspAbnormalSnapshotObservation,
} from "../../quant/index.ts";
import { loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";
import { deriveTspArchiveIndicators, type DailySignalExchangeRefs } from "./observation-collection.ts";

export interface AbnormalSnapshotReplayRequest {
  marketRef: MarketCrossSectionArchiveRef;
  sessions: readonly string[];
  adjustment: "none" | "forward";
  histories: readonly { symbol: string; ref: TradingDateArchiveRef; exchange?: DailySignalExchangeRefs }[];
  limit?: number;
}

/** Rebuild the completed-session abnormal snapshot from explicit market and stock archive revisions. */
export async function replayTspAbnormalSnapshot(request: AbnormalSnapshotReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { marketRef, sessions, adjustment, histories, limit } = structuredClone(request);
  if ((adjustment !== "none" && adjustment !== "forward") || !sessions.length ||
    sessions.some((date, index) => !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!))) {
    throw new Error("Invalid abnormal snapshot exchange sessions or price basis");
  }
  const market = await loadMarketCrossSectionArchive(marketRef, signal);
  const { tradeDate, universe, bars, basics, source } = market;
  if (sessions.at(-1) !== tradeDate) throw new Error("Market snapshot must match the last exchange session");
  const roster = new Map(universe.members.map(member => [member.symbol, member]));
  const seen = new Set<string>();
  for (const { symbol } of histories) {
    if (!roster.has(symbol) || seen.has(symbol)) throw new Error("Foreign or duplicate abnormal snapshot history");
    seen.add(symbol);
  }
  const rawPrices = new Map(bars.rows.map(row => [row.symbol, row]));
  const marketBasics = new Map(basics.rows.map(row => [row.symbol, row]));
  const firstSession = sessions[0]!;
  const stockRows = [];
  for (const { symbol, ref, exchange } of histories) {
    signal?.throwIfAborted();
    const derived = await deriveTspArchiveIndicators(ref, signal, exchange);
    if (derived.input.symbol !== symbol || derived.input.adjustment !== adjustment || derived.input.lastTradeDate > tradeDate) {
      throw new Error("Abnormal snapshot history has a mismatched symbol, basis or future date");
    }
    const signalRows = derived.dailySignals.rows.filter(row => row.date >= firstSession);
    const lastSignal = signalRows.at(-1);
    const latest = lastSignal?.date === tradeDate ? lastSignal.values : null;
    const signalFlags = Object.fromEntries(
      TSP_ABNORMAL_SNAPSHOT_SIGNALS.map(([field]) => [field, latest?.[field] ?? null]),
    ) as TspAbnormalSnapshotObservation["signals"];
    const daily = derived.daily.rows.at(-1);
    const technical = daily?.date === tradeDate ? daily.values : null;
    const consecutiveLimitUps = computeTspLimitStreaks(sessions, signalRows).at(-1)?.consecutiveLimitUps ?? null;
    const bar = rawPrices.get(symbol);
    stockRows.push({
      classification: { symbol, signals: signalFlags, changeFraction: bar?.returnPct == null ? null : bar.returnPct / 100 },
      evidence: {
        symbol, daily: { ref, ...derived.input, formula: derived.daily.formula }, signalFormula: derived.dailySignals.formula,
        exchange: derived.dailySignals.exchangeInputs ?? null,
      },
      display: {
        name: roster.get(symbol)!.name,
        provider: { closeCny: bar?.close ?? null, changePct: bar?.returnPct ?? null,
          turnoverPct: marketBasics.get(symbol)?.turnoverPct ?? null },
        derived: { amplitudeFraction: technical?.amplitude ?? null, volumeRatio5d: technical?.vol_ratio_5d ?? null, consecutiveLimitUps },
      },
    });
  }
  const ranked = rankTspAbnormalSnapshot(tradeDate, stockRows.map(row => row.classification), limit);
  const displayed = new Map(stockRows.map(({ classification, display }) => [classification.symbol, display]));
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_abnormal_snapshot" as const, version: TSP_ABNORMAL_SNAPSHOT_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    streakFormulaVersion: TSP_LIMIT_STREAK_FORMULA_VERSION,
    basis: "completed-session" as const,
    market: {
      ref: marketRef, tradeDate, source, rosterCount: roster.size,
      universe: { endpoint: universe.endpoint, observedAt: universe.observedAt, coverage: universe.coverage },
      daily: { endpoint: bars.endpoint, observedAt: bars.observedAt, coverage: bars.coverage,
        priceUnit: bars.priceUnit, changeUnit: "percentage-points" as const },
      dailyBasic: { endpoint: basics.endpoint, observedAt: basics.observedAt, coverage: basics.coverage,
        turnoverUnit: "percentage-points" as const },
    },
    sessions, adjustment, histories: stockRows.map(row => row.evidence),
    ...ranked,
    rows: ranked.rows.map(row => ({ ...row, ...displayed.get(row.symbol)! })),
  };
}

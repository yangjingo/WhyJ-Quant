import { isDailyDate } from "../../market/bars.ts";
import { computeTspDailyLadderFlags, computeTspLimitStreaks, computeTspMarketLadder, tspTradingLimitThresholds } from "../../quant/index.ts";
import {
  loadDailyTradingLimitArchive, loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef,
  type StoredDailyTradingLimitBatch, type StoredMarketCrossSection, type TradingLimitArchiveRef,
} from "../../storage/index.ts";

export interface MarketLadderReplayRequest {
  sessions: readonly string[];
  marketRefs: readonly MarketCrossSectionArchiveRef[];
  limitRefs: readonly TradingLimitArchiveRef[];
}

type DailyFlags = ReturnType<typeof computeTspDailyLadderFlags>;
type Signal = { date: string; values: DailyFlags };
type KnownStreaks = ReturnType<typeof computeTspLimitStreaks>;

/** Reopen dated raw market and effective-limit archives on a caller-supplied exchange calendar. */
export async function replayTspMarketLadders(request: MarketLadderReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sessions = [...request.sessions], marketRefs = request.marketRefs.map(ref => ({ ...ref })), limitRefs = request.limitRefs.map(ref => ({ ...ref }));
  for (const [index, date] of sessions.entries()) {
    if (typeof date !== "string" || !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!)) {
      throw new Error("Market ladder replay requires ordered unique exchange sessions");
    }
  }
  const calendar = new Set(sessions);
  const marketByDate = new Map<string, { ref: MarketCrossSectionArchiveRef; snapshot: StoredMarketCrossSection }>();
  const members = new Set<string>();
  for (const ref of marketRefs) {
    const snapshot = await loadMarketCrossSectionArchive(ref, signal);
    if (!calendar.has(snapshot.tradeDate) || marketByDate.has(snapshot.tradeDate)) throw new Error("Duplicate or off-calendar market ladder archive");
    marketByDate.set(snapshot.tradeDate, { ref, snapshot });
    for (const { symbol } of snapshot.universe.members) members.add(symbol);
  }
  const limitsBySymbol = new Map<string, { ref: TradingLimitArchiveRef; batch: StoredDailyTradingLimitBatch;
    rows: Map<string, StoredDailyTradingLimitBatch["rows"][number]> }>();
  for (const ref of limitRefs) {
    const batch = await loadDailyTradingLimitArchive(ref, signal);
    if (!members.has(batch.symbol) || limitsBySymbol.has(batch.symbol)) throw new Error("Duplicate or off-roster trading limit archive");
    limitsBySymbol.set(batch.symbol, { ref, batch, rows: new Map(batch.rows.map(row => [row.tradeDate, row])) });
  }

  const signalsBySymbol = new Map<string, Signal[]>();
  const flagsByDate = new Map<string, Map<string, DailyFlags>>();
  for (const [date, { snapshot }] of marketByDate) {
    signal?.throwIfAborted();
    const eligible = new Set(snapshot.universe.members.map(member => member.symbol));
    const flags = new Map<string, DailyFlags>();
    for (const bar of snapshot.bars.rows) {
      const limit = limitsBySymbol.get(bar.symbol)?.rows.get(date);
      if (!limit || !eligible.has(bar.symbol)) continue;
      const values = computeTspDailyLadderFlags({ raw_close: bar.close, raw_high: bar.high, raw_low: bar.low,
        ...tspTradingLimitThresholds(limit.limitUp, limit.limitDown) });
      flags.set(bar.symbol, values);
      const series = signalsBySymbol.get(bar.symbol);
      if (series) series.push({ date, values });
      else signalsBySymbol.set(bar.symbol, [{ date, values }]);
    }
    flagsByDate.set(date, flags);
  }
  const streaksBySymbol = new Map<string, KnownStreaks>();
  for (const [symbol, observations] of signalsBySymbol) {
    signal?.throwIfAborted();
    streaksBySymbol.set(symbol, computeTspLimitStreaks(sessions, observations));
  }

  const rows = sessions.map((tradingDate, index) => {
    signal?.throwIfAborted();
    const previousTradingDate = sessions[index - 1] ?? null;
    const capture = marketByDate.get(tradingDate);
    if (!capture) return { tradingDate, previousTradingDate, market: null, metrics: null };
    const { ref, snapshot } = capture;
    const { source, universe, bars } = snapshot;
    const amounts = new Map(bars.rows.map(row => [row.symbol, row.amount]));
    const flags = flagsByDate.get(tradingDate);
    const observations = universe.members.map(({ symbol, name }) => {
      const limitFlags = flags?.get(symbol), streaks = streaksBySymbol.get(symbol), amount = amounts.get(symbol);
      return { tradingDate, symbol, name, amountCny: amount == null ? null : amount * 1_000,
        upStreak: streaks?.[index]?.consecutiveLimitUps ?? null, priorUpStreak: streaks?.[index - 1]?.consecutiveLimitUps ?? null,
        limitUp: limitFlags?.signal_limit_up ?? null, brokenLimitUp: limitFlags?.signal_broken_limit_up ?? null };
    });
    return { tradingDate, previousTradingDate,
      market: { ref, source, universeEndpoint: universe.endpoint, universeObservedAt: universe.observedAt,
        barsEndpoint: bars.endpoint, barsObservedAt: bars.observedAt, coverage: bars.coverage, amountUnit: bars.amountUnit },
      metrics: computeTspMarketLadder({ id: `${source}:${universe.endpoint}:${universe.universe}`, revision: ref.revision, tradingDate,
        symbols: universe.members.map(member => member.symbol) }, previousTradingDate, observations),
    };
  });
  const limits = [...limitsBySymbol.values()].map(({ ref, batch: { symbol, source, endpoint, observedAt, coverage, requested } }) => ({
    ref, symbol, source, endpoint, observedAt, coverage, requested,
  })).sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { calendar: { zone: "Asia/Shanghai" as const, sessions }, input: { tradingLimits: limits }, rows };
}

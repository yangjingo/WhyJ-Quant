import { isDailyDate } from "../../market/bars.ts";
import { computeTspDailyLadderFlags, computeTspLimitStreaks, computeTspMarketLadder, tspTradingLimitThresholds,
  type TspBreadthUniverse, type TspLimitLadderObservation } from "../../quant/index.ts";
import {
  loadDailyTradingLimitArchive, loadMarketCrossSectionArchive, loadRiskWarningArchive, type MarketCrossSectionArchiveRef,
  type RiskWarningArchiveRef, type StoredDailyTradingLimitBatch, type StoredMarketCrossSection, type StoredRiskWarningBatch, type TradingLimitArchiveRef,
} from "../../storage/index.ts";

export interface MarketLadderReplayRequest {
  sessions: readonly string[];
  marketRefs: readonly MarketCrossSectionArchiveRef[];
  limitRefs: readonly TradingLimitArchiveRef[];
  /** Supplying references opts in to an exact-date risk-warning filter. */
  riskWarningRefs?: readonly RiskWarningArchiveRef[];
}

type DailyFlags = ReturnType<typeof computeTspDailyLadderFlags>;
type Signal = { date: string; values: DailyFlags };
type KnownStreaks = ReturnType<typeof computeTspLimitStreaks>;
type RiskWarningCapture = Omit<StoredRiskWarningBatch, "rows"> & { ref: RiskWarningArchiveRef; rowCount: number; symbols: Set<string> };
type RiskWarningEvidence = { status: "missing" } |
  (Omit<RiskWarningCapture, "symbols"> & { status: "matched"; excludedSymbols: string[] });

interface LadderReplayInputs {
  tradingDate: string;
  previousTradingDate: string | null;
  market: {
    ref: MarketCrossSectionArchiveRef;
    source: StoredMarketCrossSection["source"];
    universeEndpoint: StoredMarketCrossSection["universe"]["endpoint"];
    universeObservedAt: string;
    barsEndpoint: StoredMarketCrossSection["bars"]["endpoint"];
    barsObservedAt: string;
    coverage: "unknown";
    amountUnit: StoredMarketCrossSection["bars"]["amountUnit"];
  } | null;
  riskWarnings?: RiskWarningEvidence;
  universe: TspBreadthUniverse | null;
  observations: readonly (TspLimitLadderObservation & { limitDown: boolean | null })[];
}

/** Assemble the full per-stock inputs once, projecting each day's observations before moving forward. */
export async function projectMarketLadderReplay<T>(request: MarketLadderReplayRequest,
  project: (input: LadderReplayInputs) => T | Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sessions = [...request.sessions], marketRefs = request.marketRefs.map(ref => ({ ...ref })), limitRefs = request.limitRefs.map(ref => ({ ...ref }));
  const riskWarningRefs = request.riskWarningRefs?.map(ref => ({ ...ref }));
  for (const [index, date] of sessions.entries()) {
    if (typeof date !== "string" || !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!)) {
      throw new Error("Market ladder replay requires ordered unique exchange sessions");
    }
  }
  const calendar = new Set(sessions);
  const riskByDate = new Map<string, RiskWarningCapture>();
  for (const ref of riskWarningRefs ?? []) {
    const { rows, ...capture } = await loadRiskWarningArchive(ref, signal);
    const { tradeDate } = capture;
    if (!calendar.has(tradeDate) || riskByDate.has(tradeDate)) throw new Error("Duplicate or off-calendar risk-warning archive");
    riskByDate.set(tradeDate, { ...capture, ref, rowCount: rows.length, symbols: new Set(rows.map(row => row.symbol)) });
  }
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

  const rows: T[] = [];
  for (const [index, tradingDate] of sessions.entries()) {
    signal?.throwIfAborted();
    const previousTradingDate = sessions[index - 1] ?? null;
    const capture = marketByDate.get(tradingDate);
    const risk = riskByDate.get(tradingDate);
    const roster = capture?.snapshot.universe.members ?? [];
    let riskWarnings: RiskWarningEvidence | undefined;
    if (riskWarningRefs) {
      if (risk) {
        const { symbols, ...source } = risk;
        riskWarnings = { ...source, status: "matched", excludedSymbols: roster.filter(member => symbols.has(member.symbol)).map(member => member.symbol) };
      } else riskWarnings = { status: "missing" };
    }
    const riskEvidence = riskWarnings ? { riskWarnings } : {};
    if (!capture) {
      rows.push(await project({ tradingDate, previousTradingDate, market: null, universe: null, observations: [], ...riskEvidence }));
      continue;
    }
    const { ref, snapshot } = capture;
    const { source, universe, bars } = snapshot;
    const market = { ref, source, universeEndpoint: universe.endpoint, universeObservedAt: universe.observedAt,
      barsEndpoint: bars.endpoint, barsObservedAt: bars.observedAt, coverage: bars.coverage, amountUnit: bars.amountUnit };
    if (riskWarnings?.status === "missing") {
      rows.push(await project({ tradingDate, previousTradingDate, market, universe: null, observations: [], ...riskEvidence }));
      continue;
    }
    const included = risk ? roster.filter(member => !risk.symbols.has(member.symbol)) : roster;
    const priorRisk = previousTradingDate === null ? undefined : riskByDate.get(previousTradingDate);
    const amounts = new Map(bars.rows.map(row => [row.symbol, row.amount]));
    const flags = flagsByDate.get(tradingDate);
    const observations = included.map(({ symbol, name }) => {
      const limitFlags = flags?.get(symbol), streaks = streaksBySymbol.get(symbol), amount = amounts.get(symbol);
      const priorEligible = !riskWarningRefs || (priorRisk && !priorRisk.symbols.has(symbol));
      return { tradingDate, symbol, name, amountCny: amount == null ? null : amount * 1_000,
        upStreak: streaks?.[index]?.consecutiveLimitUps ?? null,
        priorUpStreak: priorEligible ? streaks?.[index - 1]?.consecutiveLimitUps ?? null : null,
        limitUp: limitFlags?.signal_limit_up ?? null, brokenLimitUp: limitFlags?.signal_broken_limit_up ?? null,
        limitDown: limitFlags?.signal_limit_down ?? null };
    });
    const universeId = `${source}:${universe.endpoint}:${universe.universe}`;
    rows.push(await project({ tradingDate, previousTradingDate, market, ...riskEvidence, observations,
      universe: { id: risk ? `${universeId}:exclude-observed-risk-warnings` : universeId,
        revision: risk ? `${ref.revision}:${risk.ref.revision}` : ref.revision, tradingDate,
        symbols: included.map(member => member.symbol) },
    }));
  }
  signal?.throwIfAborted();
  const limits = [...limitsBySymbol.values()].map(({ ref, batch: { symbol, source, endpoint, observedAt, coverage, requested } }) => ({
    ref, symbol, source, endpoint, observedAt, coverage, requested,
  })).sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { calendar: { zone: "Asia/Shanghai" as const, sessions }, input: { tradingLimits: limits }, rows };
}

/** Reopen dated market and exchange-limit archives and calculate the displayed ladder. */
export function replayTspMarketLadders(request: MarketLadderReplayRequest, signal?: AbortSignal) {
  return projectMarketLadderReplay(request, ({ universe, observations, ...row }) => {
    let known = 0, observed = 0;
    for (const { limitDown } of observations) {
      if (limitDown !== null) known++;
      if (limitDown === true) observed++;
    }
    return {
      ...row,
      metrics: universe ? computeTspMarketLadder(universe, row.previousTradingDate, observations) : null,
      ...(universe && { limitDown: { known, observed } }),
    };
  }, signal);
}

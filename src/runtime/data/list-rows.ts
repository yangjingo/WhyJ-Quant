import { isDailyDate } from "../../market/bars.ts";
import { computeTspLimitStreaks, computeTspListIntraday, TSP_INDICATOR_REVISION, TSP_LIMIT_STREAK_FORMULA_VERSION } from "../../quant/index.ts";
import { TICKFLOW_SYMBOL_BATCH_SIZE, type SourceRequestOptions } from "../../source/index.ts";
import { loadDailyTradingLimitArchive, loadMarketCrossSectionArchive, loadPanelPortfolio, loadTradingDateArchive,
  type DatedStockMinuteArchiveRef, type FinancialObservationArchiveRef, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef, type TradingLimitArchiveRef } from "../../storage/index.ts";
import { replayFinancialResearchInputs } from "./financial-input-replay.ts";
import { archivedListLiquidity } from "./list-liquidity.ts";
import { resolveTspArchiveIndicators, type DailySignalExchangeRefs } from "./observation-collection.ts";
import { replayTspPriceDeviation, type PriceDeviationReplayRequest } from "./price-deviation-replay.ts";
import { replayTspScreenerUnion, type ScreenerUnionReplayRequest } from "./screener-replay.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";
import { resolveTickFlowStockMinutes, type TickFlowStockMinuteReplayRequest } from "./tickflow-stock-minute-replay.ts";
import { projectTspWatchlistReturn, resolveTspWatchlistMembership } from "./watchlist-return.ts";

type ListCalendar = { revision: string; sessions: readonly string[] };
type ListDeviationRequest = Pick<PriceDeviationReplayRequest, "stockRef" | "benchmarkRef">;

function validateListCalendar(calendar: ListCalendar, tradeDate: string, kind: "limit" | "deviation") {
  if (!calendar || typeof calendar.revision !== "string" || !calendar.revision.trim() || calendar.revision.length > 256 ||
    !Array.isArray(calendar.sessions) || calendar.sessions.at(-1) !== tradeDate ||
    calendar.sessions.some((date, index, sessions) => typeof date !== "string" || date < "0001-01-01" ||
      !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!))) {
    throw new Error(`List ${kind} calendar must contain ordered sessions ending at the trade date`);
  }
}

async function readListDeviation(symbol: string, sessions: readonly string[], request: ListDeviationRequest, signal?: AbortSignal) {
  const { calendar: _calendar, rows, proximity: { rows: proximityRows, ...proximity }, ...evidence } =
    await replayTspPriceDeviation({ ...request, symbol, sessions }, signal);
  return { ...evidence, ...rows.at(-1)!, proximity: { ...proximity, ...proximityRows.at(-1)! } };
}

export type TspListIntradayRequest = Omit<TickFlowStockMinuteReplayRequest, "refs"> & { ref: DatedStockMinuteArchiveRef };

async function readListIntraday(symbol: string, tradeDate: string, request: TspListIntradayRequest, signal?: AbortSignal) {
  const { ref, interpretation, previousClose } = request;
  const { completed, preview, archives } = await resolveTickFlowStockMinutes({ refs: [ref], interpretation, previousClose }, signal);
  const receipt = preview.input.archives[0]!;
  if (receipt.symbol !== symbol || receipt.tradeDate !== tradeDate) {
    throw new Error("Intraday archive does not match the list symbol or trading date");
  }
  const prior = preview.input.previousClose?.rows[0]?.price ?? null;
  const report = computeTspListIntraday({ tradeDate, bars: completed, previousClose: prior !== null && prior > 0 ? prior : null });
  return {
    observation: { ...receipt, rows: archives[0]!.archive.rows, interpretation: preview.input.interpretation,
      previousClose: preview.input.previousClose, excluded: preview.excluded },
    metrics: { ...report, points: report.points.map((point, index) => ({ ...point, sourceTimestamp: completed[index]!.sourceTimestamp })) },
  };
}

export interface TspListRowsRequest {
  marketRef: MarketCrossSectionArchiveRef;
  adjustment: "none" | "forward";
  screener?: Pick<ScreenerUnionReplayRequest, "histories" | "strategies">;
  limitCalendar?: ListCalendar;
  deviationCalendar?: ListCalendar;
  watchlistMembershipRevision?: string;
  stocks: readonly {
    symbol: string;
    history?: { ref: TradingDateArchiveRef; exchange?: DailySignalExchangeRefs; candleBars?: number };
    watchlistHistoryRef?: TradingDateArchiveRef;
    tradingLimitsRef?: TradingLimitArchiveRef;
    deviation?: ListDeviationRequest;
    intraday?: TspListIntradayRequest;
    financialArchives?: readonly FinancialObservationArchiveRef[];
  }[];
}

/** Join fixed market observations and same-day WHYJ calculations for either stock list. */
export async function replayTspListRows(request: TspListRowsRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { marketRef, adjustment, stocks, limitCalendar, watchlistMembershipRevision, screener, deviationCalendar } = structuredClone(request);
  if (adjustment !== "none" && adjustment !== "forward") throw new Error("Invalid list price basis");
  if (watchlistMembershipRevision === undefined ? stocks.some(stock => stock.watchlistHistoryRef !== undefined) :
    typeof watchlistMembershipRevision !== "string" || !/^[a-f0-9]{64}$/.test(watchlistMembershipRevision)) {
    throw new Error("List watchlist history requires a valid membership revision");
  }
  const portfolio = watchlistMembershipRevision === undefined ? undefined : loadPanelPortfolio();
  if (portfolio && portfolio.revision !== watchlistMembershipRevision) throw new Error("Saved watchlist membership revision changed.");
  if (deviationCalendar === undefined && stocks.some(stock => stock.deviation !== undefined)) {
    throw new Error("List price deviation requires a deviation calendar");
  }
  const { source, market, tradeDate, universe, bars, basics } = await loadMarketCrossSectionArchive(marketRef, signal);
  if (limitCalendar !== undefined) validateListCalendar(limitCalendar, tradeDate, "limit");
  if (deviationCalendar !== undefined) validateListCalendar(deviationCalendar, tradeDate, "deviation");
  const calendarDates = limitCalendar && new Set(limitCalendar.sessions);
  const { members, ...rosterObservation } = universe;
  const { rows: barRows, ...dailyObservation } = bars;
  const { rows: basicRows, ...dailyBasicObservation } = basics;
  const roster = new Map(members.map(member => [member.symbol, member]));
  const symbols = stocks.map(stock => stock.symbol);
  if (new Set(symbols).size !== symbols.length || symbols.some(symbol => !roster.has(symbol))) {
    throw new Error("Duplicate list symbol or symbol absent from the archived roster");
  }
  const union = screener === undefined ? undefined : await replayTspScreenerUnion({ ...screener, marketRef, adjustment }, signal);
  const unionRows = new Map(union?.rows.map(({ symbol, ...match }, index) => [symbol, { ...match, position: index + 1 }]));
  const strategyEvaluations = union?.replays.map(({ ranking, evaluated }) => ({
    strategyId: ranking.strategy.id,
    statuses: new Map(evaluated.map(({ symbol, status }) => [symbol, status])),
  }));
  const barsBySymbol = new Map(barRows.map(row => [row.symbol, row]));
  const basicsBySymbol = new Map(basicRows.map(row => [row.symbol, row]));
  const rows = [];
  for (const { symbol, history, financialArchives, tradingLimitsRef, watchlistHistoryRef, deviation, intraday } of stocks) {
    signal?.throwIfAborted();
    const membership = portfolio && resolveTspWatchlistMembership(portfolio, symbol);
    if (history?.exchange && tradingLimitsRef !== undefined) throw new Error("List stock has competing trading limit references");
    const bar = barsBySymbol.get(symbol) ?? null;
    const basic = basicsBySymbol.get(symbol) ?? null;
    const { volumeShares, metrics: liquidity } = archivedListLiquidity(bar, basic);
    const amountCny = bar?.amount != null ? bar.amount * 1_000 : null;
    if (amountCny !== null && !Number.isFinite(amountCny)) throw new Error("List traded amount overflow");
    const candleBars = history?.candleBars;
    if (candleBars !== undefined && (!Number.isInteger(candleBars) || candleBars < 5 || candleBars > 60)) {
      throw new Error("List candle window must be an integer from 5 to 60");
    }
    const resolved = history ? await resolveTspArchiveIndicators(history.ref, signal, history.exchange) : null;
    const derived = resolved?.preview ?? null;
    if (derived && (derived.input.symbol !== symbol || derived.input.adjustment !== adjustment ||
      derived.input.lastTradeDate > tradeDate)) throw new Error("List history has a mismatched symbol, price basis or future trade date");
    const dailyCandles = resolved && candleBars !== undefined ? {
      ref: resolved.preview.archiveRef,
      ...resolved.preview.input,
      requestedBars: candleBars,
      volumeUnit: resolved.records[0]!.volumeUnit,
      amountUnit: resolved.records[0]!.amountUnit,
      rows: resolved.records.slice(-candleBars).map(({ tradeDate, sourceTimestamp, values }) => ({ tradeDate, sourceTimestamp, ...values })),
    } : undefined;
    const sameDay = derived?.input.lastTradeDate === tradeDate;
    let watchlistReturn = null;
    if (membership && watchlistHistoryRef !== undefined) {
      const records = await loadTradingDateArchive(watchlistHistoryRef, signal);
      if (records[0]!.symbol !== symbol) throw new Error("Watchlist return archive does not match the list stock");
      const result = projectTspWatchlistReturn(watchlistHistoryRef, tradeDate, records, membership);
      watchlistReturn = { ...result.metrics, history: result.input.history };
    }
    const financial = financialArchives === undefined ? undefined : (await replayFinancialResearchInputs({
      symbol, tradingDates: [tradeDate], references: financialArchives,
    }, signal))[0]!;
    const limitArchive = resolved?.tradingLimits ?? (tradingLimitsRef === undefined ? undefined : {
      ref: tradingLimitsRef, ...await loadDailyTradingLimitArchive(tradingLimitsRef, signal),
    });
    if (limitArchive && limitArchive.symbol !== symbol) throw new Error("List trading limits do not match the stock");
    let tradingLimits;
    if (limitArchive) {
      const { rows, ...evidence } = limitArchive;
      tradingLimits = { ...evidence, row: rows.find(row => row.tradeDate === tradeDate) ?? null };
    }
    const latestStreak = limitCalendar && calendarDates && resolved?.tradingLimits ?
      computeTspLimitStreaks(limitCalendar.sessions, resolved.preview.dailySignals.rows.filter(row => calendarDates.has(row.date))).at(-1) : undefined;
    const limitStreaks = limitCalendar && {
      producer: "whyj" as const,
      formula: { id: "tsp_limit_streaks" as const, version: TSP_LIMIT_STREAK_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
      consecutiveLimitUps: latestStreak?.consecutiveLimitUps ?? null,
      consecutiveLimitDowns: latestStreak?.consecutiveLimitDowns ?? null,
    };
    const deviationResult = deviation !== undefined && deviationCalendar
      ? await readListDeviation(symbol, deviationCalendar.sessions, deviation, signal)
      : undefined;
    const match = unionRows.get(symbol);
    const minuteEvidence = intraday === undefined ? undefined : await readListIntraday(symbol, tradeDate, intraday, signal);
    rows.push({
      instrument: roster.get(symbol)!,
      ...(membership && { membership }),
      observations: { bar, basic, quantities: { volumeShares, amountCny },
        ...(financial === undefined ? {} : { financial }), ...(tradingLimits && { tradingLimits }),
        ...(dailyCandles && { dailyCandles }), ...(minuteEvidence && { intraday: minuteEvidence.observation }) },
      metrics: {
        liquidity,
        ...(membership && { watchlistReturn }),
        history: derived && { ref: derived.archiveRef, ...derived.input },
        daily: sameDay ? { producer: derived.daily.producer, formula: derived.daily.formula, ...derived.daily.rows.at(-1)! } : null,
        signals: sameDay ? {
          producer: derived.dailySignals.producer, formula: derived.dailySignals.formula,
          exchangeInputs: derived.dailySignals.exchangeInputs ?? null, ...derived.dailySignals.rows.at(-1)!,
        } : null,
        ...(limitStreaks && { limitStreaks }),
        ...(deviationResult && { deviation: deviationResult }),
        ...(strategyEvaluations && { screener: {
          producer: "whyj" as const,
          position: match?.position ?? null,
          score: match?.score ?? null,
          scoreStrategyId: match?.scoreStrategyId ?? null,
          hits: match?.hits ?? [],
          evaluations: strategyEvaluations.map(({ strategyId, statuses }) => ({
            strategyId, status: statuses.get(symbol) ?? "outside-scope" as const,
          })),
        } }),
        ...(minuteEvidence && { intraday: minuteEvidence.metrics }),
      },
    });
  }
  signal?.throwIfAborted();
  return {
    marketRef, source, market, tradeDate, adjustment, rows,
    ...(limitCalendar && { limitCalendar: { ...limitCalendar, zone: "Asia/Shanghai" as const } }),
    ...(deviationCalendar && { deviationCalendar: { ...deviationCalendar, zone: "Asia/Shanghai" as const } }),
    ...(union && { screener: {
      scoped: union.replays[0]!.coverage.scoped,
      matched: union.rows.length,
      strategies: union.replays.map(({ ranking: { strategy, formula, candidateRevision }, coverage, fieldSources }) => ({
        strategy, formula, candidateRevision, coverage, fieldSources,
      })),
    } }),
    observations: { roster: rosterObservation, daily: dailyObservation, dailyBasic: dailyBasicObservation },
  };
}

const shanghaiDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Read display-only quotes without replacing the fixed market observations or WHYJ calculations. */
export async function replayTspListRowsWithLiveQuotes(request: TspListRowsRequest, options: SourceRequestOptions = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  if (request.stocks.length > TICKFLOW_SYMBOL_BATCH_SIZE) throw new Error("Stock list quote scope exceeds one provider batch");
  const fixed = await replayTspListRows(request, signal);
  if (fixed.tradeDate !== shanghaiDay.format()) return { fixed, quotes: { status: "outside-current-day" as const } };
  if (!fixed.rows.length) return { fixed, quotes: { status: "empty" as const } };
  const symbols = fixed.rows.map(row => row.instrument.symbol);
  let batch;
  try {
    const source = await createConfiguredMarketDataSource(signal);
    batch = await source.fetchQuotes({ symbols }, options);
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    return { fixed, quotes: { status: "unavailable" as const } };
  }
  const { data, source, endpoint, observedAt, units } = batch;
  const quoteBySymbol = new Map(data.map(quote => [quote.symbol, quote]));
  const observedTime = Date.parse(observedAt);
  const rows = symbols.map(symbol => {
    const quote = quoteBySymbol.get(symbol);
    if (!quote) return { symbol, status: "missing" as const, sourceTimestamp: null };
    const sourceTimestamp = quote.timestamp;
    if (sourceTimestamp > observedTime) return { symbol, status: "future-timestamp" as const, sourceTimestamp };
    if (shanghaiDay.format(sourceTimestamp) !== fixed.tradeDate || shanghaiDay.format(observedTime) !== fixed.tradeDate) {
      return { symbol, status: "different-session" as const, sourceTimestamp };
    }
    if (quote.lastPrice <= 0) return { symbol, status: "missing-price" as const, sourceTimestamp };
    const changeAmount = quote.previousClose > 0 ? quote.lastPrice - quote.previousClose : null;
    const fraction = changeAmount === null ? null : changeAmount / quote.previousClose;
    return {
      symbol, status: "available" as const, sourceTimestamp, snapshot: quote,
      change: { producer: "whyj" as const, changeAmount, changeFraction: Number.isFinite(fraction) ? fraction : null },
    };
  });
  return { fixed, quotes: { status: "observed" as const, source, endpoint, observedAt, units, rows } };
}

import { randomUUID } from "node:crypto";
import { deriveTspArchiveAnalytics } from "../../runtime/data/archive-analytics.ts";
import { collectObservations, collectTradingDateObservations, collectTradingLimitObservations, deriveTspArchiveIndicators,
  type DailySignalExchangeRefs, type ObservationCollectionRequest } from "../../runtime/data/observation-collection.ts";
import { collectHistoricalMinuteObservations, deriveTspArchiveIntraday } from "../../runtime/data/intraday-replay.ts";
import { replayTspListRows, replayTspListRowsWithLiveQuotes, type TspListRowsRequest } from "../../runtime/data/list-rows.ts";
import { previewCurrentTspEtfIntraday, previewCurrentTspListIntraday } from "../../runtime/data/tickflow-stock-minute-replay.ts";
import { readTspListAuctionOverlay } from "../../runtime/data/tsp-list-auction-overlay.ts";
import { parseRegimeSummaryManifest } from "../../runtime/data/market-regime-manifest.ts";
import { replayTspMarketRegimeSummary } from "../../runtime/data/market-regime-summary-replay.ts";
import { loadMarketRegimeManifest } from "../../storage/index.ts";
import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol, isDatedEtfSymbol } from "../../market/symbols.ts";
import { TSP_DAILY_SIGNAL_FIELDS } from "../../quant/index.ts";
import type { ObservationAnalyticsPreview, ObservationCurrentEtfMinutesPreview, ObservationCurrentEtfMinutesRequest,
  ObservationCurrentStockMinutesPreview, ObservationCurrentStockMinutesRequest,
  ObservationIndicatorPreview, ObservationIntradayPreview, ObservationIntradayRequest,
  ObservationJobRequest, ObservationJobView, ObservationListAuctionOverlayPreview, ObservationListAuctionOverlayRequest,
  ObservationListIntradayRequest, ObservationListQuotesPreview, ObservationListRowsPreview,
  ObservationListRowsRequest, ObservationMarketRegimePreview } from "../../types/workbench.ts";
import type { ArchiveAnalyticsSupplements, FinancialObservationArchiveRef, TradingDateArchiveRef } from "../../types/observation.ts";
import { WorkbenchError } from "../workbench/errors.ts";

const invalid = () => new WorkbenchError("INPUT_INVALID", "采集参数无效。", 400);
const notFound = () => new WorkbenchError("OBSERVATION_JOB_NOT_FOUND", "未找到该采集任务。", 404);
const intervals = ["1m", "5m", "10m", "15m", "30m", "60m"];
const day = 86_400_000;
const revision = /^[a-f0-9]{64}$/;
const datedStock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalidReference = () => new WorkbenchError("INPUT_INVALID", "日线归档引用无效。", 400);

function dailyReference(value: unknown): TradingDateArchiveRef {
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "version") || !Object.hasOwn(value, "revision") ||
    value.version !== 2 || typeof value.revision !== "string" || !revision.test(value.revision)) throw invalidReference();
  return { version: 2, revision: value.revision };
}

function fixedReference<Kind extends "daily-trading-limits" | "historical-minute-bars" | "dated-stock-minute" | "market-cross-section" | "benchmark-index" |
  "market-regime-manifest" | "dated-etf-daily" | FinancialObservationArchiveRef["kind"]>(
  value: unknown, kind: Kind, error: () => WorkbenchError,
) {
  if (!object(value) || Object.keys(value).length !== 3 || !["version", "kind", "revision"].every(key => Object.hasOwn(value, key)) ||
    value.version !== 1 || value.kind !== kind || typeof value.revision !== "string" || !revision.test(value.revision)) throw error();
  return { version: 1 as const, kind, revision: value.revision };
}

async function replayIndicators(ref: TradingDateArchiveRef, exchange?: DailySignalExchangeRefs): Promise<ObservationIndicatorPreview> {
  try {
    return await deriveTspArchiveIndicators(ref, undefined, exchange);
  } catch {
    throw new WorkbenchError("OBSERVATION_ARCHIVE_UNAVAILABLE", exchange ? "无法读取指定的日线或限价归档。请核对归档引用后重试。"
      : "无法读取指定的日线归档。请核对归档引用后重试。", 404);
  }
}

export async function readObservationIndicators(value: unknown): Promise<ObservationIndicatorPreview> {
  return replayIndicators(dailyReference(value));
}

const invalidListRows = () => new WorkbenchError("INPUT_INVALID", "股票列表范围或归档引用无效。", 400);

function previousCloseReference(input: unknown, error: () => WorkbenchError): NonNullable<ObservationIntradayRequest["previousClose"]> {
  if (!object(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "ref") ||
    !Object.hasOwn(input, "priceBasis") || input.priceBasis !== "caller-confirmed-same-basis") throw error();
  return { ref: fixedReference(input.ref, "daily-trading-limits", error), priceBasis: input.priceBasis };
}

function listRowIntraday(value: unknown): ObservationListIntradayRequest {
  if (!object(value) || Object.keys(value).some(key => !["ref", "interpretation", "previousClose"].includes(key))) throw invalidListRows();
  const { interpretation } = value;
  if (!object(interpretation) || Object.keys(interpretation).some(key => !["timestampLabel", "priceBasis", "volumeUnit", "amountUnit"].includes(key))) {
    throw invalidListRows();
  }
  const { timestampLabel, priceBasis, volumeUnit, amountUnit } = interpretation;
  if ((timestampLabel !== "minute-start" && timestampLabel !== "minute-end") || priceBasis !== "caller-confirmed-unadjusted-CNY" ||
    (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw invalidListRows();
  return {
    ref: fixedReference(value.ref, "dated-stock-minute", invalidListRows),
    interpretation: { timestampLabel, priceBasis, volumeUnit, amountUnit },
    ...(Object.hasOwn(value, "previousClose") && { previousClose: previousCloseReference(value.previousClose, invalidListRows) }),
  };
}

function financialReferences(value: unknown, error: () => WorkbenchError): FinancialObservationArchiveRef[] {
  if (!Array.isArray(value)) throw error();
  const references = value.map((ref: unknown) => {
    if (!object(ref) || (ref.kind !== "report-financial-indicators" && ref.kind !== "financial-disclosure-dates")) {
      throw error();
    }
    return fixedReference(ref, ref.kind, error);
  });
  if (new Set(references.map(ref => ref.revision)).size !== references.length) throw error();
  return references;
}

function listExchangeReferences(value: unknown): DailySignalExchangeRefs {
  if (!object(value) || Object.keys(value).some(key => key !== "rawArchiveRef" && key !== "tradingLimitArchiveRef")) throw invalidListRows();
  return {
    tradingLimitArchiveRef: fixedReference(value.tradingLimitArchiveRef, "daily-trading-limits", invalidListRows),
    ...(Object.hasOwn(value, "rawArchiveRef") && { rawArchiveRef: dailyReference(value.rawArchiveRef) }),
  };
}

function listRowDeviation(value: unknown) {
  if (!object(value) || Object.keys(value).some(key => key !== "stockRef" && key !== "benchmarkRef")) throw invalidListRows();
  return { stockRef: dailyReference(value.stockRef),
    ...(Object.hasOwn(value, "benchmarkRef") && { benchmarkRef: fixedReference(value.benchmarkRef, "benchmark-index", invalidListRows) }) };
}

function listRowStock(value: unknown): ObservationListRowsRequest["stocks"][number] {
  if (!object(value) || Object.keys(value).some(key => !["symbol", "history", "financialArchives", "tradingLimitsRef", "intraday",
    "watchlistHistoryRef", "deviation"].includes(key)) ||
    typeof value.symbol !== "string" || !datedStock.test(value.symbol)) throw invalidListRows();
  const { symbol, history } = value;
  const hasTradingLimits = Object.hasOwn(value, "tradingLimitsRef");
  const stock = { symbol, ...(Object.hasOwn(value, "financialArchives") && {
    financialArchives: financialReferences(value.financialArchives, invalidListRows),
  }), ...(hasTradingLimits && {
    tradingLimitsRef: fixedReference(value.tradingLimitsRef, "daily-trading-limits", invalidListRows),
  }), ...(Object.hasOwn(value, "intraday") && {
    intraday: listRowIntraday(value.intraday),
  }), ...(Object.hasOwn(value, "watchlistHistoryRef") && {
    watchlistHistoryRef: dailyReference(value.watchlistHistoryRef),
  }), ...(Object.hasOwn(value, "deviation") && {
    deviation: listRowDeviation(value.deviation),
  }) };
  if (!Object.hasOwn(value, "history")) return stock;
  if (!object(history) || Object.keys(history).some(key => key !== "ref" && key !== "exchange" && key !== "candleBars")) throw invalidListRows();
  const { candleBars } = history;
  if (candleBars !== undefined && (typeof candleBars !== "number" || !Number.isInteger(candleBars) ||
    candleBars < 5 || candleBars > 60)) throw invalidListRows();
  const fixedHistory = { ref: dailyReference(history.ref), ...(candleBars !== undefined && { candleBars }) };
  if (!Object.hasOwn(history, "exchange")) return { ...stock, history: fixedHistory };
  if (hasTradingLimits) throw invalidListRows();
  return { ...stock, history: { ...fixedHistory, exchange: listExchangeReferences(history.exchange) } };
}

type ListScreenerScope = NonNullable<TspListRowsRequest["screener"]>;

function listScreenerStrategy(value: unknown): ListScreenerScope["strategies"][number] {
  if (!object(value) || Object.keys(value).some(key => !["strategy", "signalGate", "weights", "orderBy", "descending"].includes(key))) {
    throw invalidListRows();
  }
  const { strategy, signalGate, weights, orderBy, descending } = value;
  if (!object(strategy) || Object.keys(strategy).some(key => key !== "id" && key !== "revision") ||
    typeof strategy.id !== "string" || !strategy.id.trim() || strategy.id !== strategy.id.trim() ||
    typeof strategy.revision !== "string" || !revision.test(strategy.revision) || !Array.isArray(weights) ||
    (orderBy !== undefined && (typeof orderBy !== "string" || !orderBy.trim() || orderBy !== orderBy.trim())) ||
    (descending !== undefined && typeof descending !== "boolean")) throw invalidListRows();
  let gate: ListScreenerScope["strategies"][number]["signalGate"];
  if (signalGate !== undefined) {
    if (!object(signalGate) || Object.keys(signalGate).some(key => key !== "mode" && key !== "signals") ||
      (signalGate.mode !== "any" && signalGate.mode !== "all") || !Array.isArray(signalGate.signals) ||
      !signalGate.signals.length || new Set(signalGate.signals).size !== signalGate.signals.length) throw invalidListRows();
    gate = { mode: signalGate.mode, signals: signalGate.signals.map((value: unknown) => {
      const signal = TSP_DAILY_SIGNAL_FIELDS.find(id => id === value);
      if (!signal) throw invalidListRows();
      return signal;
    }) };
  }
  return {
    strategy: { id: strategy.id, revision: strategy.revision }, orderBy, descending, signalGate: gate,
    weights: weights.map((entry: unknown) => {
      if (!object(entry) || Object.keys(entry).some(key => !["field", "weight", "direction"].includes(key)) ||
        typeof entry.field !== "string" || !entry.field.trim() || entry.field !== entry.field.trim() ||
        typeof entry.weight !== "number" || !Number.isFinite(entry.weight) || entry.weight < 0 ||
        (entry.direction !== undefined && entry.direction !== "low" && entry.direction !== "high")) throw invalidListRows();
      return { field: entry.field, weight: entry.weight, direction: entry.direction };
    }),
  };
}

function listScreenerScope(value: unknown): ListScreenerScope {
  if (!object(value) || Object.keys(value).some(key => key !== "histories" && key !== "strategies") ||
    !Array.isArray(value.histories) || !Array.isArray(value.strategies) || !value.strategies.length) throw invalidListRows();
  const histories = value.histories.map((entry: unknown) => {
    if (!object(entry) || Object.keys(entry).some(key => !["symbol", "ref", "exchange"].includes(key)) ||
      typeof entry.symbol !== "string" || !datedStock.test(entry.symbol)) throw invalidListRows();
    return { symbol: entry.symbol, ref: dailyReference(entry.ref),
      ...(Object.hasOwn(entry, "exchange") && { exchange: listExchangeReferences(entry.exchange) }) };
  });
  const strategies = value.strategies.map(listScreenerStrategy);
  if (new Set(histories.map(row => row.symbol)).size !== histories.length ||
    new Set(strategies.map(row => row.strategy.id)).size !== strategies.length) throw invalidListRows();
  return { histories, strategies };
}

function listCalendar(value: unknown): NonNullable<ObservationListRowsRequest["limitCalendar"]> {
  if (!object(value) || Object.keys(value).some(key => key !== "revision" && key !== "sessions") ||
    typeof value.revision !== "string" || !value.revision.trim() || value.revision.length > 256 ||
    !Array.isArray(value.sessions) || value.sessions.length === 0) throw invalidListRows();
  const sessions: string[] = [];
  for (const date of value.sessions) {
    if (typeof date !== "string" || date < "0001-01-01" || !isDailyDate(date) || date <= (sessions.at(-1) ?? "")) throw invalidListRows();
    sessions.push(date);
  }
  return { revision: value.revision, sessions };
}

async function readListArchive<T>(
  value: unknown, read: (request: TspListRowsRequest, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!object(value) || Object.keys(value).some(key => !["marketRef", "adjustment", "stocks", "limitCalendar", "watchlistMembershipRevision",
    "screener", "deviationCalendar"].includes(key)) ||
    !["marketRef", "adjustment", "stocks"].every(key => Object.hasOwn(value, key)) ||
    (value.adjustment !== "none" && value.adjustment !== "forward") ||
    !Array.isArray(value.stocks) || value.stocks.length > 100) throw invalidListRows();
  const marketRef = fixedReference(value.marketRef, "market-cross-section", invalidListRows);
  const stocks = value.stocks.map(listRowStock);
  const limitCalendar = Object.hasOwn(value, "limitCalendar") ? listCalendar(value.limitCalendar) : undefined;
  const deviationCalendar = Object.hasOwn(value, "deviationCalendar") ? listCalendar(value.deviationCalendar) : undefined;
  const screener = Object.hasOwn(value, "screener") ? listScreenerScope(value.screener) : undefined;
  const { watchlistMembershipRevision } = value;
  if (watchlistMembershipRevision !== undefined &&
    (typeof watchlistMembershipRevision !== "string" || !revision.test(watchlistMembershipRevision))) throw invalidListRows();
  if (watchlistMembershipRevision === undefined && stocks.some(stock => stock.watchlistHistoryRef !== undefined)) throw invalidListRows();
  if (deviationCalendar === undefined && stocks.some(stock => stock.deviation !== undefined)) throw invalidListRows();
  if (new Set(stocks.map(stock => stock.symbol)).size !== stocks.length) throw invalidListRows();
  try {
    return await read({ marketRef, adjustment: value.adjustment, stocks, limitCalendar, watchlistMembershipRevision, screener,
      deviationCalendar }, AbortSignal.timeout(25_000));
  } catch {
    throw new WorkbenchError("OBSERVATION_ARCHIVE_UNAVAILABLE", "无法读取指定的股票列表归档。请核对归档引用后重试。", 404);
  }
}

export function readObservationListRows(value: unknown): Promise<ObservationListRowsPreview> {
  return readListArchive(value, replayTspListRows);
}

export function readObservationListQuotes(value: unknown): Promise<ObservationListQuotesPreview> {
  return readListArchive(value, (request, signal) => replayTspListRowsWithLiveQuotes(request, { signal, timeoutMs: 10_000 }));
}

function currentMinuteInterpretation(value: Record<string, unknown>, error: () => WorkbenchError): ObservationCurrentStockMinutesRequest["interpretation"] {
  if (!Object.hasOwn(value, "interpretation")) return undefined;
  const input = value.interpretation;
  if (!object(input) || Object.keys(input).some(key => !["timestampLabel", "priceBasis"].includes(key)) ||
    (input.timestampLabel !== "minute-start" && input.timestampLabel !== "minute-end") ||
    input.priceBasis !== "caller-confirmed-unadjusted-CNY") throw error();
  return { timestampLabel: input.timestampLabel, priceBasis: input.priceBasis };
}

export async function readObservationCurrentStockMinutes(value: unknown): Promise<ObservationCurrentStockMinutesPreview> {
  const error = () => new WorkbenchError("INPUT_INVALID", "当日股票分时范围或昨收引用无效。", 400);
  if (!object(value) || Object.keys(value).some(key => !["tradeDate", "stocks", "interpretation"].includes(key)) ||
    value.tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(value.stocks) ||
    !value.stocks.length || value.stocks.length > 100) throw error();
  const interpretation = currentMinuteInterpretation(value, error);
  const seen = new Set<string>();
  const stocks = value.stocks.map((stock: unknown) => {
    if (!object(stock) || Object.keys(stock).some(key => !["symbol", "previousClose"].includes(key))) throw error();
    const code = typeof stock.symbol === "string" ? stock.symbol.trim().toUpperCase() : "";
    if (!datedStock.test(code) || isAIndexSymbol(code) || seen.has(code) ||
      (Object.hasOwn(stock, "previousClose") && !interpretation)) throw error();
    seen.add(code);
    return { symbol: code, ...(Object.hasOwn(stock, "previousClose") && { previousClose: previousCloseReference(stock.previousClose, error) }) };
  });
  try {
    return await previewCurrentTspListIntraday({ tradeDate: value.tradeDate, stocks, interpretation },
      { signal: AbortSignal.timeout(25_000), timeoutMs: 10_000 });
  } catch {
    throw new WorkbenchError("OBSERVATION_COLLECTION_FAILED", "无法读取指定的当日股票分时。请核对数据源和昨收引用后重试。", 502);
  }
}

function etfMinutePreviousClose(value: unknown, tradeDate: string, error: () => WorkbenchError):
  NonNullable<ObservationCurrentEtfMinutesRequest["etfs"][number]["previousClose"]> {
  if (!object(value) || Object.keys(value).some(key => !["dailyRef", "calendar", "priceBasis"].includes(key)) ||
    value.priceBasis !== "caller-confirmed-same-basis" || !object(value.calendar)) throw error();
  const { calendar, priceBasis } = value;
  const { revision: calendarRevision, previousTradeDate, tradeDate: current } = calendar;
  if (Object.keys(calendar).some(key => !["revision", "previousTradeDate", "tradeDate"].includes(key)) ||
    typeof calendarRevision !== "string" || !calendarRevision.trim() || typeof previousTradeDate !== "string" ||
    !isDailyDate(previousTradeDate) || current !== tradeDate || previousTradeDate >= tradeDate) throw error();
  return { dailyRef: fixedReference(value.dailyRef, "dated-etf-daily", error),
    calendar: { revision: calendarRevision, previousTradeDate, tradeDate }, priceBasis };
}

export async function readObservationCurrentEtfMinutes(value: unknown): Promise<ObservationCurrentEtfMinutesPreview> {
  const error = () => new WorkbenchError("INPUT_INVALID", "当日 ETF 分时范围或昨收引用无效。", 400);
  if (!object(value) || Object.keys(value).some(key => !["tradeDate", "etfs", "interpretation"].includes(key)) ||
    value.tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(value.etfs) || !value.etfs.length || value.etfs.length > 100) throw error();
  const { tradeDate } = value;
  const interpretation = currentMinuteInterpretation(value, error);
  const seen = new Set<string>();
  const etfs = value.etfs.map((etf: unknown) => {
    if (!object(etf) || Object.keys(etf).some(key => !["symbol", "previousClose"].includes(key))) throw error();
    const symbol = typeof etf.symbol === "string" ? etf.symbol.trim().toUpperCase() : "";
    if (!isDatedEtfSymbol(symbol) || seen.has(symbol)) throw error();
    seen.add(symbol);
    if (!Object.hasOwn(etf, "previousClose")) return { symbol };
    if (!interpretation) throw error();
    return { symbol, previousClose: etfMinutePreviousClose(etf.previousClose, tradeDate, error) };
  });
  try {
    return await previewCurrentTspEtfIntraday({ tradeDate, etfs, interpretation },
      { signal: AbortSignal.timeout(25_000), timeoutMs: 10_000 });
  } catch {
    throw new WorkbenchError("OBSERVATION_COLLECTION_FAILED", "无法读取指定的当日 ETF 分时。请核对数据源和昨收引用后重试。", 502);
  }
}

function listAuctionRequest(value: unknown): ObservationListAuctionOverlayRequest {
  const error = () => new WorkbenchError("INPUT_INVALID", "集合竞价清单的扩展表、日期、标的或字段映射无效。", 400);
  if (!object(value) || Object.keys(value).some(key => !["datasetId", "date", "symbols", "fields", "timeBasis"].includes(key))) throw error();
  const { datasetId, date, symbols, fields, timeBasis } = value;
  if (typeof datasetId !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(datasetId) || typeof date !== "string" || !isDailyDate(date) ||
    timeBasis !== "caller-confirmed-shanghai-wall-clock" || !Array.isArray(symbols) || !symbols.length || symbols.length > 100 ||
    new Set(symbols).size !== symbols.length || symbols.some(symbol => typeof symbol !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(symbol)) ||
    !object(fields) || Object.keys(fields).some(role => !["price", "matchedQuantity", "unmatchedQuantity"].includes(role))) throw error();
  const fieldName = (name: unknown) => {
    if (typeof name !== "string" || !name.length || name.length > 256 || name !== name.trim() || /[,\u0000-\u001f]/.test(name)) throw error();
    return name;
  };
  const price = fieldName(fields.price);
  const matchedQuantity = fields.matchedQuantity === undefined ? undefined : fieldName(fields.matchedQuantity);
  const unmatchedQuantity = fields.unmatchedQuantity === undefined ? undefined : fieldName(fields.unmatchedQuantity);
  const names = [price, matchedQuantity, unmatchedQuantity].filter(name => name !== undefined);
  if (new Set(names).size !== names.length) throw error();
  return { datasetId, date, symbols, fields: { price, matchedQuantity, unmatchedQuantity }, timeBasis };
}

export async function readObservationListAuctionOverlay(value: unknown): Promise<ObservationListAuctionOverlayPreview> {
  const request = listAuctionRequest(value);
  try {
    const { input, overlay } = await readTspListAuctionOverlay(request, { signal: AbortSignal.timeout(25_000), timeoutMs: 10_000 });
    const summarize = (capture: typeof input.price): ObservationListAuctionOverlayPreview["input"]["price"] => ({
      source: capture.source, originalPublisher: capture.originalPublisher, field: capture.request.field, revision: capture.revision,
      valueUnit: capture.valueUnit, observedAt: capture.observedAt,
      series: capture.series.map(({ symbol, points }) => ({
        symbol, status: points === null ? "missing" : points.length ? "observed" : "empty", pointCount: points?.length ?? 0,
      })),
    });
    return { input: { datasetId: request.datasetId, timeBasis: input.timeBasis, price: summarize(input.price),
      matchedQuantity: input.matchedQuantity && summarize(input.matchedQuantity),
      unmatchedQuantity: input.unmatchedQuantity && summarize(input.unmatchedQuantity) }, overlay };
  } catch {
    throw new WorkbenchError("OBSERVATION_COLLECTION_FAILED", "无法读取指定的集合竞价数据。请核对 TSP 连接、扩展表和字段后重试。", 502);
  }
}

export async function readObservationMarketRegime(value: unknown): Promise<ObservationMarketRegimePreview> {
  const manifestRef = fixedReference(value, "market-regime-manifest",
    () => new WorkbenchError("INPUT_INVALID", "市场状态清单引用无效。", 400));
  const signal = AbortSignal.timeout(50_000);
  try {
    const request = parseRegimeSummaryManifest(await loadMarketRegimeManifest(manifestRef, signal));
    const { summary, history, mainline } = await replayTspMarketRegimeSummary(request, signal);
    const { sessions, zone } = history.calendar;
    const conceptsByDate = new Map(mainline?.rows.map(row => [row.tradingDate, row]));
    const rows = history.rows.filter(row => !request.window ||
      (row.tradingDate >= request.window.start && row.tradingDate <= request.window.end));
    return {
      manifestRef, calendar: { zone, start: sessions[0] ?? null, end: sessions.at(-1) ?? null, sessions: sessions.length },
      universe: history.universe, phase: history.phase, summary,
      rows: rows.map(({ tradingDate, regime, ladder, phase, daily, inputs }) => {
        const { market, benchmark } = inputs;
        const conceptDay = conceptsByDate.get(tradingDate);
        const sector = conceptDay?.input.sector;
        return {
          tradingDate, regime: regime && { state: regime.state, score: regime.score, label: regime.label,
            dimensions: regime.dimensions, formula: regime.formula },
          phase: phase.phase, phaseFutureFields: phase.futureFields, daily,
          ladder: ladder?.ladder ? {
            ...ladder.ladder, promotionFraction: ladder.promotion.fraction, observedPromotionPool: ladder.promotion.observedCandidates,
            sealFraction: ladder.seal.fraction ?? ladder.seal.regimeFraction,
          } : null,
          market: market && { ref: market.ref, source: market.source, observedAt: market.barsObservedAt },
          benchmark: benchmark && { ref: benchmark.ref, returnPct: benchmark.returnPct },
          concepts: sector ? { catalogRef: sector.catalogRef, archivedGroups: sector.coverage.archivedGroups,
            catalogGroups: sector.coverage.catalogGroups,
            ranks: conceptDay?.mainline?.rows.map(({ name, score, rank, maxBoards, leaderSymbol }) =>
              ({ name, score, rank, maxBoards, leaderSymbol })) ?? null } : null,
        };
      }),
    };
  } catch {
    throw new WorkbenchError("OBSERVATION_ARCHIVE_UNAVAILABLE", "无法回放市场状态。请核对清单和所需归档后重试。", 404);
  }
}

function analyticsSupplements(value: Record<string, unknown>): ArchiveAnalyticsSupplements {
  const error = () => new WorkbenchError("INPUT_INVALID", "研究因子归档引用无效。", 400);
  if (Object.keys(value).some(key => !["archiveRef", "turnoverArchives", "financialArchives", "bookValueBasis"].includes(key))) {
    throw error();
  }
  const supplements: ArchiveAnalyticsSupplements = {};
  if (Object.hasOwn(value, "turnoverArchives")) {
    if (!Array.isArray(value.turnoverArchives) || value.turnoverArchives.length > 366) throw error();
    const refs = value.turnoverArchives.map(ref => fixedReference(ref, "market-cross-section", error));
    if (new Set(refs.map(ref => ref.revision)).size !== refs.length) throw error();
    supplements.turnoverArchives = refs;
  }
  if (Object.hasOwn(value, "financialArchives")) {
    supplements.financialArchives = financialReferences(value.financialArchives, error);
  }
  if (Object.hasOwn(value, "bookValueBasis")) {
    const confirmation = value.bookValueBasis;
    if (!object(confirmation) || Object.keys(confirmation).length !== 3 ||
      confirmation.basis !== "caller-confirmed-unadjusted-CNY" ||
      typeof confirmation.reportRevision !== "string" || !revision.test(confirmation.reportRevision) ||
      typeof confirmation.periodEnd !== "string" || !isDailyDate(confirmation.periodEnd) ||
      !supplements.financialArchives?.some(ref =>
        ref.kind === "report-financial-indicators" && ref.revision === confirmation.reportRevision)) throw error();
    supplements.bookValueBasis = {
      basis: confirmation.basis, reportRevision: confirmation.reportRevision, periodEnd: confirmation.periodEnd,
    };
  }
  return supplements;
}

export async function readObservationAnalytics(value: unknown): Promise<ObservationAnalyticsPreview> {
  const structured = object(value) && Object.hasOwn(value, "archiveRef");
  const ref = dailyReference(structured ? value.archiveRef : value);
  const supplements = structured ? analyticsSupplements(value) : undefined;
  try {
    return await deriveTspArchiveAnalytics(ref, AbortSignal.timeout(30_000), supplements);
  } catch {
    throw new WorkbenchError("OBSERVATION_ARCHIVE_UNAVAILABLE", structured
      ? "无法读取指定的研究证据归档。请核对归档引用后重试。"
      : "无法读取指定的日线归档。请核对归档引用后重试。", 404);
  }
}

export async function readObservationExchangeIndicators(value: unknown): Promise<ObservationIndicatorPreview> {
  const invalidExchangeReference = () => new WorkbenchError("INPUT_INVALID", "交易信号归档引用无效。", 400);
  if (!object(value) || !Object.hasOwn(value, "archiveRef") || !Object.hasOwn(value, "tradingLimitArchiveRef") ||
    Object.keys(value).some(key => !["archiveRef", "rawArchiveRef", "tradingLimitArchiveRef"].includes(key))) throw invalidExchangeReference();
  const ref = dailyReference(value.archiveRef);
  const rawArchiveRef = Object.hasOwn(value, "rawArchiveRef") ? dailyReference(value.rawArchiveRef) : undefined;
  const tradingLimitArchiveRef = fixedReference(value.tradingLimitArchiveRef, "daily-trading-limits", invalidExchangeReference);
  return replayIndicators(ref, { rawArchiveRef, tradingLimitArchiveRef });
}

export async function readObservationIntraday(value: unknown): Promise<ObservationIntradayPreview> {
  const invalidIntraday = () => new WorkbenchError("INPUT_INVALID", "分时日期或归档引用无效。", 400);
  if (!object(value) || !Object.hasOwn(value, "archiveRef") || !Object.hasOwn(value, "tradeDate") ||
    Object.keys(value).some(key => !["archiveRef", "tradeDate", "previousClose"].includes(key)) ||
    typeof value.tradeDate !== "string" || !isDailyDate(value.tradeDate)) throw invalidIntraday();
  const tradeDate = value.tradeDate;
  const ref = fixedReference(value.archiveRef, "historical-minute-bars", invalidIntraday);
  const previousClose = Object.hasOwn(value, "previousClose")
    ? previousCloseReference(value.previousClose, invalidIntraday)
    : undefined;
  let replay: Awaited<ReturnType<typeof deriveTspArchiveIntraday>>;
  try {
    replay = await deriveTspArchiveIntraday(ref, { previousClose, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new WorkbenchError("OBSERVATION_ARCHIVE_UNAVAILABLE", "无法读取指定的分时或昨收归档。请核对归档引用后重试。", 404);
  }
  const { startDate, endDate } = replay.input.requested;
  if (tradeDate < startDate || tradeDate > endDate) throw invalidIntraday();
  return {
    ...replay, tradeDate,
    openingBoundaries: replay.openingBoundaries.filter(row => row.tradeTime.slice(0, 10) === tradeDate),
    rows: replay.rows.filter(row => row.tradingDate === tradeDate).map(row => ({
      ...row, values: { ...row.values }, signals: { ...row.signals },
    })),
  };
}

/** Reject unknown properties, unbounded requests and credentials before acquiring a job. */
export function observationJobRequest(value: unknown): ObservationJobRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const { dataset, symbol, startTime, endTime, adjustment, interval } = input;
  if (dataset === "daily-trading-limits" || dataset === "historical-minute-bars") {
    const minutes = dataset === "historical-minute-bars";
    const { startDate, endDate } = input;
    const keys = ["dataset", "symbol", "startDate", "endDate"];
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) ||
      typeof symbol !== "string" || !datedStock.test(symbol) ||
      typeof startDate !== "string" || typeof endDate !== "string" || !isDailyDate(startDate) || !isDailyDate(endDate) ||
      startDate < (minutes ? "2010-01-01" : "0001-01-01") || endDate > "9998-12-31" || startDate > endDate ||
      Date.parse(endDate) - Date.parse(startDate) > (minutes ? 30 : 365) * day ||
      (minutes && endDate >= shanghaiDate.format())) throw invalid();
    return { dataset, symbol, startDate, endDate };
  }
  if (dataset === "daily" && input.timeMode === "trading-date") {
    const { startDate, endDate } = input;
    const keys = ["dataset", "timeMode", "symbol", "startDate", "endDate", "adjustment"];
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
      || typeof symbol !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)
      || typeof startDate !== "string" || typeof endDate !== "string" || !isDailyDate(startDate) || !isDailyDate(endDate)
      || startDate < "0001-01-01" || endDate > "9998-12-31" || startDate > endDate
      || Date.parse(endDate) - Date.parse(startDate) > 365 * day || (adjustment !== "none" && adjustment !== "forward")) throw invalid();
    return { dataset, timeMode: "trading-date", symbol, startDate, endDate, adjustment };
  }
  const keys = dataset === "factor" ? ["dataset", "symbol", "startTime", "endTime"]
    : dataset === "daily" ? ["dataset", "symbol", "startTime", "endTime", "adjustment"]
    : dataset === "minute" ? ["dataset", "symbol", "startTime", "endTime", "adjustment", "interval"] : [];
  if (!keys.length || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
    || typeof symbol !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)
    || typeof startTime !== "number" || !Number.isSafeInteger(startTime) || startTime <= 0
    || typeof endTime !== "number" || !Number.isSafeInteger(endTime) || endTime < startTime || endTime > 8_640_000_000_000_000
    || endTime - startTime > (dataset === "minute" ? 31 : dataset === "daily" ? 366 : 3660) * day
    || (dataset !== "factor" && adjustment !== "none" && adjustment !== "forward")
    || (dataset === "minute" && !intervals.includes(interval as string))) throw invalid();
  return { ...input } as ObservationJobRequest;
}
function runtimeRequest(input: Exclude<ObservationJobRequest,
  { timeMode: "trading-date" } | { dataset: "daily-trading-limits" | "historical-minute-bars" }>): ObservationCollectionRequest {
  if (input.dataset === "factor") return { dataset: "adjustment_factor", symbol: input.symbol, startTime: input.startTime, endTime: input.endTime };
  return { dataset: "bars", symbol: input.symbol, startTime: input.startTime, endTime: input.endTime,
    interval: input.dataset === "daily" ? "1d" : input.interval, adjustment: input.adjustment };
}
function isTradingDateRequest(input: ObservationJobRequest): input is Extract<ObservationJobRequest, { timeMode: "trading-date" }> {
  return "timeMode" in input && input.timeMode === "trading-date";
}
type Entry = { view: ObservationJobView; controller: AbortController; promise: Promise<void> };

/** Jobs are process-local. Completion reflects the collector's result, even after cancellation was requested. */
export function createObservationJobs(collect: typeof collectObservations = collectObservations,
  collectDates: typeof collectTradingDateObservations = collectTradingDateObservations,
  collectLimits: typeof collectTradingLimitObservations = collectTradingLimitObservations,
  collectMinutes: typeof collectHistoricalMinuteObservations = collectHistoricalMinuteObservations) {
  const jobs = new Map<string, Entry>();
  let closing = false;
  const view = (entry: Entry): ObservationJobView => structuredClone(entry.view);
  const get = (id: unknown): Entry => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw notFound();
    const entry = jobs.get(id); if (!entry) throw notFound(); return entry;
  };
  const start = (raw: unknown): ObservationJobView => {
    if (closing) throw new WorkbenchError("HOST_STOPPING", "服务正在停止。", 503);
    const request = observationJobRequest(raw);
    if ([...jobs.values()].some(entry => entry.view.status === "running")) throw new WorkbenchError("OBSERVATION_BUSY", "已有采集任务运行中。", 409);
    while (jobs.size >= 20) { const oldest = [...jobs].find(([, entry]) => entry.view.status !== "running"); if (!oldest) throw new WorkbenchError("OBSERVATION_BUSY", "采集任务已满。", 409); jobs.delete(oldest[0]); }
    const id = randomUUID(), controller = new AbortController();
    const entry: Entry = { controller, view: { id, request, status: "running", cancelRequested: false, receipt: null, error: null }, promise: Promise.resolve() };
    jobs.set(id, entry);
    entry.promise = Promise.resolve().then(async () => {
      const options = { signal: controller.signal };
      if (request.dataset === "daily-trading-limits") return collectLimits(request, options);
      if (request.dataset === "historical-minute-bars") return collectMinutes(request, options);
      if (isTradingDateRequest(request)) return collectDates({ timeMode: "trading-date", symbol: request.symbol, assetType: "stock",
        interval: "1d", adjustment: request.adjustment, startDate: request.startDate, endDate: request.endDate }, options);
      return collect(runtimeRequest(request), options);
    }).then(result => {
      entry.view.status = result.status;
      entry.view.receipt = { source: result.source, endpoint: result.endpoint, observedAt: result.observedAt, rowCount: result.rowCount, ref: result.ref };
    }, (error: unknown) => {
      const cancelled = controller.signal.aborted && (error === controller.signal.reason || (error instanceof Error && error.name === "AbortError"));
      entry.view.status = cancelled ? "cancelled" : "failed";
      entry.view.error = cancelled ? null : "COLLECTION_FAILED";
    });
    return view(entry);
  };
  const cancel = (id: unknown): ObservationJobView => {
    const entry = get(id);
    if (entry.view.status === "running") { entry.view.cancelRequested = true; entry.controller.abort(); }
    return view(entry);
  };
  const close = async () => { closing = true; for (const entry of jobs.values()) if (entry.view.status === "running") entry.controller.abort(); await Promise.allSettled([...jobs.values()].map(entry => entry.promise)); jobs.clear(); };
  return { start, read: (id: unknown) => view(get(id)), cancel, close };
}

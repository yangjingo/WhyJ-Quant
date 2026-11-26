import { open } from "node:fs/promises";
import { archiveMarketRegimeManifest, loadMarketRegimeManifest, MARKET_REGIME_MANIFEST_MAX_BYTES } from "../../../src/storage/index.ts";
import { isDailyDate } from "../../../src/market/bars.ts";
import { isAIndexSymbol, isDatedBenchmarkIndexSymbol, isDatedEtfSymbol } from "../../../src/market/symbols.ts";
import {
  computeTspBacktestPortfolio, computeTspBacktestRobustness, computeTspExtensionGroups, computeTspMiningCandidateReport,
  computeTspPaperStatistics, computeTspParameterRobustness, computeTspScreenerScores, computeTspWalkForward, evaluateTspStrategyGuardian,
  parseTspIntradaySignalRule, planTspStrategyGuardianCheck, replayTspPaperLedger, replayTspStrategyMonitor,
  summarizeTspStrategyGuardianHistory, tspMinuteIndex,
  TSP_DAILY_SIGNAL_FIELDS, TSP_INDICATOR_REVISION, TSP_MINING_MAX_FACTORS, TSP_PARAMETER_OBJECTIVES,
  TSP_SECTOR_MONITOR_WINDOWS, TSP_STRATEGY_GUARDIAN_FORMULA_VERSION, TSP_STRATEGY_MONITOR_EVENT_TYPES, type TspScreenerScoreInput,
  type TspBacktestPortfolioInput, type TspBacktestRobustnessInput, type TspParameterRobustnessInput,
  type TspMiningCandidateFoldEvidence, type TspMiningCandidateReportInput, type TspParameterSegmentEvidence, type TspWalkForwardInput,
  type TspStrategyGuardianCheckInput, type TspStrategyGuardianHistoryInput, type TspStrategyGuardianPlanInput,
  type TspStrategyGuardianThresholds, type TspStrategyMonitorCapture, type TspStrategyMonitorInput, type TspStrategyMonitorSignal,
  type TspExtensionGroupsInput, type TspMonitorCondition, type TspPaperLedgerEntry, type TspPaperLedgerInput, type TspPaperStatisticsInput,
} from "../../../src/quant/index.ts";
import { deriveTspArchiveAnalytics } from "../../../src/runtime/data/archive-analytics.ts";
import { replayTspAbnormalSnapshot, type AbnormalSnapshotReplayRequest } from "../../../src/runtime/data/abnormal-snapshot-replay.ts";
import { collectAuctionBenchmark, replayTspAuctionBenchmark, type AuctionBenchmarkReplayRequest } from "../../../src/runtime/data/auction-benchmark.ts";
import { collectBenchmarkIndexObservations } from "../../../src/runtime/data/benchmark-index-collection.ts";
import { replayTspDailyMonitorAlerts, TSP_DAILY_MONITOR_UNITS,
  type DailyMonitorAlertReplayRequest } from "../../../src/runtime/data/daily-monitor-alert-replay.ts";
import { collectDepthSnapshot } from "../../../src/runtime/data/depth-snapshot-collection.ts";
import { collectDragonTigerBoard, replayTspDragonTiger } from "../../../src/runtime/data/dragon-tiger.ts";
import { replayTspFactorEvaluation, replayTspFactorMiningScreen, replayTspFactorSignificance,
  type FactorEvaluationReplayRequest, type FactorMiningScreenReplayRequest,
  type FactorSignificanceReplayRequest } from "../../../src/runtime/data/factor-evaluation-replay.ts";
import { collectFinancialObservations, type FinancialCollectionRequest } from "../../../src/runtime/data/financial-collection.ts";
import { collectDatedEtfDailyBars } from "../../../src/runtime/data/etf-daily-observations.ts";
import { replayTspPaperComparison, replayTspPaperValuation, type PaperComparisonReplayRequest,
  type PaperValuationReplayRequest } from "../../../src/runtime/data/paper-valuation-replay.ts";
import { collectDatedIndexDailyBars, readDatedIndexDailyWithQuote, replayDatedIndexDailyBars } from "../../../src/runtime/data/index-daily-observations.ts";
import { collectDatedIndexMinutes, previewCurrentIndexMinutes, replayDatedIndexMinutes, type DatedIndexMinuteReplayRequest } from "../../../src/runtime/data/index-minute-observations.ts";
import { collectHistoricalMinuteObservations, deriveTspArchiveIntraday } from "../../../src/runtime/data/intraday-replay.ts";
import { replayTspIntradayMonitorAlerts, TSP_INTRADAY_MONITOR_SIGNALS, TSP_INTRADAY_MONITOR_UNITS,
  type IntradayMonitorAlertReplayRequest } from "../../../src/runtime/data/intraday-monitor-alert-replay.ts";
import { replayTspIntradaySignal } from "../../../src/runtime/data/intraday-signal-replay.ts";
import { collectMarketCrossSection, deriveTspMarketBreadthArchive } from "../../../src/runtime/data/market-cross-section.ts";
import { replayTspMarketEmotion, type MarketEmotionReplayRequest } from "../../../src/runtime/data/market-emotion-replay.ts";
import { replayTspMarketEnvironment } from "../../../src/runtime/data/market-environment-replay.ts";
import { replayTspMarketMainline } from "../../../src/runtime/data/market-mainline-replay.ts";
import {
  parseEnvironmentManifest as environmentManifest, parseExchangeSessions as exchangeSessions,
  parseMainlineManifest as mainlineManifest, parseMarketReplayScope as marketReplayScope,
  parseRegimeSummaryManifest as regimeSummaryManifest, parseSectorRefs as sectorRefs,
  validateRevisions as validateMarketRevisions,
} from "../../../src/runtime/data/market-regime-manifest.ts";
import { replayTspMarketRegimeSummary } from "../../../src/runtime/data/market-regime-summary-replay.ts";
import { collectDatedMoneyFlow, replayDatedMoneyFlow } from "../../../src/runtime/data/money-flow.ts";
import { collectTradingDateObservations, collectTradingLimitObservations, deriveTspArchiveIndicators } from "../../../src/runtime/data/observation-collection.ts";
import { collectDatedPopularityList, replayDatedPopularityList } from "../../../src/runtime/data/popularity-list.ts";
import { replayTspPriceDeviation, type PriceDeviationReplayRequest } from "../../../src/runtime/data/price-deviation-replay.ts";
import { collectTspQuoteMonitorAlerts, replayTspQuoteMonitorAlerts, TSP_QUOTE_MONITOR_UNITS,
  type CurrentQuoteMonitorRequest, type QuoteMonitorReplayRequest } from "../../../src/runtime/data/quote-monitor-alert-replay.ts";
import { collectQuotePollCapture, collectValuationQuotePollCapture, replayTspQuotePollDelta,
  type QuotePollReplayRequest } from "../../../src/runtime/data/quote-poll-replay.ts";
import { collectRiskWarningObservations } from "../../../src/runtime/data/risk-warning-collection.ts";
import { collectSectorObservations, type SectorCollectionRequest } from "../../../src/runtime/data/sector-collection.ts";
import { replayTspSectorMonitor, type SectorMonitorReplayRequest } from "../../../src/runtime/data/sector-monitor-replay.ts";
import { replayTspSectorRanking, type SectorRankReplayRequest } from "../../../src/runtime/data/sector-rank-replay.ts";
import { replayTspSectorRotation } from "../../../src/runtime/data/sector-rotation.ts";
import { readTspListAuctionOverlay, type TspListAuctionOverlayRequest } from "../../../src/runtime/data/tsp-list-auction-overlay.ts";
import { collectDatedTickFlowStockMinutes, previewCurrentTspEtfIntraday, previewCurrentTspListIntraday, replayTspTickFlowStockMinutes,
  type CurrentTspEtfIntradayRequest, type CurrentTspListIntradayRequest, type TickFlowStockMinuteReplayRequest } from "../../../src/runtime/data/tickflow-stock-minute-replay.ts";
import { replayTspWatchlistReturn } from "../../../src/runtime/data/watchlist-return.ts";
import { replayTspListLiquidity } from "../../../src/runtime/data/list-liquidity.ts";
import { replayTspListRows, replayTspListRowsWithLiveQuotes, type TspListRowsRequest } from "../../../src/runtime/data/list-rows.ts";
import { replayTspScreener, replayTspScreenerUnion, type ScreenerReplayRequest,
  type ScreenerUnionReplayRequest } from "../../../src/runtime/data/screener-replay.ts";

const dayMs = 86_400_000;
const usage = 'Use "whyj --json observation collect-daily|collect-minutes --symbol CODE --start YYYY-MM-DD --end YYYY-MM-DD" '
  + 'or "whyj --json observation replay-daily|replay-intraday|replay-analytics --revision SHA256". '
  + 'See whyj --help for financial collection and optional flags.';
const revisionPattern = /^[a-f0-9]{64}$/;
const factorKey = /^[a-z][a-z0-9_]{0,80}$/;
const datedStock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const compatiblePriceBasis = "caller-confirmed-same-basis";
const compatibleBookValueBasis = "caller-confirmed-unadjusted-CNY";
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const maxRevisionFileBytes = 512_000;
const maxObservationManifestBytes = 24 * 1_024 * 1_024;

function invalid() {
  return Object.assign(new Error(usage), { code: "invalid_arguments" });
}

function marketManifest<Args extends unknown[], Result>(parse: (...args: Args) => Result) {
  return (...args: Args): Result => {
    try { return parse(...args); } catch { throw invalid(); }
  };
}

const validateRevisions = marketManifest(validateMarketRevisions);
const parseExchangeSessions = marketManifest(exchangeSessions);
const parseMarketReplayScope = marketManifest(marketReplayScope);
const parseEnvironmentManifest = marketManifest(environmentManifest);
const parseSectorRefs = marketManifest(sectorRefs);
const parseMainlineManifest = marketManifest(mainlineManifest);
const parseRegimeSummaryManifest = marketManifest(regimeSummaryManifest);

function parseOptions(args: readonly string[], allowed: readonly string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("-") || options.has(flag)) throw invalid();
    options.set(flag, value);
  }
  return options;
}

async function readObservationJsonFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  try {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw invalid();
      const json = await file.readFile({ encoding: "utf8", signal });
      if (Buffer.byteLength(json) > maxBytes) throw invalid();
      return JSON.parse(json);
    } finally { await file.close(); }
  } catch { throw invalid(); }
}

async function readRevisionFile(path: string, signal?: AbortSignal): Promise<string[]> {
  return validateRevisions(await readObservationJsonFile(path, maxRevisionFileBytes, signal));
}

function parseRotationManifest(value: unknown): SectorRankReplayRequest[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 ||
      typeof item.marketRevision !== "string" || !revisionPattern.test(item.marketRevision) ||
      typeof item.catalogRevision !== "string" || !revisionPattern.test(item.catalogRevision)) throw invalid();
    const revisions = validateRevisions(item.memberRevisions);
    if (revisions.length >= 5_000) throw invalid();
    return {
      marketRef: { version: 1, kind: "market-cross-section", revision: item.marketRevision },
      catalogRef: { version: 1, kind: "dated-sector-catalog", revision: item.catalogRevision },
      memberRefs: revisions.map(revision => ({ version: 1, kind: "dated-sector-members", revision })),
    };
  });
}

function observationManifestObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}

function parseListAuctionOverlayManifest(value: unknown): TspListAuctionOverlayRequest {
  const { version, datasetId, date, symbols, fields, timeBasis } =
    observationManifestObject(value, ["version", "datasetId", "date", "symbols", "fields", "timeBasis"]);
  if (version !== 1 || typeof datasetId !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(datasetId) ||
    typeof date !== "string" || !isDailyDate(date) || date < "0001-01-01" || timeBasis !== "caller-confirmed-shanghai-wall-clock" ||
    !Array.isArray(symbols) || !symbols.length || symbols.length > 100 || new Set(symbols).size !== symbols.length ||
    symbols.some(symbol => typeof symbol !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(symbol))) throw invalid();
  const { price, matchedQuantity, unmatchedQuantity } = observationManifestObject(fields, ["price", "matchedQuantity", "unmatchedQuantity"]);
  const field = (name: unknown) => {
    if (typeof name !== "string" || !name.length || name.length > 256 || name.trim() !== name || /[,\u0000-\u001f]/.test(name)) throw invalid();
    return name;
  };
  const mapping = { price: field(price), matchedQuantity: matchedQuantity === undefined ? undefined : field(matchedQuantity),
    unmatchedQuantity: unmatchedQuantity === undefined ? undefined : field(unmatchedQuantity) };
  const names = Object.values(mapping).filter(name => name !== undefined);
  if (new Set(names).size !== names.length) throw invalid();
  return { datasetId, date, symbols, fields: mapping, timeBasis };
}

const archivedStockKeys = ["symbol", "dailyRevision", "limitsRevision", "rawRevision"] as const;

function parseArchivedStockHistory({ symbol, dailyRevision, limitsRevision, rawRevision }: Record<string, unknown>):
  AbnormalSnapshotReplayRequest["histories"][number] {
  if (typeof symbol !== "string" || !datedStock.test(symbol) || typeof dailyRevision !== "string" || !revisionPattern.test(dailyRevision) ||
    (limitsRevision !== undefined && (typeof limitsRevision !== "string" || !revisionPattern.test(limitsRevision))) ||
    (rawRevision !== undefined && (limitsRevision === undefined || typeof rawRevision !== "string" || !revisionPattern.test(rawRevision)))) {
    throw invalid();
  }
  return {
    symbol, ref: { version: 2, revision: dailyRevision },
    ...(limitsRevision && { exchange: {
      tradingLimitArchiveRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision },
      ...(rawRevision && { rawArchiveRef: { version: 2, revision: rawRevision } }),
    } }),
  };
}

function parseArchivedStockHistories(histories: unknown): AbnormalSnapshotReplayRequest["histories"] {
  if (!Array.isArray(histories)) throw invalid();
  return histories.map(item => parseArchivedStockHistory(observationManifestObject(item, archivedStockKeys)));
}

function parseMonitorRoster(value: unknown): string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
    value.some(symbol => typeof symbol !== "string" || !datedStock.test(symbol) || isAIndexSymbol(symbol))) throw invalid();
  return value;
}

function validateMonitorHistories(histories: readonly { symbol: string }[], roster: ReadonlySet<string>) {
  const referenced = new Set(histories.map(history => history.symbol));
  if (referenced.size !== histories.length || histories.some(history => !roster.has(history.symbol))) throw invalid();
}

function parseMonitorRule(value: unknown, roster: ReadonlySet<string>, signalFields: readonly string[], units: Readonly<Record<string, string>>):
  DailyMonitorAlertReplayRequest["rule"] {
  const { id, revision, type, assetType, scope: rawScope, conditions: rawConditions, logic, cooldownMs, severity } =
    observationManifestObject(value, ["id", "revision", "type", "assetType", "scope", "conditions", "logic", "cooldownMs", "severity"]);
  if (typeof id !== "string" || !/^[a-z0-9_]{1,40}$/.test(id) || typeof revision !== "string" || !revision.trim() || assetType !== "stock" ||
    (type !== "signal" && type !== "price" && type !== "market") || (logic !== "and" && logic !== "or") ||
    typeof cooldownMs !== "number" || !Number.isSafeInteger(cooldownMs) || cooldownMs < 0 ||
    (severity !== "info" && severity !== "warn" && severity !== "critical") || !Array.isArray(rawConditions) || !rawConditions.length) {
    throw invalid();
  }
  const { kind, symbols, membershipRevision } = observationManifestObject(rawScope, ["kind", "symbols", "membershipRevision"]);
  let scope: DailyMonitorAlertReplayRequest["rule"]["scope"];
  if (kind === "all" && symbols === undefined && membershipRevision === undefined) scope = { kind };
  else {
    if (!Array.isArray(symbols) || new Set(symbols).size !== symbols.length ||
      symbols.some(symbol => typeof symbol !== "string" || !roster.has(symbol))) throw invalid();
    if (kind === "symbols" && membershipRevision === undefined) scope = { kind, symbols };
    else if (kind === "watchlist_group" && typeof membershipRevision === "string" && membershipRevision.trim()) {
      scope = { kind, symbols, membershipRevision };
    } else throw invalid();
  }
  const conditions = rawConditions.map((entry: unknown): TspMonitorCondition => {
    const { field, op, value, unit } = observationManifestObject(entry, ["field", "op", "value", "unit"]);
    if (typeof field !== "string") throw invalid();
    if (op === "truth" && value === undefined && unit === undefined && signalFields.includes(field)) {
      return { field, op };
    }
    const comparison = ([">", ">=", "<", "<=", "==", "!="] as const).find(candidate => candidate === op);
    if (!comparison || typeof value !== "number" || !Number.isFinite(value) || typeof unit !== "string" ||
      !Object.hasOwn(units, field) || units[field] !== unit) {
      throw invalid();
    }
    return { field, op: comparison, value, unit };
  });
  return { id, revision, type, assetType, scope, conditions, logic, cooldownMs, severity };
}

function parseDailyMonitorAlertManifest(value: unknown): DailyMonitorAlertReplayRequest {
  const { version, rule, adjustment, sessions: rawSessions, roster: rawRoster, histories: rawHistories } =
    observationManifestObject(value, ["version", "rule", "adjustment", "sessions", "roster", "histories"]);
  if (version !== 1 || (adjustment !== "none" && adjustment !== "forward") || !Array.isArray(rawSessions)) throw invalid();
  const roster = parseMonitorRoster(rawRoster);
  const rosterSet = new Set(roster);
  const sessions = rawSessions.map((entry: unknown) => {
    const { tradeDate, evaluatedAt } = observationManifestObject(entry, ["tradeDate", "evaluatedAt"]);
    if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || typeof evaluatedAt !== "number" || !Number.isSafeInteger(evaluatedAt) ||
      evaluatedAt < Date.parse(tradeDate + "T15:00:00+08:00") || evaluatedAt >= Date.parse(tradeDate + "T16:00:00Z")) throw invalid();
    return { tradeDate, evaluatedAt };
  });
  parseExchangeSessions(sessions.map(session => session.tradeDate));
  const histories = parseArchivedStockHistories(rawHistories);
  validateMonitorHistories(histories, rosterSet);
  return { rule: parseMonitorRule(rule, rosterSet, TSP_DAILY_SIGNAL_FIELDS, TSP_DAILY_MONITOR_UNITS), adjustment, sessions, roster, histories };
}

function parseTickFlowStockMinuteReplay(minuteRevisions: unknown, value: unknown, previousClose: unknown): TickFlowStockMinuteReplayRequest {
  const { timestampLabel, priceBasis, volumeUnit, amountUnit } = observationManifestObject(value, ["timestampLabel", "priceBasis", "volumeUnit", "amountUnit"]);
  const revisions = validateRevisions(minuteRevisions);
  if (!revisions.length || (timestampLabel !== "minute-start" && timestampLabel !== "minute-end") ||
    priceBasis !== "caller-confirmed-unadjusted-CNY" || (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw invalid();
  return { refs: revisions.map(revision => ({ version: 1, kind: "dated-stock-minute", revision })),
    interpretation: { timestampLabel, priceBasis, volumeUnit, amountUnit }, previousClose: parseIntradayPreviousClose(previousClose) };
}

function parseIntradayMonitorAlertManifest(value: unknown): IntradayMonitorAlertReplayRequest {
  const { version, rule, slots: rawSlots, roster: rawRoster, histories: rawHistories, customSignals: rawCustomSignals = [] } =
    observationManifestObject(value, ["version", "rule", "slots", "roster", "histories", "customSignals"]);
  if (version !== 1 || !Array.isArray(rawSlots) || !rawSlots.length || !Array.isArray(rawHistories) || !Array.isArray(rawCustomSignals)) throw invalid();
  const roster = parseMonitorRoster(rawRoster);
  const rosterSet = new Set(roster);
  let prior = 0;
  const slots = rawSlots.map((entry: unknown) => {
    const { tradeDate, minute } = observationManifestObject(entry, ["tradeDate", "minute"]);
    if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || typeof minute !== "string" || tspMinuteIndex(minute) < 0) throw invalid();
    const evaluatedAt = Date.parse(`${tradeDate}T${minute}:00+08:00`) + 60_000;
    if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt <= prior) throw invalid();
    prior = evaluatedAt;
    return { tradeDate, minute };
  });
  const histories = rawHistories.map((entry: unknown): IntradayMonitorAlertReplayRequest["histories"][number] => {
    const { symbol, minuteRevision, minuteRevisions, interpretation, previousClose } =
      observationManifestObject(entry, ["symbol", "minuteRevision", "minuteRevisions", "interpretation", "previousClose"]);
    if (typeof symbol !== "string") throw invalid();
    if (minuteRevisions !== undefined) {
      if (minuteRevision !== undefined) throw invalid();
      return { symbol, ...parseTickFlowStockMinuteReplay(minuteRevisions, interpretation, previousClose) };
    }
    if (interpretation !== undefined || typeof minuteRevision !== "string" || !revisionPattern.test(minuteRevision)) throw invalid();
    return { symbol, ref: { version: 1, kind: "historical-minute-bars", revision: minuteRevision }, previousClose: parseIntradayPreviousClose(previousClose) };
  });
  validateMonitorHistories(histories, rosterSet);
  const customSignals = rawCustomSignals.map(value => {
    try { return parseTspIntradaySignalRule(value); } catch { throw invalid(); }
  });
  const customFields = customSignals.map(({ id }) => `csgi_${id}`);
  if (new Set(customFields).size !== customFields.length) throw invalid();
  return { rule: parseMonitorRule(rule, rosterSet, [...TSP_INTRADAY_MONITOR_SIGNALS, ...customFields], TSP_INTRADAY_MONITOR_UNITS),
    slots, roster, histories, customSignals };
}

function parseQuoteMonitorAlertManifest(value: unknown, mode: "collect" | "replay"):
  { mode: "collect"; request: CurrentQuoteMonitorRequest } | { mode: "replay"; request: QuoteMonitorReplayRequest } {
  const input = observationManifestObject(value, ["version", "rule", "roster", "maxAgeMs", "priceBasis", "volumeUnit", "amountUnit",
    ...(mode === "collect" ? ["tradeDate", "priorCaptureRevisions"] : ["captureRevisions"])]);
  const { version, rule, roster: rawRoster, maxAgeMs, priceBasis, volumeUnit, amountUnit } = input;
  if (version !== 1 || typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
    (priceBasis !== undefined && priceBasis !== "caller-confirmed-unadjusted-CNY") ||
    (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw invalid();
  const roster = parseMonitorRoster(rawRoster);
  if (roster.length < 1 || roster.length > 6_999) throw invalid();
  const scope: Omit<QuoteMonitorReplayRequest, "captureRefs"> = {
    rule: parseMonitorRule(rule, new Set(roster), [], TSP_QUOTE_MONITOR_UNITS), roster, maxAgeMs, priceBasis, volumeUnit, amountUnit,
  };
  if (mode === "collect") {
    const { tradeDate, priorCaptureRevisions = [] } = input;
    if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || tradeDate !== shanghaiDate.format()) throw invalid();
    const priorCaptureRefs = validateRevisions(priorCaptureRevisions).map(revision => ({ version: 1, kind: "quote-poll", revision } as const));
    return { mode, request: { ...scope, tradeDate, priorCaptureRefs } };
  }
  const captureRefs = validateRevisions(input.captureRevisions).map(revision => ({ version: 1, kind: "quote-poll", revision } as const));
  if (!captureRefs.length) throw invalid();
  return { mode, request: { ...scope, captureRefs } };
}

function parseDatedMarketArchiveScope({ version, marketRevision, adjustment }: Record<string, unknown>):
  Pick<TspListRowsRequest, "marketRef" | "adjustment"> {
  if (version !== 1 || typeof marketRevision !== "string" || !revisionPattern.test(marketRevision) ||
    (adjustment !== "none" && adjustment !== "forward")) throw invalid();
  return {
    marketRef: { version: 1, kind: "market-cross-section", revision: marketRevision },
    adjustment,
  };
}

const screenerStrategyKeys = ["signalGate", "strategy", "weights", "orderBy", "descending"] as const;

function parseScreenerStrategy({ signalGate, strategy, weights, orderBy, descending }: Record<string, unknown>):
  ScreenerUnionReplayRequest["strategies"][number] {
  if (!Array.isArray(weights) ||
    (orderBy !== undefined && (typeof orderBy !== "string" || !orderBy.trim() || orderBy !== orderBy.trim())) ||
    (descending !== undefined && typeof descending !== "boolean")) throw invalid();
  const { id, revision } = observationManifestObject(strategy, ["id", "revision"]);
  if (typeof id !== "string" || !id.trim() || id !== id.trim() || typeof revision !== "string" || !revisionPattern.test(revision)) throw invalid();
  let gate: ScreenerReplayRequest["signalGate"];
  if (signalGate !== undefined) {
    const { mode, signals } = observationManifestObject(signalGate, ["mode", "signals"]);
    if ((mode !== "any" && mode !== "all") || !Array.isArray(signals) || !signals.length ||
      new Set(signals).size !== signals.length) throw invalid();
    gate = { mode, signals: signals.map((value: unknown) => {
      const signal = TSP_DAILY_SIGNAL_FIELDS.find(id => id === value);
      if (!signal) throw invalid();
      return signal;
    }) };
  }
  return {
    strategy: { id, revision }, signalGate: gate, orderBy, descending,
    weights: weights.map((value: unknown) => {
      const { field, weight, direction } = observationManifestObject(value, ["field", "weight", "direction"]);
      if (typeof field !== "string" || !field.trim() || field !== field.trim() || typeof weight !== "number" ||
        !Number.isFinite(weight) || weight < 0 || (direction !== undefined && direction !== "low" && direction !== "high")) throw invalid();
      return { field, weight, direction };
    }),
  };
}

function parseScreenerArchiveManifest(value: unknown): ScreenerReplayRequest {
  const manifest = observationManifestObject(value, ["version", "marketRevision", "adjustment", "histories",
    ...screenerStrategyKeys, "displayLimit"]);
  const { displayLimit } = manifest;
  if (displayLimit != null && (typeof displayLimit !== "number" || !Number.isSafeInteger(displayLimit) || displayLimit < 0)) throw invalid();
  return { ...parseDatedMarketArchiveScope(manifest), ...parseScreenerStrategy(manifest),
    histories: parseArchivedStockHistories(manifest.histories), displayLimit };
}

function parseScreenerUnionScope(manifest: Record<string, unknown>): NonNullable<TspListRowsRequest["screener"]> {
  if (!Array.isArray(manifest.strategies) || !manifest.strategies.length) throw invalid();
  const strategies = manifest.strategies.map(item => parseScreenerStrategy(observationManifestObject(item, screenerStrategyKeys)));
  if (new Set(strategies.map(item => item.strategy.id)).size !== strategies.length) throw invalid();
  return { histories: parseArchivedStockHistories(manifest.histories), strategies };
}

function parseScreenerUnionManifest(value: unknown): ScreenerUnionReplayRequest {
  const manifest = observationManifestObject(value, ["version", "marketRevision", "adjustment", "histories", "strategies"]);
  return { ...parseDatedMarketArchiveScope(manifest), ...parseScreenerUnionScope(manifest) };
}

function parseListCalendar(value: unknown): NonNullable<TspListRowsRequest["limitCalendar"]> {
  const { revision, sessions } = observationManifestObject(value, ["revision", "sessions"]);
  if (typeof revision !== "string" || !revision.trim() || revision.length > 256 || !Array.isArray(sessions) || !sessions.length ||
    sessions.some((date, index) => typeof date !== "string" || date < "0001-01-01" || !isDailyDate(date) ||
      (index > 0 && date <= sessions[index - 1]))) throw invalid();
  return { revision, sessions };
}

function parseIntradayPreviousClose(value: unknown) {
  if (value === undefined) return undefined;
  const { revision, priceBasis } = observationManifestObject(value, ["revision", "priceBasis"]);
  if (typeof revision !== "string" || !revisionPattern.test(revision) || priceBasis !== "caller-confirmed-same-basis") throw invalid();
  return { ref: { version: 1, kind: "daily-trading-limits", revision }, priceBasis } as const;
}

function parseCurrentMinuteInterpretation(value: unknown): CurrentTspListIntradayRequest["interpretation"] {
  if (value === undefined) return undefined;
  const { timestampLabel, priceBasis } = observationManifestObject(value, ["timestampLabel", "priceBasis"]);
  if ((timestampLabel !== "minute-start" && timestampLabel !== "minute-end") ||
    priceBasis !== "caller-confirmed-unadjusted-CNY") throw invalid();
  return { timestampLabel, priceBasis };
}

function parseCurrentMinuteQuoteTail(value: unknown, interpretation: CurrentTspListIntradayRequest["interpretation"]):
  CurrentTspListIntradayRequest["quoteTail"] {
  if (value === undefined) return undefined;
  const { maxAgeMs, priceBasis } = observationManifestObject(value, ["maxAgeMs", "priceBasis"]);
  if (!interpretation || typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
    priceBasis !== compatiblePriceBasis) throw invalid();
  return { maxAgeMs, priceBasis };
}

function parseCurrentStockMinuteManifest(value: unknown): CurrentTspListIntradayRequest {
  const { version, tradeDate, stocks, interpretation: rawInterpretation, quoteTail: rawQuoteTail } =
    observationManifestObject(value, ["version", "tradeDate", "stocks", "interpretation", "quoteTail"]);
  if (version !== 1 || tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(stocks) ||
    !stocks.length || stocks.length > 100) throw invalid();

  const interpretation = parseCurrentMinuteInterpretation(rawInterpretation);

  const seen = new Set<string>();
  const targets = stocks.map((stock: unknown) => {
    const { symbol, previousClose: rawClose } = observationManifestObject(stock, ["symbol", "previousClose"]);
    const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
    if (!datedStock.test(code) || isAIndexSymbol(code) || seen.has(code) ||
      (rawClose !== undefined && !interpretation)) throw invalid();
    seen.add(code);
    return { symbol: code, previousClose: parseIntradayPreviousClose(rawClose) };
  });
  const quoteTail = parseCurrentMinuteQuoteTail(rawQuoteTail, interpretation);
  return { tradeDate, stocks: targets, interpretation, ...(quoteTail && { quoteTail }) };
}

function parseCurrentEtfMinuteManifest(value: unknown): CurrentTspEtfIntradayRequest {
  const { version, tradeDate, etfs, interpretation: rawInterpretation, quoteTail: rawQuoteTail } =
    observationManifestObject(value, ["version", "tradeDate", "etfs", "interpretation", "quoteTail"]);
  if (version !== 1 || tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(etfs) || !etfs.length || etfs.length > 100) throw invalid();
  const interpretation = parseCurrentMinuteInterpretation(rawInterpretation);
  const seen = new Set<string>();
  const targets = etfs.map((etf: unknown) => {
    const { symbol, previousClose: rawClose } = observationManifestObject(etf, ["symbol", "previousClose"]);
    const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
    if (!isDatedEtfSymbol(code) || seen.has(code)) throw invalid();
    seen.add(code);
    if (rawClose === undefined) return { symbol: code };
    const { dailyRevision, calendar: rawCalendar, priceBasis } = observationManifestObject(rawClose, ["dailyRevision", "calendar", "priceBasis"]);
    if (!interpretation || typeof dailyRevision !== "string" || !revisionPattern.test(dailyRevision) || priceBasis !== compatiblePriceBasis) throw invalid();
    const calendar = parseObservationSessionPair(rawCalendar);
    if (calendar.tradeDate !== tradeDate) throw invalid();
    return { symbol: code, previousClose: { dailyRef: { version: 1, kind: "dated-etf-daily", revision: dailyRevision }, calendar, priceBasis } } as const;
  });
  const quoteTail = parseCurrentMinuteQuoteTail(rawQuoteTail, interpretation);
  return { tradeDate, etfs: targets, interpretation, ...(quoteTail && { quoteTail }) };
}

function parseListIntraday(value: unknown): NonNullable<TspListRowsRequest["stocks"][number]["intraday"]> {
  const { minuteRevision, interpretation, previousClose } = observationManifestObject(value, ["minuteRevision", "interpretation", "previousClose"]);
  const { timestampLabel, priceBasis, volumeUnit, amountUnit } = observationManifestObject(
    interpretation, ["timestampLabel", "priceBasis", "volumeUnit", "amountUnit"],
  );
  if (typeof minuteRevision !== "string" || !revisionPattern.test(minuteRevision) ||
    (timestampLabel !== "minute-start" && timestampLabel !== "minute-end") ||
    priceBasis !== "caller-confirmed-unadjusted-CNY" || (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw invalid();
  return { ref: { version: 1, kind: "dated-stock-minute", revision: minuteRevision },
    interpretation: { timestampLabel, priceBasis, volumeUnit, amountUnit }, previousClose: parseIntradayPreviousClose(previousClose) };
}

function parseListRowsManifest(value: unknown): TspListRowsRequest {
  const manifest = observationManifestObject(value, ["version", "marketRevision", "adjustment", "stocks", "limitCalendar",
    "watchlistMembershipRevision", "screener", "deviationCalendar"]);
  const screener = manifest.screener === undefined
    ? undefined
    : parseScreenerUnionScope(observationManifestObject(manifest.screener, ["histories", "strategies"]));
  if (screener && new Set(screener.histories.map(row => row.symbol)).size !== screener.histories.length) throw invalid();
  const { watchlistMembershipRevision } = manifest;
  if (watchlistMembershipRevision !== undefined &&
    (typeof watchlistMembershipRevision !== "string" || !revisionPattern.test(watchlistMembershipRevision))) throw invalid();
  if (!Array.isArray(manifest.stocks)) throw invalid();
  const limitCalendar = manifest.limitCalendar === undefined ? undefined : parseListCalendar(manifest.limitCalendar);
  const deviationCalendar = manifest.deviationCalendar === undefined ? undefined : parseListCalendar(manifest.deviationCalendar);
  const stocks = manifest.stocks.map(item => {
    const { watchlistHistoryRevision, tradingLimitsRevision, candleBars, financialReportRevisions, financialDisclosureRevisions, deviation, intraday, ...entry } = observationManifestObject(item, [...archivedStockKeys, "watchlistHistoryRevision", "tradingLimitsRevision", "candleBars",
      "financialReportRevisions", "financialDisclosureRevisions", "deviation", "intraday"]);
    if (deviation !== undefined && deviationCalendar === undefined) throw invalid();
    const deviationRefs = deviation === undefined
      ? undefined
      : parsePriceDeviationRefs(observationManifestObject(deviation, ["stockRevision", "benchmarkRevision"]));
    if (watchlistHistoryRevision !== undefined && (watchlistMembershipRevision === undefined ||
      typeof watchlistHistoryRevision !== "string" || !revisionPattern.test(watchlistHistoryRevision))) throw invalid();
    if (candleBars !== undefined && (typeof candleBars !== "number" || !Number.isInteger(candleBars) ||
      candleBars < 5 || candleBars > 60 || entry.dailyRevision === undefined)) throw invalid();
    if (tradingLimitsRevision !== undefined && (typeof tradingLimitsRevision !== "string" ||
      !revisionPattern.test(tradingLimitsRevision) || entry.limitsRevision !== undefined)) throw invalid();
    const limit = typeof tradingLimitsRevision === "string" ? {
      tradingLimitsRef: { version: 1, kind: "daily-trading-limits", revision: tradingLimitsRevision } as const,
    } : {};
    const reports = financialReportRevisions === undefined ? [] : validateRevisions(financialReportRevisions);
    const disclosures = financialDisclosureRevisions === undefined ? [] : validateRevisions(financialDisclosureRevisions);
    if (new Set([...reports, ...disclosures]).size !== reports.length + disclosures.length) throw invalid();
    const finance = financialReportRevisions === undefined && financialDisclosureRevisions === undefined ? {} : {
      financialArchives: [
        ...reports.map(revision => ({ version: 1, kind: "report-financial-indicators", revision }) as const),
        ...disclosures.map(revision => ({ version: 1, kind: "financial-disclosure-dates", revision }) as const),
      ],
    };
    const minute = intraday === undefined ? undefined : parseListIntraday(intraday);
    const watchlistHistory = watchlistHistoryRevision === undefined ? {} :
      { watchlistHistoryRef: { version: 2, revision: watchlistHistoryRevision } as const };
    if (Object.keys(entry).length === 1 && typeof entry.symbol === "string" && datedStock.test(entry.symbol)) {
      return { symbol: entry.symbol, ...watchlistHistory, ...limit, ...finance, ...(deviationRefs && { deviation: deviationRefs }), ...(minute && { intraday: minute }) };
    }
    const { symbol, ...history } = parseArchivedStockHistory(entry);
    return { symbol, history: { ...history, ...(candleBars !== undefined && { candleBars }) }, ...watchlistHistory, ...limit, ...finance, ...(deviationRefs && { deviation: deviationRefs }), ...(minute && { intraday: minute }) };
  });
  return { ...parseDatedMarketArchiveScope(manifest), stocks, limitCalendar,
    ...(watchlistMembershipRevision !== undefined && { watchlistMembershipRevision }),
    ...(deviationCalendar !== undefined && { deviationCalendar }),
    ...(screener !== undefined && { screener }) };
}

function parseRealizedTrades(value: unknown): TspBacktestRobustnessInput["trades"] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry: unknown) => {
    const { pnlFraction, holdingDays } = observationManifestObject(entry, ["pnlFraction", "holdingDays"]);
    if (typeof pnlFraction !== "number" || !Number.isFinite(pnlFraction) ||
      (holdingDays !== null && (typeof holdingDays !== "number" || !Number.isSafeInteger(holdingDays) || holdingDays < 0))) throw invalid();
    return { pnlFraction, holdingDays };
  });
}

function parseBacktestRobustnessManifest(value: unknown): TspBacktestRobustnessInput {
  const { trades: rawTrades, periodicReturns, periodsPerYear, includeMonteCarlo } =
    observationManifestObject(value, ["trades", "periodicReturns", "periodsPerYear", "includeMonteCarlo"]);
  if ((periodicReturns !== undefined && (!Array.isArray(periodicReturns) || !periodicReturns.every(Number.isFinite))) ||
    (periodsPerYear !== undefined && (typeof periodsPerYear !== "number" || !Number.isSafeInteger(periodsPerYear) || periodsPerYear <= 0)) ||
    (includeMonteCarlo !== undefined && typeof includeMonteCarlo !== "boolean")) throw invalid();
  return { trades: parseRealizedTrades(rawTrades), periodicReturns, periodsPerYear, includeMonteCarlo };
}

function parseBacktestPortfolioManifest(value: unknown): TspBacktestPortfolioInput {
  const { schemaVersion, initialCapital, equityCurve, trades, includeMonteCarlo } =
    observationManifestObject(value, ["schemaVersion", "initialCapital", "equityCurve", "trades", "includeMonteCarlo"]);
  if (schemaVersion !== 1 || typeof initialCapital !== "number" || !Array.isArray(equityCurve) ||
    (includeMonteCarlo !== undefined && typeof includeMonteCarlo !== "boolean")) throw invalid();
  const samples = equityCurve.map((entry: unknown) => {
    const { date, equity, exposureFraction } = observationManifestObject(entry, ["date", "equity", "exposureFraction"]);
    if (typeof date !== "string" || typeof equity !== "number" || typeof exposureFraction !== "number") throw invalid();
    return { date, equity, exposureFraction };
  });
  return { initialCapital, equityCurve: samples, trades: parseRealizedTrades(trades), includeMonteCarlo };
}

function parsePaperNavRows(value: unknown): TspPaperStatisticsInput["finalizedNav"] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry: unknown) => {
    const { tradeDate, nav, currency } = observationManifestObject(entry, ["tradeDate", "nav", "currency"]);
    if (typeof tradeDate !== "string" || typeof nav !== "number" || typeof currency !== "string") throw invalid();
    return { tradeDate, nav, currency };
  });
}

function parsePaperLedgerManifest(value: unknown): TspPaperLedgerInput {
  const { schemaVersion, accountId, currency, initialCash, asOf, entries } =
    observationManifestObject(value, ["schemaVersion", "accountId", "currency", "initialCash", "asOf", "entries"]);
  if (schemaVersion !== 1 || typeof accountId !== "string" || typeof currency !== "string" ||
    typeof initialCash !== "number" || typeof asOf !== "string" || !Array.isArray(entries)) throw invalid();
  const fillKeys = ["currency", "assetType", "side", "quantity", "price", "fee"] as const;
  return { accountId, currency, initialCash, asOf, entries: entries.map((value: unknown): TspPaperLedgerEntry => {
    const row = observationManifestObject(value, ["kind", "entryId", "tradeDate", "symbol", "factor", ...fillKeys]);
    const { kind, entryId, tradeDate, symbol, factor, currency: unit, assetType, side, quantity, price, fee } = row;
    if (typeof entryId !== "string" || typeof tradeDate !== "string" || typeof symbol !== "string") throw invalid();
    if (kind === "corp_action") {
      if (typeof factor !== "number" || fillKeys.some(key => Object.hasOwn(row, key))) throw invalid();
      return { kind, entryId, tradeDate, symbol, factor };
    }
    if (kind !== "fill" || Object.hasOwn(row, "factor") || unit !== currency ||
      (assetType !== "stock" && assetType !== "etf") || (side !== "buy" && side !== "sell") ||
      typeof quantity !== "number" || typeof price !== "number" || typeof fee !== "number") throw invalid();
    return { kind, entryId, tradeDate, symbol, currency: unit, assetType, side, quantity, price, fee };
  }) };
}

function parsePaperStatisticsManifest(value: unknown): TspPaperStatisticsInput {
  const { schemaVersion, accountId, currency, fills: rawFills, finalizedNav: rawNav } =
    observationManifestObject(value, ["schemaVersion", "accountId", "currency", "fills", "finalizedNav"]);
  if (schemaVersion !== 1 || typeof accountId !== "string" || typeof currency !== "string") throw invalid();
  return { accountId, currency, fills: parsePaperFills(rawFills), finalizedNav: parsePaperNavRows(rawNav) };
}

function parsePaperFills(value: unknown): TspPaperStatisticsInput["fills"] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry: unknown): TspPaperStatisticsInput["fills"][number] => {
    const { fillId, tradeDate, symbol, side, quantity, price, fee, currency } =
      observationManifestObject(entry, ["fillId", "tradeDate", "symbol", "side", "quantity", "price", "fee", "currency"]);
    if (typeof fillId !== "string" || typeof tradeDate !== "string" || typeof symbol !== "string" ||
      (side !== "buy" && side !== "sell") || typeof quantity !== "number" || typeof price !== "number" ||
      typeof fee !== "number" || typeof currency !== "string") throw invalid();
    return { fillId, tradeDate, symbol, side, quantity, price, fee, currency };
  });
}

function parsePaperSnapshotRef(quoteRevision: unknown, valuationQuoteRevision: unknown) {
  if (quoteRevision === undefined && valuationQuoteRevision === undefined) return undefined;
  if (valuationQuoteRevision === undefined && typeof quoteRevision === "string" && revisionPattern.test(quoteRevision)) {
    return { version: 1, kind: "quote-poll", revision: quoteRevision } as const;
  }
  if (quoteRevision === undefined && typeof valuationQuoteRevision === "string" && revisionPattern.test(valuationQuoteRevision)) {
    return { version: 1, kind: "valuation-quote-poll", revision: valuationQuoteRevision } as const;
  }
  throw invalid();
}

function parsePaperValuationManifest(value: unknown): PaperValuationReplayRequest {
  const { schemaVersion, accountId, tradeDate, currency, cash, initialCash, basis, priceBasisConfirmation,
    positions: rawPositions, finalizedNav: rawNav, dailyRevisions, etfDailyRevisions, quoteRevision, valuationQuoteRevision } = observationManifestObject(value,
    ["schemaVersion", "accountId", "tradeDate", "currency", "cash", "initialCash", "basis", "priceBasisConfirmation",
      "positions", "finalizedNav", "dailyRevisions", "etfDailyRevisions", "quoteRevision", "valuationQuoteRevision"]);
  if (schemaVersion !== 1 || typeof accountId !== "string" || !accountId.trim() || typeof tradeDate !== "string" ||
    !isDailyDate(tradeDate) || currency !== "CNY" || priceBasisConfirmation !== "caller-confirmed-unadjusted-CNY" ||
    typeof cash !== "number" || typeof initialCash !== "number" || !Array.isArray(rawPositions)) throw invalid();
  const positions = rawPositions.map((entry: unknown): PaperValuationReplayRequest["positions"][number] => {
    const { symbol, assetType, currency: unit, quantity, averageCost, availableQuantity } =
      observationManifestObject(entry, ["symbol", "assetType", "currency", "quantity", "averageCost", "availableQuantity"]);
    if (typeof symbol !== "string" || (assetType !== "stock" && assetType !== "etf") || unit !== currency ||
      typeof quantity !== "number" || typeof averageCost !== "number" || typeof availableQuantity !== "number") throw invalid();
    return { symbol, assetType, currency: unit, quantity, averageCost, availableQuantity };
  });
  const finalizedNav = rawNav === undefined ? undefined : parsePaperNavRows(rawNav);
  if (finalizedNav?.some(row => row.currency !== currency)) throw invalid();
  const scope = { accountId, tradeDate, currency, cash, initialCash, priceBasisConfirmation, positions, finalizedNav } as const;
  if (basis === "finalized" && quoteRevision === undefined && valuationQuoteRevision === undefined) {
    return {
      ...scope, basis, dailyRefs: validateRevisions(dailyRevisions).map(revision => ({ version: 2, revision })),
      etfDailyRefs: etfDailyRevisions === undefined ? undefined : validateRevisions(etfDailyRevisions)
        .map(revision => ({ version: 1, kind: "dated-etf-daily", revision })),
    };
  }
  if (basis === "snapshot" && dailyRevisions === undefined && etfDailyRevisions === undefined) {
    const ref = parsePaperSnapshotRef(quoteRevision, valuationQuoteRevision);
    if (ref) return ref.kind === "quote-poll" ? { ...scope, basis, quoteRef: ref } : { ...scope, basis, valuationQuoteRef: ref };
  }
  throw invalid();
}

function parsePaperComparisonManifest(value: unknown): PaperComparisonReplayRequest {
  const { schemaVersion, tradeDate, currency, priceBasisConfirmation, accounts } =
    observationManifestObject(value, ["schemaVersion", "tradeDate", "currency", "priceBasisConfirmation", "accounts"]);
  if (schemaVersion !== 1 || typeof tradeDate !== "string" || !isDailyDate(tradeDate) || currency !== "CNY" ||
    priceBasisConfirmation !== "caller-confirmed-unadjusted-CNY" || !Array.isArray(accounts)) throw invalid();
  const seen = new Set<string>();
  const scope = { schemaVersion, tradeDate, currency, priceBasisConfirmation };
  return { tradeDate, currency, priceBasisConfirmation, accounts: accounts.map((entry: unknown) => {
    const { name, status, fills, quoteRevision, valuationQuoteRevision, ...valuation } = observationManifestObject(entry,
      ["accountId", "name", "status", "cash", "initialCash", "positions", "fills", "finalizedNav",
        "dailyRevisions", "etfDailyRevisions", "quoteRevision", "valuationQuoteRevision"]);
    const finalized = parsePaperValuationManifest({ ...valuation, ...scope, basis: "finalized" });
    if (finalized.basis !== "finalized" || !finalized.finalizedNav || seen.has(finalized.accountId) ||
      (name !== undefined && (typeof name !== "string" || !name.trim())) || (status !== "active" && status !== "frozen")) throw invalid();
    const snapshotRef = parsePaperSnapshotRef(quoteRevision, valuationQuoteRevision);
    if (snapshotRef && status !== "active") throw invalid();
    const { accountId, positions, cash, initialCash, finalizedNav, dailyRefs, etfDailyRefs } = finalized;
    seen.add(accountId);
    return { accountId, name, status, positions, cash, initialCash, fills: parsePaperFills(fills), finalizedNav,
      dailyRefs, etfDailyRefs, snapshotRef };
  }) };
}

function parseParameterSegment(value: unknown): TspParameterSegmentEvidence {
  const { start, end, objective, tradeCount } = observationManifestObject(value, ["start", "end", "objective", "tradeCount"]);
  if (typeof start !== "string" || typeof end !== "string" || (objective !== null && typeof objective !== "number") ||
    (tradeCount !== null && typeof tradeCount !== "number")) throw invalid();
  return { start, end, objective, tradeCount };
}

function parseParameterRobustnessManifest(value: unknown): TspParameterRobustnessInput {
  const { start, end, segmentCount, objective: rawObjective, direction, minTradesTotal, candidates } =
    observationManifestObject(value, ["start", "end", "segmentCount", "objective", "direction", "minTradesTotal", "candidates"]);
  const objective = TSP_PARAMETER_OBJECTIVES.find(name => name === rawObjective);
  if (!objective || typeof start !== "string" || typeof end !== "string" || typeof segmentCount !== "number" ||
    (direction !== undefined && direction !== "max" && direction !== "min") ||
    (minTradesTotal !== undefined && typeof minTradesTotal !== "number") ||
    !Array.isArray(candidates) || candidates.length > 2_000) throw invalid();
  return { start, end, segmentCount, objective, direction, minTradesTotal,
    candidates: candidates.map((value: unknown) => {
      const { params: rawParams, segments, failed, fullWindow } = observationManifestObject(value, ["params", "segments", "failed", "fullWindow"]);
      if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams) ||
        !Array.isArray(segments) || segments.length > 6 || (failed !== undefined && typeof failed !== "boolean")) throw invalid();
      const params = Object.fromEntries(Object.entries(rawParams as Record<string, unknown>).map(([key, setting]) => {
        if (setting !== null && typeof setting !== "string" && typeof setting !== "boolean" && typeof setting !== "number") throw invalid();
        return [key, setting] as const;
      }));
      return { params, segments: segments.map(parseParameterSegment), failed,
        ...(fullWindow !== undefined && { fullWindow: parseParameterSegment(fullWindow) }) };
    }) };
}

function parseWalkForwardManifest(value: unknown): TspWalkForwardInput {
  const { start, end, trainDays, testDays, stepDays, objective, direction, minHeldOutTrades, folds } =
    observationManifestObject(value, ["start", "end", "trainDays", "testDays", "stepDays", "objective", "direction", "minHeldOutTrades", "folds"]);
  if (typeof start !== "string" || !isDailyDate(start) || typeof end !== "string" || !isDailyDate(end) ||
    typeof trainDays !== "number" || !Number.isSafeInteger(trainDays) || trainDays <= 0 ||
    typeof testDays !== "number" || !Number.isSafeInteger(testDays) || testDays <= 0 ||
    typeof stepDays !== "number" || !Number.isSafeInteger(stepDays) || stepDays <= 0 ||
    typeof objective !== "string" || (direction !== "max" && direction !== "min") ||
    (minHeldOutTrades !== undefined && typeof minHeldOutTrades !== "number") || !Array.isArray(folds)) throw invalid();
  // Bound generated windows as well as explicit input rows.
  const maximumWindows = 7_000;
  const lastStartOffset = (Date.parse(end) - Date.parse(start)) / dayMs - trainDays - 1 - testDays;
  if (lastStartOffset >= stepDays * maximumWindows || folds.length > maximumWindows) throw invalid();
  return { start, end, trainDays, testDays, stepDays, objective, direction, minHeldOutTrades,
    folds: folds.map((raw: unknown) => {
      const { window: rawWindow, training, heldOut } = observationManifestObject(raw, ["window", "training", "heldOut"]);
      const { index, trainStart, trainEnd, testStart, testEnd } =
        observationManifestObject(rawWindow, ["index", "trainStart", "trainEnd", "testStart", "testEnd"]);
      if (typeof index !== "number" || typeof trainStart !== "string" || typeof trainEnd !== "string" ||
        typeof testStart !== "string" || typeof testEnd !== "string") throw invalid();
      let selection: TspWalkForwardInput["folds"][number]["training"] = null;
      if (training !== null) {
        const { candidateId, objective } = observationManifestObject(training, ["candidateId", "objective"]);
        if (typeof candidateId !== "string" || (objective !== null && typeof objective !== "number")) throw invalid();
        selection = { candidateId, objective };
      }
      let outcome: TspWalkForwardInput["folds"][number]["heldOut"] = null;
      if (heldOut !== null) {
        const { candidateId, objective, totalReturn, tradeCount } =
          observationManifestObject(heldOut, ["candidateId", "objective", "totalReturn", "tradeCount"]);
        if (typeof candidateId !== "string" || (objective !== null && typeof objective !== "number") ||
          typeof totalReturn !== "number" || typeof tradeCount !== "number") throw invalid();
        outcome = { candidateId, objective, totalReturn, tradeCount };
      }
      return { window: { index, trainStart, trainEnd, testStart, testEnd }, training: selection, heldOut: outcome };
    }) };
}

function parseFactorReplayScope({ sessions: dates, evaluationStart, symbols: rawSymbols, turnoverRevisions }: Record<string, unknown>):
  Omit<FactorSignificanceReplayRequest, "factorIds"> {
  const sessions = parseExchangeSessions(dates);
  if ((evaluationStart !== undefined && (typeof evaluationStart !== "string" || !sessions.includes(evaluationStart))) ||
    !Array.isArray(rawSymbols) || !rawSymbols.length) throw invalid();

  const symbols = rawSymbols.map((raw: unknown): FactorEvaluationReplayRequest["symbols"][number] => {
    const { symbol, dailyRevisions, financialReportRevisions, financialDisclosureRevisions, exchange, bookValueBasis } =
      observationManifestObject(raw, ["symbol", "dailyRevisions", "financialReportRevisions", "financialDisclosureRevisions", "exchange", "bookValueBasis"]);
    const daily = validateRevisions(dailyRevisions);
    const reports = financialReportRevisions === undefined ? [] : validateRevisions(financialReportRevisions);
    const disclosures = financialDisclosureRevisions === undefined ? [] : validateRevisions(financialDisclosureRevisions);
    if (typeof symbol !== "string" || !datedStock.test(symbol) || isAIndexSymbol(symbol) || !daily.length ||
      new Set([...reports, ...disclosures]).size !== reports.length + disclosures.length ||
      (bookValueBasis !== undefined && !Array.isArray(bookValueBasis))) throw invalid();

    let exchangeRefs: FactorEvaluationReplayRequest["symbols"][number]["exchange"];
    if (exchange !== undefined) {
      const { rawRevisions, limitRevisions } = observationManifestObject(exchange, ["rawRevisions", "limitRevisions"]);
      const limits = validateRevisions(limitRevisions);
      const rawDays = rawRevisions === undefined ? undefined : validateRevisions(rawRevisions);
      if (!limits.length || (rawDays && !rawDays.length)) throw invalid();
      exchangeRefs = {
        limitRefs: limits.map(revision => ({ version: 1, kind: "daily-trading-limits", revision })),
        rawRefs: rawDays?.map(revision => ({ version: 2, revision })),
      };
    }

    const confirmations = (bookValueBasis ?? []).map((rawBasis: unknown) => {
      const { reportRevision, periodEnd, basis } = observationManifestObject(rawBasis, ["reportRevision", "periodEnd", "basis"]);
      if (typeof reportRevision !== "string" || !reports.includes(reportRevision) || typeof periodEnd !== "string" ||
        !isDailyDate(periodEnd) || basis !== "caller-confirmed-unadjusted-CNY") throw invalid();
      return { reportRevision, periodEnd, basis } as const;
    });

    return {
      symbol,
      dailyRefs: daily.map(revision => ({ version: 2, revision })),
      financialRefs: [
        ...reports.map(revision => ({ version: 1, kind: "report-financial-indicators", revision }) as const),
        ...disclosures.map(revision => ({ version: 1, kind: "financial-disclosure-dates", revision }) as const),
      ],
      exchange: exchangeRefs,
      bookValueBasis: confirmations,
    };
  });
  if (new Set(symbols.map(entry => entry.symbol)).size !== symbols.length) throw invalid();
  return {
    sessions, evaluationStart, symbols,
    turnoverRefs: turnoverRevisions === undefined ? undefined : validateRevisions(turnoverRevisions)
      .map(revision => ({ version: 1, kind: "market-cross-section", revision })),
  };
}

function parseFactorEvaluationManifest(value: unknown): FactorEvaluationReplayRequest {
  const { factorId, rebalance, groups: rawGroups, marketEnvironment: rawEnvironment, ...scope } =
    observationManifestObject(value, ["sessions", "evaluationStart", "factorId", "rebalance", "symbols", "turnoverRevisions", "groups", "marketEnvironment"]);
  if (typeof factorId !== "string" || !factorKey.test(factorId) ||
    (rebalance !== "daily" && rebalance !== "weekly" && rebalance !== "monthly")) throw invalid();
  let groups: FactorEvaluationReplayRequest["groups"];
  if (rawGroups !== undefined) {
    const costs = ["feesFraction", "commissionFraction", "stampTaxFraction", "slippageBps"] as const;
    const settings = observationManifestObject(rawGroups, ["groupCount", "weight", ...costs]);
    const { groupCount, weight } = settings;
    if ((groupCount !== undefined && (typeof groupCount !== "number" || !Number.isSafeInteger(groupCount) || groupCount < 1)) ||
      (weight !== undefined && weight !== "equal" && weight !== "factor_weight") || costs.some(key => {
        const cost = settings[key];
        if (cost === undefined || (key === "commissionFraction" && cost === null)) return false;
        return typeof cost !== "number" || !Number.isFinite(cost) || cost < 0;
      })) throw invalid();
    groups = settings;
  }

  const marketEnvironment = rawEnvironment === undefined ? undefined : parseEnvironmentManifest(rawEnvironment);
  if (marketEnvironment?.phaseMode === "retrospective-tsp") throw invalid();

  return { ...parseFactorReplayScope(scope), factorId, rebalance, groups, marketEnvironment };
}

function parseFactorIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length ||
    value.some(id => typeof id !== "string" || !factorKey.test(id)) || new Set(value).size !== value.length) throw invalid();
  return value;
}

function parseFactorSignificanceManifest(value: unknown): FactorSignificanceReplayRequest {
  const { schemaVersion, factorIds, ...scope } = observationManifestObject(value,
    ["schemaVersion", "factorIds", "sessions", "evaluationStart", "symbols", "turnoverRevisions"]);
  if (schemaVersion !== 1) throw invalid();
  const ids = parseFactorIds(factorIds);
  return { ...parseFactorReplayScope(scope), factorIds: ids };
}

function parseFactorMiningScreenManifest(value: unknown): FactorMiningScreenReplayRequest {
  const { schemaVersion, factorIds, forwardSessions, correlationThreshold, ...scope } = observationManifestObject(value,
    ["schemaVersion", "factorIds", "sessions", "evaluationStart", "symbols", "turnoverRevisions", "forwardSessions", "correlationThreshold"]);
  if (schemaVersion !== 1 ||
    (forwardSessions !== undefined && forwardSessions !== 1 && forwardSessions !== 3 && forwardSessions !== 5) ||
    typeof correlationThreshold !== "number" || !Number.isFinite(correlationThreshold) ||
    correlationThreshold <= 0 || correlationThreshold > 1) throw invalid();
  const ids = parseFactorIds(factorIds);
  if (ids.length > TSP_MINING_MAX_FACTORS) throw invalid();
  return { ...parseFactorReplayScope(scope), factorIds: ids, forwardSessions, correlationThreshold };
}

function parseMiningCandidateManifest(value: unknown): TspMiningCandidateReportInput {
  const { schemaVersion, candidateId, profile, folds } =
    observationManifestObject(value, ["schemaVersion", "candidateId", "profile", "folds"]);
  if (schemaVersion !== 1 || typeof candidateId !== "string" || !Array.isArray(folds) ||
    (profile !== "exploratory" && profile !== "balanced" && profile !== "strict")) throw invalid();
  return { candidateId, profile, folds: folds.map((value: unknown): TspMiningCandidateFoldEvidence => {
    const { window: rawWindow, evaluationKind, testSessionCount, outcome: rawOutcome } =
      observationManifestObject(value, ["window", "evaluationKind", "testSessionCount", "outcome"]);
    const { index, trainStart, trainEnd, testStart, testEnd } =
      observationManifestObject(rawWindow, ["index", "trainStart", "trainEnd", "testStart", "testEnd"]);
    if (typeof index !== "number" || typeof testSessionCount !== "number" ||
      typeof trainStart !== "string" || typeof trainEnd !== "string" || typeof testStart !== "string" || typeof testEnd !== "string" ||
      (evaluationKind !== "selected" && evaluationKind !== "cross" && evaluationKind !== "benchmark")) throw invalid();
    const window = { index, trainStart, trainEnd, testStart, testEnd };
    const { status, reason, metrics } = observationManifestObject(rawOutcome, ["status", "reason", "metrics"]);
    if (status === "skipped" && typeof reason === "string" && metrics === undefined) {
      return { window, evaluationKind, testSessionCount, outcome: { status, reason } };
    }
    if (status !== "valid" || reason !== undefined) throw invalid();
    const { totalReturnFraction, sharpe, maxDrawdownFraction, tradeCount } =
      observationManifestObject(metrics, ["totalReturnFraction", "sharpe", "maxDrawdownFraction", "tradeCount"]);
    if ((totalReturnFraction !== null && typeof totalReturnFraction !== "number") ||
      (sharpe !== null && typeof sharpe !== "number") || (maxDrawdownFraction !== null && typeof maxDrawdownFraction !== "number") ||
      (tradeCount !== null && typeof tradeCount !== "number")) throw invalid();
    return { window, evaluationKind, testSessionCount, outcome: {
      status, metrics: { totalReturnFraction, sharpe, maxDrawdownFraction, tradeCount },
    } };
  }) };
}

const guardianPlanKeys = ["schemaVersion", "dataAsOf", "sessions", "thresholds"] as const;
const guardianThresholdKeys = ["watchFraction", "retireFraction", "maxSoftDrawdownFraction", "maxSegments", "minNewTradingDays"] as const;

function parseGuardianPlan({ schemaVersion, dataAsOf, sessions, thresholds: rawThresholds }: Record<string, unknown>): TspStrategyGuardianPlanInput {
  if (schemaVersion !== 1 || typeof dataAsOf !== "string" || !Array.isArray(sessions) ||
    !sessions.every(date => typeof date === "string")) throw invalid();
  const thresholds: Partial<TspStrategyGuardianThresholds> = {};
  if (rawThresholds !== undefined) {
    const supplied = observationManifestObject(rawThresholds, guardianThresholdKeys);
    for (const key of guardianThresholdKeys) {
      const value = supplied[key];
      if (value === undefined) continue;
      if (typeof value !== "number") throw invalid();
      thresholds[key] = value;
    }
  }
  return { dataAsOf, sessions, thresholds };
}

function parseGuardianHistory(value: unknown): TspStrategyGuardianHistoryInput {
  const { schemaVersion, strategyId, checks } = observationManifestObject(value, ["schemaVersion", "strategyId", "checks"]);
  if (schemaVersion !== 1 || typeof strategyId !== "string" || !Array.isArray(checks)) throw invalid();
  return { strategyId, checks: checks.map((entry: unknown) => {
    const { verdict, error } = observationManifestObject(entry, ["verdict", "error"]);
    if ((verdict != null && verdict !== "healthy" && verdict !== "watch" && verdict !== "retired") ||
      (error != null && typeof error !== "string")) throw invalid();
    return { verdict: verdict ?? null, error };
  }) };
}

function parseStrategyMonitorSignals(value: unknown): TspStrategyMonitorSignal[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry: unknown) => {
    const { symbol, signals } = observationManifestObject(entry, ["symbol", "signals"]);
    if (typeof symbol !== "string" || !Array.isArray(signals) || signals.some(id => typeof id !== "string")) throw invalid();
    return { symbol, signals };
  });
}

function parseStrategyMonitorCapture(value: unknown): TspStrategyMonitorCapture {
  const { revision, evaluatedAt, tradeDate, status, rows, buySignals, sellSignals } = observationManifestObject(value,
    ["revision", "evaluatedAt", "tradeDate", "status", "rows", "buySignals", "sellSignals"]);
  if (typeof revision !== "string" || typeof evaluatedAt !== "number" || typeof tradeDate !== "string") throw invalid();
  if (status === "unavailable" && rows === undefined && buySignals === undefined && sellSignals === undefined) {
    return { revision, evaluatedAt, tradeDate, status };
  }
  if (status !== "completed" || !Array.isArray(rows)) throw invalid();
  return {
    revision, evaluatedAt, tradeDate, status,
    rows: rows.map((entry: unknown) => {
      const { symbol, score } = observationManifestObject(entry, ["symbol", "score"]);
      if (typeof symbol !== "string" || (score !== null && typeof score !== "number")) throw invalid();
      return { symbol, score };
    }),
    buySignals: parseStrategyMonitorSignals(buySignals),
    sellSignals: parseStrategyMonitorSignals(sellSignals),
  };
}

function parseStrategyMonitorManifest(value: unknown): TspStrategyMonitorInput {
  const { schemaVersion, rule, captures } = observationManifestObject(value, ["schemaVersion", "rule", "captures"]);
  const { id, revision, strategyId, strategyRevision, assetType, eventTypes: rawEvents, cooldownMs, scoreMin, scoreMax } =
    observationManifestObject(rule, ["id", "revision", "strategyId", "strategyRevision", "assetType", "eventTypes", "cooldownMs", "scoreMin", "scoreMax"]);
  if (schemaVersion !== 1 || typeof id !== "string" || typeof revision !== "string" || typeof strategyId !== "string" ||
    typeof strategyRevision !== "string" || (assetType !== "stock" && assetType !== "etf") || typeof cooldownMs !== "number" ||
    !Array.isArray(rawEvents) || !Array.isArray(captures) || (scoreMin !== undefined && typeof scoreMin !== "number") ||
    (scoreMax !== undefined && typeof scoreMax !== "number")) throw invalid();
  const eventTypes = rawEvents.map((value: unknown) => {
    const kind = TSP_STRATEGY_MONITOR_EVENT_TYPES.find(candidate => candidate === value);
    if (!kind) throw invalid();
    return kind;
  });
  return { rule: { id, revision, strategyId, strategyRevision, assetType, eventTypes, cooldownMs, scoreMin, scoreMax },
    captures: captures.map(parseStrategyMonitorCapture) };
}

function parseGuardianCheck(value: unknown): TspStrategyGuardianCheckInput {
  const { strategyId, objective: rawObjective, baselineScore, baselineTradeCount, segments, ...scope } = observationManifestObject(value,
    [...guardianPlanKeys, "strategyId", "objective", "baselineScore", "baselineTradeCount", "segments"]);
  const objective = TSP_PARAMETER_OBJECTIVES.find(name => name === rawObjective);
  if (typeof strategyId !== "string" || objective === undefined || typeof baselineScore !== "number" ||
    typeof baselineTradeCount !== "number" || !Array.isArray(segments)) throw invalid();
  return { ...parseGuardianPlan(scope), strategyId, objective, baselineScore, baselineTradeCount, segments: segments.map((entry: unknown) => {
    const { start, end, objective, tradeCount, maxDrawdownFraction } =
      observationManifestObject(entry, ["start", "end", "objective", "tradeCount", "maxDrawdownFraction"]);
    if (typeof start !== "string" || typeof end !== "string" || (objective !== null && typeof objective !== "number") ||
      (tradeCount !== null && typeof tradeCount !== "number") || (maxDrawdownFraction !== null && typeof maxDrawdownFraction !== "number")) throw invalid();
    return { start, end, objective, tradeCount, maxDrawdownFraction };
  }) };
}

function parseAuctionManifest(value: unknown): AuctionBenchmarkReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) throw invalid();
  const { auctionRevision, calendar, marketRevisions } = value as Record<string, unknown>;
  if (typeof auctionRevision !== "string" || !revisionPattern.test(auctionRevision)
    || !calendar || typeof calendar !== "object" || Array.isArray(calendar) || Object.keys(calendar).length !== 4) throw invalid();
  const { revision, tradeDate, previousTradeDate, nextTradeDate } = calendar as Record<string, unknown>;
  if (typeof revision !== "string" || !revision.trim() || typeof tradeDate !== "string" || !isDailyDate(tradeDate)
    || (previousTradeDate !== null && (typeof previousTradeDate !== "string" || !isDailyDate(previousTradeDate) || previousTradeDate >= tradeDate))
    || (nextTradeDate !== null && (typeof nextTradeDate !== "string" || !isDailyDate(nextTradeDate) || nextTradeDate <= tradeDate))) throw invalid();
  const revisions = validateRevisions(marketRevisions);
  if (revisions.length > 3) throw invalid();
  return {
    auctionRef: { version: 1, kind: "auction-benchmark", revision: auctionRevision },
    calendar: { revision, tradeDate, previousTradeDate, nextTradeDate },
    marketRefs: revisions.map(revision => ({ version: 1, kind: "market-cross-section", revision })),
  };
}

function parseEmotionDepth(value: unknown): NonNullable<MarketEmotionReplayRequest["depth"]> {
  const { revision, asOf, maxAgeMs, queue: rawQueue } = observationManifestObject(value, ["revision", "asOf", "maxAgeMs", "queue"]);
  if (typeof revision !== "string" || !revisionPattern.test(revision) || typeof asOf !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(asOf) ||
    !isDailyDate(asOf.slice(0, 10)) || typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw invalid();
  const cutoff = Date.parse(asOf);
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) throw invalid();
  let queue: NonNullable<MarketEmotionReplayRequest["depth"]>["queue"];
  if (rawQueue !== undefined) {
    const { volumeUnit, rule } = observationManifestObject(rawQueue, ["volumeUnit", "rule"]);
    if (volumeUnit !== undefined && volumeUnit !== "hand" && volumeUnit !== "share") throw invalid();
    queue = { volumeUnit };
    if (rule !== undefined) {
      const { metric, threshold } = observationManifestObject(rule, ["metric", "threshold"]);
      if ((metric !== "sealed_vol" && metric !== "sealed_amount") || typeof threshold !== "number" ||
        !Number.isFinite(threshold) || threshold < 0) throw invalid();
      queue.rule = { metric, threshold };
    }
  }
  return { ref: { version: 1, kind: "depth-snapshot", revision }, asOf: cutoff, maxAgeMs, ...(queue && { queue }) };
}

function parseEmotionManifest(value: unknown): MarketEmotionReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const manifest = value as Record<string, unknown>;
  const allowed = ["sessions", "marketRevisions", "limitRevisions", "riskWarningRevisions", "priceRevisions", "indexRevisions", "sectors", "depth"];
  if (Object.keys(manifest).some(key => !allowed.includes(key))) throw invalid();
  const scope = parseMarketReplayScope(manifest);
  const sectors: NonNullable<MarketEmotionReplayRequest["sectors"]> = {};
  if (Object.hasOwn(manifest, "sectors")) {
    const { sectors: value } = manifest;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    for (const [kind, section] of Object.entries(value)) {
      if ((kind !== "concept" && kind !== "industry") || !section || typeof section !== "object" ||
        Array.isArray(section) || Object.keys(section).length !== 2) throw invalid();
      const { catalogRevision, memberRevisions } = section as Record<string, unknown>;
      sectors[kind] = parseSectorRefs(catalogRevision, memberRevisions);
    }
  }
  return { ...scope, sectors, ...(Object.hasOwn(manifest, "depth") ? { depth: parseEmotionDepth(manifest.depth) } : {}),
    priceRefs: validateRevisions(manifest.priceRevisions).map(revision => ({ version: 2, revision })),
    indexRefs: validateRevisions(manifest.indexRevisions).map(revision => ({ version: 1, kind: "benchmark-index", revision })) };
}

function parsePriceDeviationRefs(manifest: Record<string, unknown>): Pick<PriceDeviationReplayRequest, "stockRef" | "benchmarkRef"> {
  const { stockRevision, benchmarkRevision } = manifest;
  if (typeof stockRevision !== "string" || !revisionPattern.test(stockRevision) ||
    (Object.hasOwn(manifest, "benchmarkRevision") &&
      (typeof benchmarkRevision !== "string" || !revisionPattern.test(benchmarkRevision)))) throw invalid();
  return { stockRef: { version: 2, revision: stockRevision },
    ...(typeof benchmarkRevision === "string" ? {
      benchmarkRef: { version: 1, kind: "benchmark-index", revision: benchmarkRevision },
    } : {}) };
}

function parsePriceDeviationManifest(value: unknown): PriceDeviationReplayRequest {
  const manifest = observationManifestObject(value, ["symbol", "sessions", "stockRevision", "benchmarkRevision"]);
  const { symbol } = manifest;
  if (typeof symbol !== "string" || !datedStock.test(symbol)) throw invalid();
  return { symbol, sessions: parseExchangeSessions(manifest.sessions), ...parsePriceDeviationRefs(manifest) };
}

function parseQuotePollManifest(value: unknown): QuotePollReplayRequest {
  const { version, currentRevision, previousRevision, volumeUnit, amountUnit, rule: rawRule } = observationManifestObject(
    value, ["version", "currentRevision", "previousRevision", "volumeUnit", "amountUnit", "rule"],
  );
  if (version !== 1 || typeof currentRevision !== "string" || !revisionPattern.test(currentRevision) ||
    (previousRevision !== undefined && (typeof previousRevision !== "string" || !revisionPattern.test(previousRevision) ||
      previousRevision === currentRevision)) ||
    (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw invalid();
  let rule: QuotePollReplayRequest["rule"];
  if (rawRule !== undefined) {
    const { metric, threshold } = observationManifestObject(rawRule, ["metric", "threshold"]);
    if ((metric !== "volume" && metric !== "amount") || typeof threshold !== "number" ||
      !Number.isFinite(threshold) || threshold < 1) throw invalid();
    rule = { metric, threshold };
  }
  return {
    currentRef: { version: 1, kind: "quote-poll", revision: currentRevision },
    previousRef: previousRevision === undefined ? undefined : { version: 1, kind: "quote-poll", revision: previousRevision },
    volumeUnit, amountUnit, rule,
  };
}

function parseObservationSessionPair(calendar: unknown) {
  const { revision, previousTradeDate, tradeDate } = observationManifestObject(calendar, ["revision", "previousTradeDate", "tradeDate"]);
  if (typeof revision !== "string" || !revision.trim() || typeof previousTradeDate !== "string" ||
    !isDailyDate(previousTradeDate) || typeof tradeDate !== "string" || !isDailyDate(tradeDate) || previousTradeDate >= tradeDate) throw invalid();
  return { revision, previousTradeDate, tradeDate };
}

function parseIndexPreviousClose(
  dailyRevision: unknown,
  calendar: unknown,
): NonNullable<DatedIndexMinuteReplayRequest["previousClose"]> {
  if (typeof dailyRevision !== "string" || !revisionPattern.test(dailyRevision)) throw invalid();
  return { dailyRef: { version: 1, kind: "benchmark-index", revision: dailyRevision }, calendar: parseObservationSessionPair(calendar) };
}

function parseSectorMonitorRule(value: unknown): SectorMonitorReplayRequest["rule"] {
  if (value === undefined) return undefined;
  const { trigger, direction, thresholdFraction, cooldownMs, windowMinutes } =
    observationManifestObject(value, ["trigger", "direction", "thresholdFraction", "cooldownMs", "windowMinutes"]);
  if ((direction !== "up" && direction !== "down") || typeof thresholdFraction !== "number" ||
    !Number.isFinite(thresholdFraction) || thresholdFraction <= 0 || thresholdFraction > 0.2 ||
    typeof cooldownMs !== "number" || !Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw invalid();
  const settings = { direction, thresholdFraction, cooldownMs } as const;
  if (trigger === "change_pct" && windowMinutes === undefined) return { trigger, ...settings };
  const window = TSP_SECTOR_MONITOR_WINDOWS.find(candidate => candidate === windowMinutes);
  if (trigger !== "momentum" || window === undefined) throw invalid();
  return { trigger, windowMinutes: window, ...settings };
}

function parseSectorMonitorManifest(value: unknown): SectorMonitorReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { kind } = value as Record<string, unknown>;
  if (kind === "sector") {
    const { version, catalogRevision, memberRevision, quoteRevisions, rule } =
      observationManifestObject(value, ["version", "kind", "catalogRevision", "memberRevision", "quoteRevisions", "rule"]);
    if (version !== 1 || typeof catalogRevision !== "string" || !revisionPattern.test(catalogRevision) ||
      typeof memberRevision !== "string" || !revisionPattern.test(memberRevision)) throw invalid();
    const revisions = validateRevisions(quoteRevisions);
    if (!revisions.length) throw invalid();
    return {
      kind, rule: parseSectorMonitorRule(rule),
      catalogRef: { version: 1, kind: "dated-sector-catalog", revision: catalogRevision },
      memberRef: { version: 1, kind: "dated-sector-members", revision: memberRevision },
      quoteRefs: revisions.map(revision => ({ version: 1, kind: "quote-poll", revision })),
    };
  }
  if (kind !== "index") throw invalid();
  const { version, minuteRevision, previousClose, name, rule } =
    observationManifestObject(value, ["version", "kind", "minuteRevision", "previousClose", "name", "rule"]);
  if (version !== 1 || typeof minuteRevision !== "string" || !revisionPattern.test(minuteRevision) ||
    (name !== undefined && (typeof name !== "string" || !name.trim()))) throw invalid();
  const request: Extract<SectorMonitorReplayRequest, { kind: "index" }> = {
    kind, name, rule: parseSectorMonitorRule(rule),
    minuteRef: { version: 1, kind: "dated-index-minute", revision: minuteRevision },
  };
  if (previousClose !== undefined) {
    const { dailyRevision, calendar } = observationManifestObject(previousClose, ["dailyRevision", "calendar"]);
    request.previousClose = parseIndexPreviousClose(dailyRevision, calendar);
  }
  return request;
}

export async function runObservationCommand(args: readonly string[], signal?: AbortSignal) {
  const [action, ...options] = args;
  if (action === "collect-tickflow-stock-minutes") {
    const fields = parseOptions(options, ["--symbol", "--date"]);
    const symbol = fields.get("--symbol")?.trim().toUpperCase(), tradeDate = fields.get("--date");
    if (!symbol || !datedStock.test(symbol) || isAIndexSymbol(symbol) || !tradeDate || !isDailyDate(tradeDate) ||
      tradeDate < "0001-01-01" || tradeDate >= shanghaiDate.format()) throw invalid();
    try { return await collectDatedTickFlowStockMinutes({ symbol, tradeDate }, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested TickFlow stock minute observations."), { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-tickflow-stock-minutes") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const { version, minuteRevisions, interpretation, previousClose } = observationManifestObject(
      await readObservationJsonFile(path, maxObservationManifestBytes, signal), ["version", "minuteRevisions", "interpretation", "previousClose"],
    );
    if (version !== 1) throw invalid();
    const request = parseTickFlowStockMinuteReplay(minuteRevisions, interpretation, previousClose);
    try { return await replayTspTickFlowStockMinutes(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested TickFlow stock minute archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-quote-monitor-alerts" || action === "replay-quote-monitor-alerts") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const parsed = parseQuoteMonitorAlertManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal),
      action === "collect-quote-monitor-alerts" ? "collect" : "replay");
    if (parsed.mode === "collect") {
      try { return await collectTspQuoteMonitorAlerts(parsed.request, { signal }); }
      catch {
        throw Object.assign(new Error("Could not collect the quote monitor poll. Check the prior archives and the configured source."),
          { code: "observation_collection_failed" });
      }
    }
    try { return await replayTspQuoteMonitorAlerts(parsed.request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested quote monitor archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-depth" || action === "collect-quote-poll" || action === "collect-valuation-quotes") {
    const fields = parseOptions(options, ["--date", "--symbols-file"]);
    const tradeDate = fields.get("--date"), path = fields.get("--symbols-file");
    if (!tradeDate || !isDailyDate(tradeDate) || tradeDate !== shanghaiDate.format(Date.now()) || !path) throw invalid();
    const symbols = await readObservationJsonFile(path, maxRevisionFileBytes, signal);
    const valuation = action === "collect-valuation-quotes";
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length >= 7_000 || new Set(symbols).size !== symbols.length ||
      symbols.some(symbol => typeof symbol !== "string" || !(valuation
        ? (datedStock.test(symbol) && !isAIndexSymbol(symbol)) || isDatedEtfSymbol(symbol)
        : datedStock.test(symbol)))) throw invalid();
    const collect = action === "collect-depth" ? collectDepthSnapshot : valuation ? collectValuationQuotePollCapture : collectQuotePollCapture;
    try { return await collect({ tradeDate, symbols }, { signal }); }
    catch {
      const scope = action === "collect-depth" ? "market depth" : valuation ? "valuation quote poll" : "quote poll";
      throw Object.assign(new Error(`Could not collect the requested ${scope}. Check the configured source with whyj --json doctor --phase data.`),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-quote-poll-delta") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseQuotePollManifest(await readObservationJsonFile(path, maxRevisionFileBytes, signal));
    try { return await replayTspQuotePollDelta(request, signal); }
    catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not replay the requested quote polls. Verify revisions, ordering and scope."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-risk-warnings") {
    const date = parseOptions(options, ["--date"]).get("--date");
    if (!date || !isDailyDate(date) || date < "2000-01-01" || date > shanghaiDate.format()) throw invalid();
    try { return await collectRiskWarningObservations(date, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested risk-warning list. Check the configured source with whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-abnormal-snapshot") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const { version, marketRevision, sessions, adjustment, histories, limit } = observationManifestObject(
      await readObservationJsonFile(path, maxObservationManifestBytes, signal), ["version", "marketRevision", "sessions", "adjustment", "histories", "limit"],
    );
    if (version !== 1 || typeof marketRevision !== "string" || !revisionPattern.test(marketRevision) ||
      (adjustment !== "none" && adjustment !== "forward") ||
      (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 2_000))) throw invalid();
    const request: AbnormalSnapshotReplayRequest = {
      marketRef: { version: 1, kind: "market-cross-section", revision: marketRevision },
      sessions: parseExchangeSessions(sessions), adjustment, histories: parseArchivedStockHistories(histories), limit,
    };
    try { return await replayTspAbnormalSnapshot(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested abnormal snapshot archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-intraday-signal") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const { version, minuteRevision, rule: conditions, previousClose } = observationManifestObject(
      await readObservationJsonFile(path, maxRevisionFileBytes, signal), ["version", "minuteRevision", "rule", "previousClose"],
    );
    if (version !== 1 || typeof minuteRevision !== "string" || !revisionPattern.test(minuteRevision)) throw invalid();
    let rule;
    try { rule = parseTspIntradaySignalRule(conditions); } catch { throw invalid(); }
    const close = parseIntradayPreviousClose(previousClose);
    try {
      return await replayTspIntradaySignal({ version: 1, kind: "historical-minute-bars", revision: minuteRevision }, rule,
        { signal, previousClose: close });
    } catch {
      throw Object.assign(new Error("Could not replay the requested minute signal archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-daily-monitor-alerts") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseDailyMonitorAlertManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspDailyMonitorAlerts(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested daily monitor archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-intraday-monitor-alerts") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseIntradayMonitorAlertManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspIntradayMonitorAlerts(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested intraday monitor archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-list-rows" || action === "read-list-quotes") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseListRowsManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try {
      return await (action === "read-list-quotes" ? replayTspListRowsWithLiveQuotes(request, { signal })
        : replayTspListRows(request, signal));
    }
    catch {
      throw Object.assign(new Error("Could not replay the list with these dated archives and stock scope."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-screener-archives" || action === "replay-screener-union") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const value = await readObservationJsonFile(path, maxObservationManifestBytes, signal);
    const request = action === "replay-screener-archives" ? parseScreenerArchiveManifest(value) : parseScreenerUnionManifest(value);
    try {
      return await ("strategies" in request ? replayTspScreenerUnion(request, signal) : replayTspScreener(request, signal));
    }
    catch {
      throw Object.assign(new Error("Could not replay the screener with these dated archives and strategy settings."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-screener-score") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const value = await readObservationJsonFile(path, maxObservationManifestBytes, signal);
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !("version" in value) || value.version !== 1 || !("input" in value) || Object.keys(value).length !== 2) throw invalid();
    try { return computeTspScreenerScores(value.input as TspScreenerScoreInput); }
    catch { throw invalid(); }
  }
  if (action === "replay-list-liquidity") {
    const fields = parseOptions(options, ["--revision", "--symbol"]);
    const revision = fields.get("--revision"), symbol = fields.get("--symbol");
    if (!revision || !revisionPattern.test(revision) || !symbol || !datedStock.test(symbol)) throw invalid();
    try { return await replayTspListLiquidity({ version: 1, kind: "market-cross-section", revision }, symbol, signal); }
    catch {
      throw Object.assign(new Error("Could not replay list liquidity. Verify the market archive revision and stock membership."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-watchlist-return") {
    const fields = parseOptions(options, ["--revision", "--as-of", "--membership-revision"]);
    const revision = fields.get("--revision"), asOf = fields.get("--as-of");
    const membershipRevision = fields.get("--membership-revision");
    if (!revision || !revisionPattern.test(revision) || !asOf || !isDailyDate(asOf) || asOf < "0001-01-01" ||
      (membershipRevision !== undefined && !revisionPattern.test(membershipRevision))) throw invalid();
    try { return await replayTspWatchlistReturn({ ref: { version: 2, revision }, asOf, membershipRevision }, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the watchlist return. Verify stock membership, revision and forward-adjusted history."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-index-daily" || action === "collect-etf-daily") {
    const fields = parseOptions(options, ["--symbol", "--start", "--end"]);
    const symbol = fields.get("--symbol")?.trim().toUpperCase();
    const start = fields.get("--start"), end = fields.get("--end");
    const etf = action === "collect-etf-daily";
    const validateSymbol = etf ? isDatedEtfSymbol : isDatedBenchmarkIndexSymbol;
    if (!symbol || !validateSymbol(symbol) || !start || !end || !isDailyDate(start) || !isDailyDate(end) ||
      start < "0001-01-01" || start > end || end >= shanghaiDate.format() || Date.parse(end) - Date.parse(start) >= 366 * dayMs) throw invalid();
    const collect = etf ? collectDatedEtfDailyBars : collectDatedIndexDailyBars;
    try { return await collect({ symbol, start, end }, { signal }); }
    catch {
      throw Object.assign(new Error(`Could not collect the dated ${etf ? "ETF" : "index"} daily candles. Check the configured Source and provider access.`),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-index-daily" || action === "read-index-daily-quote") {
    const readQuote = action === "read-index-daily-quote";
    const allowed = ["--revision", "--start", "--end"];
    if (readQuote) allowed.push("--calendar-revision", "--previous-date", "--date");
    const fields = parseOptions(options, allowed);
    const revision = fields.get("--revision"), start = fields.get("--start"), end = fields.get("--end");
    if (!revision || !revisionPattern.test(revision) ||
      ((start || end) && (!start || !end || !isDailyDate(start) || !isDailyDate(end) || start < "0001-01-01" || start > end))) throw invalid();
    const displayRange = start && end ? { start, end } : undefined;
    const calendar = readQuote ? parseObservationSessionPair({
      revision: fields.get("--calendar-revision"), previousTradeDate: fields.get("--previous-date"), tradeDate: fields.get("--date"),
    }) : undefined;
    if (calendar && calendar.previousTradeDate < "0001-01-01") throw invalid();
    const ref = { version: 1, kind: "dated-index-daily", revision } as const;
    try {
      if (calendar) return await readDatedIndexDailyWithQuote({ ref, displayRange, calendar }, { signal, timeoutMs: 10_000 });
      return await replayDatedIndexDailyBars({ ref, displayRange }, signal);
    }
    catch {
      throw Object.assign(new Error("Could not replay the index daily revision for the requested display range."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-index-minutes") {
    const fields = parseOptions(options, ["--symbol", "--date"]);
    const symbol = fields.get("--symbol")?.trim().toUpperCase();
    const tradeDate = fields.get("--date");
    if (!symbol || !isDatedBenchmarkIndexSymbol(symbol) || !tradeDate || !isDailyDate(tradeDate) ||
      tradeDate < "0001-01-01" || tradeDate >= shanghaiDate.format()) throw invalid();
    try { return await collectDatedIndexMinutes({ symbol, tradeDate }, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the dated index minutes. Check the configured Source and provider access."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "read-list-auction-overlay") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseListAuctionOverlayManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try {
      return await readTspListAuctionOverlay(request, { signal, timeoutMs: 10_000 });
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not read the requested TSP auction overlay."), { code: "observation_collection_failed" });
    }
  }
  if (action === "read-current-etf-minutes") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseCurrentEtfMinuteManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try {
      return await previewCurrentTspEtfIntraday(request, { signal, timeoutMs: 10_000 });
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not read current ETF minutes with the requested evidence."), { code: "observation_collection_failed" });
    }
  }
  if (action === "read-current-stock-minutes") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseCurrentStockMinuteManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try {
      return await previewCurrentTspListIntraday(request, { signal, timeoutMs: 10_000 });
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not read current stock minutes with the requested evidence."), { code: "observation_collection_failed" });
    }
  }
  if (action === "read-current-index-minutes") {
    const fields = parseOptions(options, ["--symbol", "--date", "--daily-revision", "--previous-date", "--calendar-revision"]);
    const symbol = fields.get("--symbol")?.trim().toUpperCase(), tradeDate = fields.get("--date");
    if (!symbol || !isDatedBenchmarkIndexSymbol(symbol) || tradeDate !== shanghaiDate.format(Date.now())) throw invalid();
    const previousClose = fields.size > 2 ? parseIndexPreviousClose(fields.get("--daily-revision"), {
      revision: fields.get("--calendar-revision"), previousTradeDate: fields.get("--previous-date"), tradeDate,
    }) : undefined;
    try {
      return await previewCurrentIndexMinutes({ symbol, tradeDate, previousClose }, { signal, timeoutMs: 10_000 });
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not read current index minutes with the requested evidence."), { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-index-minutes") {
    const fields = parseOptions(options, ["--revision", "--daily-revision", "--previous-date", "--date", "--calendar-revision"]);
    const revision = fields.get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    const request: DatedIndexMinuteReplayRequest = { minuteRef: { version: 1, kind: "dated-index-minute", revision } };
    if (fields.size > 1) {
      request.previousClose = parseIndexPreviousClose(fields.get("--daily-revision"), {
        revision: fields.get("--calendar-revision"), previousTradeDate: fields.get("--previous-date"), tradeDate: fields.get("--date"),
      });
    }
    try { return await replayDatedIndexMinutes(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the index minute revision and its optional previous-close evidence."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-benchmark" || action === "collect-limits") {
    const fields = parseOptions(options, ["--symbol", "--start", "--end"]);
    const symbol = fields.get("--symbol")?.toUpperCase(), start = fields.get("--start"), end = fields.get("--end");
    const benchmark = action === "collect-benchmark";
    if (!symbol || (benchmark
      ? !isDatedBenchmarkIndexSymbol(symbol)
      : isAIndexSymbol(symbol) || !datedStock.test(symbol)) ||
      !start || !end || !isDailyDate(start) || !isDailyDate(end) || start > end || Date.parse(end) - Date.parse(start) > 365 * dayMs) {
      throw invalid();
    }
    try {
      if (benchmark) return await collectBenchmarkIndexObservations({ symbol, start, end }, { signal });
      return await collectTradingLimitObservations({ symbol, startDate: start, endDate: end }, { signal });
    } catch {
      throw Object.assign(new Error("Could not collect the requested benchmark or exchange limits. Check the configured source with whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "archive-market-regime-manifest") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const manifest = await readObservationJsonFile(path, MARKET_REGIME_MANIFEST_MAX_BYTES, signal);
    const request = parseRegimeSummaryManifest(manifest);
    try {
      const ref = await archiveMarketRegimeManifest(JSON.stringify(manifest), signal);
      return { ref, sessionCount: request.sessions.length };
    } catch {
      throw Object.assign(new Error("Could not archive the requested market regime manifest."), { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-market-regime-summary") {
    const selection = parseOptions(options, ["--manifest", "--revision"]);
    if (selection.size !== 1) throw invalid();
    const path = selection.get("--manifest"), revision = selection.get("--revision");
    if (!path && (!revision || !revisionPattern.test(revision))) throw invalid();
    const request = path ? parseRegimeSummaryManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal)) : undefined;
    try {
      const input = request ?? parseRegimeSummaryManifest(await loadMarketRegimeManifest({
        version: 1, kind: "market-regime-manifest", revision: revision!,
      }, signal));
      return await replayTspMarketRegimeSummary(input, signal);
    } catch {
      throw Object.assign(new Error("Could not replay the requested market regime summary archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-market-environment") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseEnvironmentManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspMarketEnvironment(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market environment archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-auction") {
    const tradeDate = parseOptions(options, ["--date"]).get("--date");
    if (!tradeDate || !isDailyDate(tradeDate)) throw invalid();
    try { return await collectAuctionBenchmark(tradeDate, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested auction benchmark. Check the configured Fuyao credential and date."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-auction") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseAuctionManifest(await readObservationJsonFile(path, 4096, signal));
    try { return await replayTspAuctionBenchmark(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested auction benchmark and price archive revisions."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-dragon-tiger") {
    const fields = parseOptions(options, ["--date", "--board"]);
    const tradeDate = fields.get("--date"), board = fields.get("--board");
    if (!tradeDate || !isDailyDate(tradeDate) || (board !== "all" && board !== "org" && board !== "hot_money")) throw invalid();
    try { return await collectDragonTigerBoard(tradeDate, board, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested dragon-tiger board. Check the configured Fuyao credential and date."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-dragon-tiger") {
    const fields = parseOptions(options, ["--date", "--revisions"]);
    const tradeDate = fields.get("--date"), csv = fields.get("--revisions");
    if (!tradeDate || !isDailyDate(tradeDate) || !csv) throw invalid();
    const revisions = validateRevisions(csv.split(","));
    if (revisions.length > 3) throw invalid();
    try {
      return await replayTspDragonTiger({ tradeDate, refs: revisions.map(revision => ({ version: 1, kind: "dragon-tiger-board", revision })) }, signal);
    } catch {
      throw Object.assign(new Error("Could not replay the requested dragon-tiger board archive revisions."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-money-flow") {
    const tradeDate = parseOptions(options, ["--date"]).get("--date");
    if (!tradeDate || !isDailyDate(tradeDate) || tradeDate < "2010-01-01" || tradeDate > shanghaiDate.format()) throw invalid();
    try { return await collectDatedMoneyFlow(tradeDate, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested money flows. Check the selected Tushare source, credential and date."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-money-flow") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    try { return await replayDatedMoneyFlow({ version: 1, kind: "dated-money-flow", revision }, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested money-flow archive revision."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-popularity") {
    const calendarDate = parseOptions(options, ["--date"]).get("--date");
    if (!calendarDate || !isDailyDate(calendarDate) || calendarDate < "0001-01-01" || calendarDate > shanghaiDate.format()) throw invalid();
    try { return await collectDatedPopularityList(calendarDate, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested historical popularity list. Check Fuyao access and the provider date range."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-popularity") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    try { return await replayDatedPopularityList({ version: 1, kind: "dated-popularity-list", revision }, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested popularity archive revision."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-market-mainline") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseMainlineManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspMarketMainline(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market mainline archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-market-emotion") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseEmotionManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspMarketEmotion(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market emotion archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-price-deviation") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parsePriceDeviationManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspPriceDeviation(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested price deviation archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-sector-catalog" || action === "collect-sector-members") {
    const catalog = action === "collect-sector-catalog";
    const fields = parseOptions(options, ["--date", catalog ? "--kind" : "--sector-code"]);
    const tradeDate = fields.get("--date"), groupKind = fields.get("--kind"), sectorCode = fields.get("--sector-code");
    if (!tradeDate || !isDailyDate(tradeDate)) throw invalid();
    let request: SectorCollectionRequest;
    if (catalog) {
      if (groupKind !== "industry" && groupKind !== "concept") throw invalid();
      request = { kind: "dated-sector-catalog", groupKind, tradeDate };
    } else {
      if (!sectorCode || !/^BK\d{4,8}\.DC$/.test(sectorCode)) throw invalid();
      request = { kind: "dated-sector-members", sectorCode, tradeDate };
    }
    try {
      return await collectSectorObservations(request, { signal });
    } catch {
      throw Object.assign(new Error("Could not collect dated sector observations. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-sector-rank") {
    const fields = parseOptions(options, ["--market-revision", "--catalog-revision", "--members-file"]);
    const market = fields.get("--market-revision"), catalog = fields.get("--catalog-revision"), path = fields.get("--members-file");
    if (!market || !catalog || !path || !revisionPattern.test(market) || !revisionPattern.test(catalog)) throw invalid();
    const revisions = await readRevisionFile(path, signal);
    if (revisions.length >= 5_000) throw invalid();
    try {
      return await replayTspSectorRanking({
        marketRef: { version: 1, kind: "market-cross-section", revision: market },
        catalogRef: { version: 1, kind: "dated-sector-catalog", revision: catalog },
        memberRefs: revisions.map(revision => ({ version: 1, kind: "dated-sector-members", revision })),
      }, signal);
    } catch {
      throw Object.assign(new Error("Could not replay the requested market and sector archive revisions."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-sector-rotation") {
    const fields = parseOptions(options, ["--manifest", "--days"]);
    const path = fields.get("--manifest"), requestedDays = fields.get("--days") ?? "12";
    const days = Number(requestedDays);
    if (!path || !/^\d+$/.test(requestedDays) || !Number.isSafeInteger(days)) throw invalid();
    const requests = parseRotationManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspSectorRotation(requests, days, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested sector rotation archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-sector-monitor") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseSectorMonitorManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspSectorMonitor(request, signal); }
    catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not replay the requested sector monitor archives. Verify the date, revisions and scope."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-daily" || action === "collect-minutes") {
    const minutes = action === "collect-minutes";
    const flags = ["--symbol", "--start", "--end"];
    if (!minutes) flags.push("--adjustment");
    const fields = parseOptions(options, flags);
    const symbol = fields.get("--symbol"), startDate = fields.get("--start"), endDate = fields.get("--end");
    const adjustment = fields.get("--adjustment") ?? "none";
    if (!symbol || !datedStock.test(symbol) ||
      !startDate || !endDate || !isDailyDate(startDate) || !isDailyDate(endDate) ||
      startDate < (minutes ? "2010-01-01" : "0001-01-01") || endDate > "9998-12-31" || startDate > endDate ||
      Date.parse(endDate) - Date.parse(startDate) > (minutes ? 30 : 365) * dayMs ||
      (adjustment !== "none" && adjustment !== "forward")) {
      throw invalid();
    }
    if (minutes && endDate >= shanghaiDate.format()) throw invalid();
    try {
      if (minutes) return await collectHistoricalMinuteObservations({ symbol, startDate, endDate }, { signal });
      return await collectTradingDateObservations({ timeMode: "trading-date", symbol, assetType: "stock",
        interval: "1d", adjustment, startDate, endDate }, { signal });
    } catch {
      const dataset = minutes ? "historical minute" : "daily";
      throw Object.assign(new Error(`Could not collect ${dataset} observations. Check the configured source and use whyj --json doctor --phase data.`),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "collect-market") {
    const date = parseOptions(options, ["--date"]).get("--date");
    if (!date || !isDailyDate(date) || date < "2016-01-01" || date > shanghaiDate.format()) throw invalid();
    try { return await collectMarketCrossSection(date, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested market cross-section. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-market") {
    const fields = parseOptions(options, ["--revision", "--price-revisions", "--price-revisions-file", "--volume-revisions"]);
    const revision = fields.get("--revision"), priceList = fields.get("--price-revisions"), priceFile = fields.get("--price-revisions-file");
    if (!revision || !revisionPattern.test(revision) || (priceList && priceFile)) throw invalid();
    const volumeRevisions = validateRevisions(fields.get("--volume-revisions")?.split(",") ?? []);
    if (volumeRevisions.length > 5 || volumeRevisions.includes(revision)) throw invalid();
    const priceRevisions = priceFile ? await readRevisionFile(priceFile, signal) : validateRevisions(priceList?.split(",") ?? []);
    const history = priceRevisions.length || volumeRevisions.length ? {
      priceArchives: priceRevisions.map(value => ({ version: 2, revision: value } as const)),
      volumeArchives: volumeRevisions.map(value => ({ version: 1, kind: "market-cross-section", revision: value } as const)),
    } : undefined;
    try { return await deriveTspMarketBreadthArchive({ version: 1, kind: "market-cross-section", revision }, signal, history); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market cross-section and its history."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-financial-indicators" || action === "collect-disclosure-dates") {
    const indicators = action === "collect-financial-indicators";
    const fields = parseOptions(options, indicators ? ["--symbol", "--start", "--end"] : ["--symbol", "--period"]);
    const symbol = fields.get("--symbol");
    if (!symbol || !datedStock.test(symbol)) throw invalid();
    let request: FinancialCollectionRequest;
    if (indicators) {
      const startPeriod = fields.get("--start"), endPeriod = fields.get("--end");
      if (!startPeriod || !endPeriod || !isDailyDate(startPeriod) || !isDailyDate(endPeriod) || startPeriod > endPeriod) throw invalid();
      request = { kind: "report-financial-indicators", symbol, startPeriod, endPeriod };
    } else {
      const periodEnd = fields.get("--period");
      if (!periodEnd || !isDailyDate(periodEnd)) throw invalid();
      request = { kind: "financial-disclosure-dates", symbol, periodEnd };
    }
    try { return await collectFinancialObservations(request, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested financial observations. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "backtest-robustness") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parseBacktestRobustnessManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return computeTspBacktestRobustness(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-backtest-portfolio") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parseBacktestPortfolioManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return computeTspBacktestPortfolio(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-paper-ledger") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parsePaperLedgerManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return replayTspPaperLedger(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-paper-statistics") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parsePaperStatisticsManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return computeTspPaperStatistics(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-paper-valuation") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parsePaperValuationManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspPaperValuation(request, signal); }
    catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not replay paper valuation. Verify holdings and fixed market archive revisions."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-paper-comparison") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parsePaperComparisonManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspPaperComparison(request, signal); }
    catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not replay paper comparison. Verify accounts and fixed market archive revisions."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-extension-groups") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const { schemaVersion, dataset: rawDataset, fields: rawFields, dimensionField, metrics: rawMetrics, rows } =
      observationManifestObject(await readObservationJsonFile(path, maxObservationManifestBytes, signal),
        ["schemaVersion", "dataset", "fields", "dimensionField", "metrics", "rows"]);
    if (schemaVersion !== 1 || typeof dimensionField !== "string" ||
      !Array.isArray(rawFields) || !Array.isArray(rawMetrics) || !Array.isArray(rows)) throw invalid();
    const dataset = observationManifestObject(rawDataset, ["id", "schemaRevision", "revision", "source", "frequency",
      "effectiveDate", "sourceAsOf", "observedAt", "coverage", "totalRows"]);
    const fields = rawFields.map(field => observationManifestObject(field, ["name", "type", "unit"]));
    const metrics = rawMetrics.map(metric => observationManifestObject(metric, ["field", "aggregate"]));
    // The calculator checks metadata, field types and row values against the same schema used for direct callers.
    try { return computeTspExtensionGroups({ dataset, fields, dimensionField, metrics, rows } as unknown as TspExtensionGroupsInput); }
    catch { throw invalid(); }
  }
  if (action === "replay-parameter-robustness") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parseParameterRobustnessManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return computeTspParameterRobustness(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-walk-forward") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parseWalkForwardManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return computeTspWalkForward(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-factor-evaluation") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseFactorEvaluationManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspFactorEvaluation(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested factor evidence. Verify the factor key, archive revisions and observation scope."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-factor-significance") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseFactorSignificanceManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspFactorSignificance(request, signal); }
    catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not replay the requested factor family. Verify factor keys, archive revisions and calendar."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-factor-mining-screen") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseFactorMiningScreenManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspFactorMiningScreen(request, signal); }
    catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not replay the mining screen. Verify factor keys, archive revisions and the training calendar."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-mining-candidate") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseMiningCandidateManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return computeTspMiningCandidateReport(request); }
    catch { throw invalid(); }
  }
  if (action === "replay-strategy-guardian-history") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parseGuardianHistory(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return summarizeTspStrategyGuardianHistory(input); }
    catch { throw invalid(); }
  }
  if (action === "replay-strategy-monitor-alerts") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const input = parseStrategyMonitorManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return replayTspStrategyMonitor(input); }
    catch { throw invalid(); }
  }
  if (action === "plan-strategy-guardian" || action === "replay-strategy-guardian") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const value = await readObservationJsonFile(path, maxObservationManifestBytes, signal);
    try {
      if (action === "replay-strategy-guardian") return evaluateTspStrategyGuardian(parseGuardianCheck(value));
      const plan = planTspStrategyGuardianCheck(parseGuardianPlan(observationManifestObject(value, guardianPlanKeys)));
      return { producer: "whyj", formulaVersion: TSP_STRATEGY_GUARDIAN_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION, ...plan };
    } catch { throw invalid(); }
  }
  if (action === "replay-analytics") {
    const fields = parseOptions(options, ["--revision", "--financial-report-revisions", "--financial-disclosure-revisions",
      "--turnover-revisions", "--confirm-unadjusted-cny-book-value"]);
    const revision = fields.get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    const reportRevisions = validateRevisions(fields.get("--financial-report-revisions")?.split(",") ?? []);
    const disclosureRevisions = validateRevisions(fields.get("--financial-disclosure-revisions")?.split(",") ?? []);
    const turnoverRevisions = validateRevisions(fields.get("--turnover-revisions")?.split(",") ?? []);
    if (turnoverRevisions.length > 366 || disclosureRevisions.some(value => reportRevisions.includes(value))) throw invalid();
    const confirmation = fields.get("--confirm-unadjusted-cny-book-value");
    let bookValueBasis;
    if (confirmation !== undefined) {
      const [reportRevision, periodEnd, ...extra] = confirmation.split(",");
      if (!reportRevision || !reportRevisions.includes(reportRevision) || !periodEnd || !isDailyDate(periodEnd) || extra.length) throw invalid();
      bookValueBasis = { reportRevision, periodEnd, basis: compatibleBookValueBasis } as const;
    }
    try {
      return await deriveTspArchiveAnalytics({ version: 2, revision }, signal, {
        financialArchives: [
          ...reportRevisions.map(value => ({ version: 1, kind: "report-financial-indicators", revision: value } as const)),
          ...disclosureRevisions.map(value => ({ version: 1, kind: "financial-disclosure-dates", revision: value } as const)),
        ],
        turnoverArchives: turnoverRevisions.map(value => ({ version: 1, kind: "market-cross-section", revision: value })),
        bookValueBasis,
      });
    } catch {
      throw Object.assign(new Error("Could not replay the requested daily analytics archive and its inputs."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-daily") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    try {
      return await deriveTspArchiveIndicators({ version: 2, revision }, signal);
    } catch {
      throw Object.assign(new Error("Could not read the requested daily archive revision."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-intraday") {
    const fields = parseOptions(options, ["--revision", "--previous-close-revision", "--price-basis"]);
    const revision = fields.get("--revision");
    const previousRevision = fields.get("--previous-close-revision");
    const priceBasis = fields.get("--price-basis");
    if (!revision || !revisionPattern.test(revision) ||
      (previousRevision ? !revisionPattern.test(previousRevision) || priceBasis !== compatiblePriceBasis : priceBasis !== undefined)) {
      throw invalid();
    }
    try {
      return await deriveTspArchiveIntraday({ version: 1, kind: "historical-minute-bars", revision }, {
        signal,
        previousClose: previousRevision ? {
          ref: { version: 1, kind: "daily-trading-limits", revision: previousRevision },
          priceBasis: compatiblePriceBasis,
        } : undefined,
      });
    } catch {
      throw Object.assign(new Error("Could not replay the requested minute archive and its supplementary inputs."),
        { code: "observation_archive_unavailable" });
    }
  }
  throw invalid();
}

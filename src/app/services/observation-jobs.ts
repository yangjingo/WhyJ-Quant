import { randomUUID } from "node:crypto";
import { deriveTspArchiveAnalytics } from "../../runtime/data/archive-analytics.ts";
import { collectObservations, collectTradingDateObservations, collectTradingLimitObservations, deriveTspArchiveIndicators,
  type DailySignalExchangeRefs, type ObservationCollectionRequest } from "../../runtime/data/observation-collection.ts";
import { collectHistoricalMinuteObservations, deriveTspArchiveIntraday } from "../../runtime/data/intraday-replay.ts";
import { isDailyDate } from "../../market/bars.ts";
import type { ObservationAnalyticsPreview, ObservationIndicatorPreview, ObservationIntradayPreview, ObservationIntradayRequest,
  ObservationJobRequest, ObservationJobView } from "../../types/workbench.ts";
import type { TradingDateArchiveRef } from "../../types/observation.ts";
import { WorkbenchError } from "../workbench/errors.ts";

const invalid = () => new WorkbenchError("INPUT_INVALID", "采集参数无效。", 400);
const notFound = () => new WorkbenchError("OBSERVATION_JOB_NOT_FOUND", "未找到该采集任务。", 404);
const intervals = ["1m", "5m", "10m", "15m", "30m", "60m"];
const day = 86_400_000;
const revision = /^[a-f0-9]{64}$/;
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalidReference = () => new WorkbenchError("INPUT_INVALID", "日线归档引用无效。", 400);

function dailyReference(value: unknown): TradingDateArchiveRef {
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "version") || !Object.hasOwn(value, "revision") ||
    value.version !== 2 || typeof value.revision !== "string" || !revision.test(value.revision)) throw invalidReference();
  return { version: 2, revision: value.revision };
}

function fixedReference<Kind extends "daily-trading-limits" | "historical-minute-bars">(
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

export async function readObservationAnalytics(value: unknown): Promise<ObservationAnalyticsPreview> {
  const ref = dailyReference(value);
  try {
    return await deriveTspArchiveAnalytics(ref, AbortSignal.timeout(30_000));
  } catch {
    throw new WorkbenchError("OBSERVATION_ARCHIVE_UNAVAILABLE", "无法读取指定的日线归档。请核对归档引用后重试。", 404);
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
  let previousClose: ObservationIntradayRequest["previousClose"];
  if (Object.hasOwn(value, "previousClose")) {
    const input = value.previousClose;
    if (!object(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "ref") ||
      !Object.hasOwn(input, "priceBasis") || input.priceBasis !== "caller-confirmed-same-basis") throw invalidIntraday();
    previousClose = { ref: fixedReference(input.ref, "daily-trading-limits", invalidIntraday), priceBasis: input.priceBasis };
  }
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
      typeof symbol !== "string" || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(symbol) ||
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

import { isDailyDate } from "../../market/bars.ts";
import { isDatedBenchmarkIndexSymbol } from "../../market/symbols.ts";
import { computeTspIndexMinuteReturns } from "../../quant/index.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveDatedIndexMinutes, loadBenchmarkIndexArchive, loadDatedIndexMinuteArchive,
  type BenchmarkIndexArchiveRef, type DatedIndexMinuteArchiveRef, type StoredDatedIndexMinuteBatch } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface DatedIndexMinuteCollectionRequest {
  symbol: string;
  tradeDate: string;
}

export interface DatedIndexMinuteReplayRequest {
  minuteRef: DatedIndexMinuteArchiveRef;
  previousClose?: {
    dailyRef: BenchmarkIndexArchiveRef;
    calendar: { revision: string; previousTradeDate: string; tradeDate: string };
  };
}

export interface CurrentIndexMinutePreviewRequest extends DatedIndexMinuteCollectionRequest {
  previousClose?: DatedIndexMinuteReplayRequest["previousClose"];
}

export async function collectDatedIndexMinutes(request: DatedIndexMinuteCollectionRequest, options: SourceRequestOptions = {}) {
  const { symbol, tradeDate } = request;
  const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!isDatedBenchmarkIndexSymbol(code) || typeof tradeDate !== "string" || !isDailyDate(tradeDate)) {
    throw new TypeError("Invalid dated index minute request.");
  }
  const control = { ...options };
  control.signal?.throwIfAborted();
  const selected = await createConfiguredMarketDataSource(control.signal);
  const { source, endpoint, market, coverage, observedAt, data } = await selected.fetchDatedIndexMinutes({
    symbol: code, market: "A", tradeDate,
  }, control);
  if (source !== "tickflow" || endpoint !== "/v1/klines" || market !== "A" ||
    data.symbol !== code || data.tradeDate !== tradeDate) {
    throw new Error("Dated index minute response does not match its scope.");
  }
  const { rows, ...metadata } = data;
  const evidence = { ...metadata, source, endpoint, market, coverage, observedAt } as const;
  const ref = await archiveDatedIndexMinutes({ ...evidence, rows }, control.signal);
  return { ...evidence, ref, rowCount: rows.length, status: rows.length ? "archived" as const : "empty" as const };
}

function copyPreviousClose(previousClose: DatedIndexMinuteReplayRequest["previousClose"]) {
  return previousClose && { dailyRef: { ...previousClose.dailyRef }, calendar: { ...previousClose.calendar } };
}

async function readIndexPreviousClose(
  minutes: Pick<StoredDatedIndexMinuteBatch, "symbol" | "source" | "market" | "priceUnit" | "tradeDate">,
  previousClose: DatedIndexMinuteReplayRequest["previousClose"],
  signal?: AbortSignal,
) {
  if (!previousClose) return null;
  const { dailyRef, calendar } = previousClose;
  const { revision, previousTradeDate, tradeDate } = calendar;
  if (typeof revision !== "string" || !revision.trim() || typeof previousTradeDate !== "string" ||
    !isDailyDate(previousTradeDate) || tradeDate !== minutes.tradeDate || previousTradeDate >= tradeDate) {
    throw new Error("Previous-close calendar does not match the requested index session.");
  }
  const daily = await loadBenchmarkIndexArchive(dailyRef, signal);
  if (daily.symbol !== minutes.symbol || daily.source !== minutes.source || daily.market !== minutes.market ||
    daily.priceUnit !== minutes.priceUnit || previousTradeDate < daily.requested.start || previousTradeDate > daily.requested.end) {
    throw new Error("Previous-close archive does not match the index, provider or previous session.");
  }
  return { dailyRef, calendar, observedAt: daily.observedAt, row: daily.rows.find(row => row.tradeDate === previousTradeDate) ?? null };
}

export async function replayDatedIndexMinutes(request: DatedIndexMinuteReplayRequest, signal?: AbortSignal) {
  const minuteRef = { ...request.minuteRef };
  const previousClose = copyPreviousClose(request.previousClose);
  const minutes = await loadDatedIndexMinuteArchive(minuteRef, signal);
  const closeEvidence = await readIndexPreviousClose(minutes, previousClose, signal);
  signal?.throwIfAborted();
  return {
    input: { minutes: { ref: minuteRef, ...minutes }, previousClose: closeEvidence },
    metrics: computeTspIndexMinuteReturns(minutes.rows, closeEvidence?.row?.closePoints ?? null),
  };
}

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

/** Bind a provisional current frame to an optional fixed previous close. */
export async function previewCurrentIndexMinutes(request: CurrentIndexMinutePreviewRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  const { signal } = control;
  signal?.throwIfAborted();
  const { symbol, tradeDate } = request;
  const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!isDatedBenchmarkIndexSymbol(code)) throw new TypeError("Invalid current index minute symbol.");
  if (tradeDate !== shanghaiDate.format(Date.now())) throw new TypeError("The current Shanghai date is required.");
  const scope = { symbol: code, source: "tickflow", market: "A", priceUnit: "index-points", tradeDate } as const;
  const closeEvidence = await readIndexPreviousClose(scope, copyPreviousClose(request.previousClose), signal);
  const selected = await createConfiguredMarketDataSource(signal);
  const { source, endpoint, market, coverage, observedAt, data } = await selected.fetchCurrentIndexMinutes({
    symbol: code, market: scope.market, tradeDate,
  }, control);
  if (source !== scope.source || endpoint !== "/v1/klines" || market !== scope.market ||
    data.symbol !== code || data.tradeDate !== tradeDate || data.finality !== "provisional" || data.priceUnit !== scope.priceUnit) {
    throw new Error("Current index minute response does not match its scope.");
  }
  signal?.throwIfAborted();
  const status = data.requestedWindow === null ? "before-window" as const : data.rows.length ? "observed" as const : "empty" as const;
  return {
    status,
    input: { minutes: { ...data, source, endpoint, market, coverage, observedAt }, previousClose: closeEvidence },
    metrics: computeTspIndexMinuteReturns(data.rows, closeEvidence?.row?.closePoints ?? null),
  };
}
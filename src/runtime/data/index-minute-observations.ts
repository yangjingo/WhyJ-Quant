import { isDailyDate } from "../../market/bars.ts";
import { isDatedBenchmarkIndexSymbol } from "../../market/symbols.ts";
import { computeTspIndexMinuteReturns } from "../../quant/index.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveDatedIndexMinutes, loadBenchmarkIndexArchive, loadDatedIndexMinuteArchive,
  type BenchmarkIndexArchiveRef, type DatedIndexMinuteArchiveRef } from "../../storage/index.ts";
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

export async function replayDatedIndexMinutes(request: DatedIndexMinuteReplayRequest, signal?: AbortSignal) {
  const minuteRef = { ...request.minuteRef };
  const previousClose = request.previousClose && {
    dailyRef: { ...request.previousClose.dailyRef },
    calendar: { ...request.previousClose.calendar },
  };
  const minutes = await loadDatedIndexMinuteArchive(minuteRef, signal);
  let closeEvidence = null;
  if (previousClose) {
    const { dailyRef, calendar } = previousClose;
    const { revision, previousTradeDate, tradeDate } = calendar;
    if (typeof revision !== "string" || !revision.trim() || typeof previousTradeDate !== "string" ||
      !isDailyDate(previousTradeDate) || tradeDate !== minutes.tradeDate || previousTradeDate >= tradeDate) {
      throw new Error("Previous-close calendar does not match the archived index session.");
    }
    const daily = await loadBenchmarkIndexArchive(dailyRef, signal);
    if (daily.symbol !== minutes.symbol || daily.source !== minutes.source || daily.market !== minutes.market ||
      daily.priceUnit !== minutes.priceUnit ||
      previousTradeDate < daily.requested.start || previousTradeDate > daily.requested.end) {
      throw new Error("Previous-close archive does not match the index, provider or previous session.");
    }
    closeEvidence = { dailyRef, calendar, observedAt: daily.observedAt,
      row: daily.rows.find(row => row.tradeDate === previousTradeDate) ?? null };
  }
  signal?.throwIfAborted();
  return {
    input: { minutes: { ref: minuteRef, ...minutes }, previousClose: closeEvidence },
    metrics: computeTspIndexMinuteReturns(minutes.rows, closeEvidence?.row?.closePoints ?? null),
  };
}
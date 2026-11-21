import { isDailyDate } from "../../market/bars.ts";
import { isDatedBenchmarkIndexSymbol } from "../../market/symbols.ts";
import { computeTspDailyIndicators, TSP_DAILY_INDICATOR_FORMULA_VERSION, TSP_INDICATOR_REVISION } from "../../quant/index.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveDatedIndexDailyBars, loadDatedIndexDailyArchive, type DatedIndexDailyArchiveRef } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

interface IndexDailyDateRange {
  start: string;
  end: string;
}

export interface DatedIndexDailyCollectionRequest extends IndexDailyDateRange {
  symbol: string;
}

export interface DatedIndexDailyReplayRequest {
  ref: DatedIndexDailyArchiveRef;
  displayRange?: IndexDailyDateRange;
}

function validDateRange({ start, end }: IndexDailyDateRange): boolean {
  return typeof start === "string" && typeof end === "string" &&
    isDailyDate(start) && isDailyDate(end) && start >= "0001-01-01" && start <= end;
}

export async function collectDatedIndexDailyBars(request: DatedIndexDailyCollectionRequest, options: SourceRequestOptions = {}) {
  const { symbol, start, end } = request;
  const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!isDatedBenchmarkIndexSymbol(code) || !validDateRange({ start, end })) {
    throw new TypeError("Invalid dated index daily request.");
  }
  const control = { ...options };
  control.signal?.throwIfAborted();
  const selected = await createConfiguredMarketDataSource(control.signal);
  const { source, endpoint, market, coverage, observedAt, data } = await selected.fetchDatedIndexDailyBars({
    symbol: code, market: "A", start, end,
  }, control);
  if (source !== "tickflow" || endpoint !== "/v1/klines" || market !== "A" || data.symbol !== code ||
    data.requested.start !== start || data.requested.end !== end) throw new Error("Dated index daily response does not match its scope.");
  const { rows, ...metadata } = data;
  const evidence = { ...metadata, source, endpoint, market, coverage, observedAt } as const;
  const ref = await archiveDatedIndexDailyBars({ ...evidence, rows }, control.signal);
  return { ...evidence, ref, rowCount: rows.length, status: rows.length ? "archived" as const : "empty" as const };
}

export async function replayDatedIndexDailyBars(request: DatedIndexDailyReplayRequest, signal?: AbortSignal) {
  const ref = { ...request.ref };
  const requestedDisplay = request.displayRange && { ...request.displayRange };
  const daily = await loadDatedIndexDailyArchive(ref, signal);
  const displayRange = requestedDisplay ?? daily.requested;
  if (!validDateRange(displayRange) || displayRange.start < daily.requested.start || displayRange.end > daily.requested.end) {
    throw new RangeError("Index chart display range must fit within its archived request.");
  }
  const bars = daily.rows.filter(row => row.tradeDate <= displayRange.end);
  signal?.throwIfAborted();
  const indicators = computeTspDailyIndicators(bars.map(row => ({
    date: row.tradeDate, open: row.openPoints, high: row.highPoints, low: row.lowPoints, close: row.closePoints, volume: row.volume,
  })));
  return {
    input: { daily: { ref, ...daily } },
    metrics: {
      producer: "whyj" as const,
      formulaVersion: TSP_DAILY_INDICATOR_FORMULA_VERSION,
      referenceRevision: TSP_INDICATOR_REVISION,
      displayRange,
      calculationWindow: { firstDate: bars[0]?.tradeDate ?? null, lastDate: bars.at(-1)?.tradeDate ?? null, rowCount: bars.length },
      rows: indicators.filter(row => row.date >= displayRange.start)
        .map(({ date, ma5, ma10, ma20, ma60, macd_dif, macd_dea, macd_hist, rsi_6, rsi_14, rsi_24,
          kdj_k, kdj_d, kdj_j, boll_upper, boll_lower }) => ({
          date, ma5, ma10, ma20, ma60, macd_dif, macd_dea, macd_hist, rsi_6, rsi_14, rsi_24,
          kdj_k, kdj_d, kdj_j, boll_upper, boll_lower,
        })),
    },
  };
}
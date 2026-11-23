import { isDailyDate } from "../../market/bars.ts";
import { isDatedEtfSymbol } from "../../market/symbols.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveDatedEtfDailyBars } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface DatedEtfDailyCollectionRequest {
  symbol: string;
  start: string;
  end: string;
}

export async function collectDatedEtfDailyBars(request: DatedEtfDailyCollectionRequest, options: SourceRequestOptions = {}) {
  const { symbol, start, end } = request;
  const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!isDatedEtfSymbol(code) || !isDailyDate(start) || !isDailyDate(end) || start < "0001-01-01" || start > end) {
    throw new Error("Invalid dated ETF daily request");
  }
  const control = { ...options };
  control.signal?.throwIfAborted();
  const selected = await createConfiguredMarketDataSource(control.signal);
  const { source, endpoint, market, coverage, observedAt, data } = await selected.fetchDatedEtfDailyBars({
    symbol: code, market: "A", start, end,
  }, control);
  if ((source !== "tushare" && source !== "tickflow") || (endpoint !== "fund_daily" && endpoint !== "/v1/klines") ||
    market !== "A" || data.symbol !== code || data.requested.start !== start || data.requested.end !== end) {
    throw new Error("Dated ETF daily response does not match its scope");
  }
  const { rows, ...metadata } = data;
  const evidence = { ...metadata, source, endpoint, market, coverage, observedAt } as const;
  const ref = await archiveDatedEtfDailyBars({ ...evidence, rows }, control.signal);
  return { ...evidence, ref, rowCount: rows.length, status: rows.length ? "archived" as const : "empty" as const };
}

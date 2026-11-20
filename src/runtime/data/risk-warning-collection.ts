import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveRiskWarningObservations } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

/** Capture the dated provider list so the same trade-date evidence can be reopened offline. */
export async function collectRiskWarningObservations(tradeDate: string, options: SourceRequestOptions = {}) {
  const control = { ...options };
  control.signal?.throwIfAborted();
  const configured = await createConfiguredMarketDataSource(control.signal);
  const { source, market, endpoint, observedAt, coverage, data } = await configured.fetchDatedRiskWarnings({ market: "A", tradeDate }, control);
  if (source !== "tushare" || market !== "A" || endpoint !== "stock_st" || data.tradeDate !== tradeDate) {
    throw new Error("Risk-warning response scope does not match the request");
  }
  const capture = { source, market, endpoint, observedAt, coverage, tradeDate } as const;
  const ref = await archiveRiskWarningObservations({ ...capture, rows: data.rows }, control.signal);
  return { ...capture, ref, status: data.rows.length ? "archived" as const : "empty" as const, rowCount: data.rows.length };
}

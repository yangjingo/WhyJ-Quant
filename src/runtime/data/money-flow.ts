import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveMoneyFlow, loadMoneyFlowArchive, type MoneyFlowArchiveRef } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export async function collectDatedMoneyFlow(tradeDate: string, options: SourceRequestOptions = {}) {
  const control = { ...options };
  control.signal?.throwIfAborted();
  const configured = await createConfiguredMarketDataSource(control.signal);
  const { source, market, endpoint, observedAt, coverage, data } = await configured.fetchDatedMoneyFlow({ market: "A", tradeDate }, control);
  if (source !== "tushare" || market !== "A" || endpoint !== "moneyflow" || data.tradeDate !== tradeDate) {
    throw new Error("Money-flow response scope does not match the request");
  }
  const capture = { source, market, endpoint, observedAt, coverage, tradeDate, volumeUnit: data.volumeUnit, amountUnit: data.amountUnit } as const;
  const ref = await archiveMoneyFlow({ ...capture, rows: data.rows }, control.signal);
  return { ...capture, ref, status: data.rows.length ? "archived" as const : "empty" as const, rowCount: data.rows.length };
}

export async function replayDatedMoneyFlow(ref: MoneyFlowArchiveRef, signal?: AbortSignal) {
  const reference = { ...ref };
  return { ref: reference, observation: await loadMoneyFlowArchive(reference, signal) };
}

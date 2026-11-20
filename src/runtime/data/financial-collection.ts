import { normalizeSymbol } from "../../market/symbols.ts";
import type { MarketObservation, SourceRequestOptions } from "../../source/index.ts";
import { archiveFinancialObservations, type StoredFinancialObservationBatch } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export type FinancialCollectionRequest = { symbol: string } & (
  | { kind: "report-financial-indicators"; startPeriod: string; endPeriod: string }
  | { kind: "financial-disclosure-dates"; periodEnd: string }
);

function capturedRows<T extends { symbol: string }>(
  response: MarketObservation<T[]>, symbol: string, expectedEndpoint: StoredFinancialObservationBatch["endpoint"],
) {
  const { source, endpoint, market, coverage, observedAt, data } = response;
  if (source !== "tushare" || endpoint !== expectedEndpoint || market !== "A") {
    throw new Error("Unsupported financial observation");
  }
  const rows = data.map(({ symbol: rowSymbol, ...row }) => {
    if (rowSymbol !== symbol) throw new Error("Financial observation symbol does not match the request");
    return row;
  });
  return { symbol, source, market, coverage, observedAt, rows } as const;
}

/** Explicitly collect one configured provider response and bind it to an exact archive reference. */
export async function collectFinancialObservations(request: FinancialCollectionRequest, options: SourceRequestOptions = {}) {
  if (typeof request?.symbol !== "string" ||
    (request.kind !== "report-financial-indicators" && request.kind !== "financial-disclosure-dates")) {
    throw new Error("Invalid financial collection request");
  }
  const captured = { ...request };
  const symbol = normalizeSymbol(captured.symbol, "A");
  const control = { ...options };
  control.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(control.signal);
  control.signal?.throwIfAborted();

  let batch: StoredFinancialObservationBatch;
  if (captured.kind === "report-financial-indicators") {
    const requested = { startPeriod: captured.startPeriod, endPeriod: captured.endPeriod };
    const response = await source.fetchReportFinancialIndicators({ ...requested, symbol, market: "A" }, control);
    batch = { ...capturedRows(response, symbol, "fina_indicator"), endpoint: "fina_indicator", requested };
  } else {
    const requested = { periodEnd: captured.periodEnd };
    const response = await source.fetchFinancialDisclosureDates({ ...requested, symbol, market: "A" }, control);
    batch = { ...capturedRows(response, symbol, "disclosure_date"), endpoint: "disclosure_date", requested };
  }

  const ref = await archiveFinancialObservations(batch, control.signal);
  return {
    ref, status: batch.rows.length ? "archived" as const : "empty" as const, rowCount: batch.rows.length,
    symbol, source: batch.source, endpoint: batch.endpoint, observedAt: batch.observedAt,
  };
}

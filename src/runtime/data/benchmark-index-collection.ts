import type { SourceRequestOptions } from "../../source/index.ts";
import { archiveBenchmarkIndexObservations } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface BenchmarkIndexCollectionRequest {
  symbol: string;
  start: string;
  end: string;
}

/** Capture the selected provider's index observations with their original units. */
export async function collectBenchmarkIndexObservations(request: BenchmarkIndexCollectionRequest, options: SourceRequestOptions = {}) {
  const { symbol, start, end } = request;
  if (typeof symbol !== "string" || typeof start !== "string" || typeof end !== "string") {
    throw new Error("Invalid benchmark index collection request");
  }
  const code = symbol.trim().toUpperCase();
  const control = { ...options };
  control.signal?.throwIfAborted();
  const configured = await createConfiguredMarketDataSource(control.signal);
  const { source, market, endpoint, observedAt, coverage, data } =
    await configured.fetchDatedBenchmarkObservations({ market: "A", symbol: code, start, end }, control);
  const { rows, requested, priceUnit, returnUnit } = data;
  const provider = source === "tushare" && endpoint === "index_daily" ? { source, endpoint } as const
    : source === "tickflow" && endpoint === "/v1/klines" ? { source, endpoint } as const : null;
  if (!provider || market !== "A" || data.symbol !== code ||
    requested.start !== start || requested.end !== end) {
    throw new Error("Benchmark index response scope does not match the request");
  }
  const evidence = { ...provider, market, observedAt, coverage, symbol: code, requested, priceUnit, returnUnit } as const;
  const ref = await archiveBenchmarkIndexObservations({ ...evidence, rows }, control.signal);
  return { ...evidence, ref, status: rows.length ? "archived" as const : "empty" as const, rowCount: rows.length };
}

/** Explicit selected-source collection and immutable replay. No scheduler or TSP transport. */
import { toBarObservations, toFactorObservations, type KlineAdjustment, type KlineInterval, type SourceRequestOptions } from "../../source/index.ts";
import { archiveObservations, loadObservationArchive, type ObservationArchiveRef } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export type ObservationCollectionRequest =
  | { dataset: "bars"; symbol: string; interval: KlineInterval; adjustment: KlineAdjustment; startTime?: number; endTime?: number; count?: number }
  | { dataset: "adjustment_factor"; symbol: string; startTime?: number; endTime?: number };
export type ObservationCollectionReceipt = {
  source: string; endpoint: string; observedAt: string;
} & ({ status: "empty"; rowCount: 0; ref: null } | { status: "archived"; rowCount: number; ref: ObservationArchiveRef });

/** Performs one explicit selected-provider request and commits its response as one immutable batch. */
export async function collectObservations(request: ObservationCollectionRequest, options: SourceRequestOptions = {}): Promise<ObservationCollectionReceipt> {
  if (!request || (request.dataset !== "bars" && request.dataset !== "adjustment_factor")) throw new Error("Invalid observation collection request");
  const input = { ...request };
  options.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(options.signal);
  options.signal?.throwIfAborted();
  const response = input.dataset === "bars"
    ? await source.fetchKlines({ symbol: input.symbol, interval: input.interval, adjustment: input.adjustment,
        startTime: input.startTime, endTime: input.endTime, count: input.count }, options)
    : await source.fetchAdjustmentFactors({ symbols: [input.symbol], startTime: input.startTime, endTime: input.endTime }, options);
  options.signal?.throwIfAborted();
  const rows = input.dataset === "bars" ? toBarObservations(response as Awaited<ReturnType<typeof source.fetchKlines>>)
    : toFactorObservations(response as Awaited<ReturnType<typeof source.fetchAdjustmentFactors>>);
  const metadata = { source: response.source, endpoint: response.endpoint, observedAt: response.observedAt };
  if (!rows.length) return { ...metadata, status: "empty", rowCount: 0, ref: null };
  const ref = await archiveObservations(rows, options.signal);
  // Once storage has committed, return the reference even if cancellation arrives afterward.
  return { ...metadata, status: "archived", rowCount: rows.length, ref };
}

/** Read only the requested committed revision; no provider request or fallback. */
export const replayObservations = loadObservationArchive;

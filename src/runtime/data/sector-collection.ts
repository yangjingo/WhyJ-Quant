import type { MarketObservation, SourceRequestOptions } from "../../source/index.ts";
import { archiveSectorObservations, type StoredSectorObservationBatch } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export type SectorCollectionRequest = { tradeDate: string } & (
  | { kind: "dated-sector-catalog"; groupKind: "industry" | "concept" }
  | { kind: "dated-sector-members"; sectorCode: string }
);

function captureEvidence<T>(response: MarketObservation<T>, endpoint: StoredSectorObservationBatch["endpoint"]) {
  const { source, market, coverage, observedAt } = response;
  if (source !== "tushare" || response.endpoint !== endpoint || market !== "A") {
    throw new Error("Unexpected sector observation source or endpoint");
  }
  return { source, market, coverage, observedAt } as const;
}

/** Capture one scoped provider observation. The trade date does not establish historical availability. */
export async function collectSectorObservations(request: SectorCollectionRequest, options: SourceRequestOptions = {}) {
  if (typeof request?.tradeDate !== "string" ||
    (request.kind !== "dated-sector-catalog" && request.kind !== "dated-sector-members")) {
    throw new Error("Invalid sector collection request");
  }

  const captured = { ...request };
  const control = { ...options };
  control.signal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(control.signal);
  const { tradeDate } = captured;
  const scope = { market: "A", tradeDate } as const;
  let batch: StoredSectorObservationBatch;

  if (captured.kind === "dated-sector-catalog") {
    const response = await source.fetchDatedSectorCatalog({ ...scope, kind: captured.groupKind }, control);
    if (response.data.tradeDate !== tradeDate || response.data.kind !== captured.groupKind) {
      throw new Error("Sector catalog scope does not match the request");
    }
    batch = { ...response.data, ...captureEvidence(response, "dc_index"), endpoint: "dc_index" };
  } else {
    if (typeof captured.sectorCode !== "string") throw new Error("Invalid sector collection request");
    const sectorCode = captured.sectorCode.trim().toUpperCase();
    const response = await source.fetchDatedSectorMembers({ ...scope, sectorCode }, control);
    if (response.data.tradeDate !== tradeDate || response.data.sectorCode !== sectorCode) {
      throw new Error("Sector membership scope does not match the request");
    }
    batch = { ...response.data, ...captureEvidence(response, "dc_member"), endpoint: "dc_member" };
  }

  const ref = await archiveSectorObservations(batch, control.signal);
  const rowCount = batch.endpoint === "dc_index" ? batch.groups.length : batch.members.length;
  return {
    ref, status: rowCount ? "archived" as const : "empty" as const, rowCount,
    market: batch.market, source: batch.source, endpoint: batch.endpoint, tradeDate: batch.tradeDate,
    taxonomy: batch.taxonomy, observedAt: batch.observedAt, coverage: batch.coverage,
    scope: batch.endpoint === "dc_index" ? { groupKind: batch.kind } : { sectorCode: batch.sectorCode },
  };
}

export type TspExtensionSourceField = { name: string; dtype: "string" | "int" | "float" | "bool"; label: string };
export type TspExtensionCell = string | number | boolean | null;

export interface TspExtensionRowsRequest {
  datasetId: string;
  selection: { mode: "snapshot"; date?: never } | { mode: "timeseries"; date: string };
  columns: readonly string[];
  offset: number;
  limit: number;
}

export interface TspExtensionPage {
  source: "tsp";
  origin: string;
  endpoint: string;
  originalPublisher: "unknown";
  observedAt: string;
  sourceAsOf: null;
  request: TspExtensionRowsRequest;
  datasetLabel: string;
  partitionDate: string | null;
  snapshotSyncLocal: string | null;
  schemaRevision: string;
  revision: string;
  coverage: "complete" | "partial";
  totalRows: number;
  fields: TspExtensionSourceField[];
  rows: Record<string, TspExtensionCell>[];
  omittedFields: string[];
}

export interface TspExtensionPageArchiveRef {
  version: 1;
  kind: "tsp-extension-page";
  revision: string;
}

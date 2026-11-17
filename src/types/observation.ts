/** Storage representation of Source's version-1 bar and factor observations. */
export interface StoredObservationBase {
  schemaVersion: 1;
  kind: "daily_bar" | "minute_bar" | "adjustment_factor";
  symbol: string;
  timestamp: number;
  market: "unknown";
  assetType: "unknown";
  timezone: "UTC";
  sourceAsOf: "unknown";
  source: "tickflow" | "tushare" | "akshare" | "llmquant-data" | "financial-datasets";
  endpoint: string;
  observedAt: string;
  units: "unknown";
  finality: "unknown";
  coverage: "unknown";
  revision: "unknown";
  quality: "unknown";
}
export interface StoredBarObservation extends StoredObservationBase {
  kind: "daily_bar" | "minute_bar";
  interval: "1d" | "1m" | "5m" | "10m" | "15m" | "30m" | "60m";
  adjustment: "forward" | "none";
  values: { open: number; high: number; low: number; close: number; volume: number; amount: number | null };
}
export interface StoredFactorObservation extends StoredObservationBase {
  kind: "adjustment_factor";
  factorBasis: "unknown";
  values: { factor: number };
}
export type StoredObservation = StoredBarObservation | StoredFactorObservation;
export interface ObservationArchiveRef { version: 1; revision: string }

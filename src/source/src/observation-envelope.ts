import type { AdjustmentFactor, Kline, KlineAdjustment, KlineInterval, KlineResult, ObservationResult } from "./market-data.ts";
import type { ProviderSource } from "./source-contracts.ts";

/** A serialized record preserves Source's evidence; it does not certify completeness or freshness. */
export interface ObservationEnvelopeBase {
  schemaVersion: 1;
  symbol: string;
  timestamp: number;
  market: "unknown";
  assetType: "unknown";
  timezone: "UTC";
  sourceAsOf: "unknown";
  source: ProviderSource;
  endpoint: string;
  observedAt: string;
  units: "unknown";
  finality: "unknown";
  coverage: "unknown";
  revision: "unknown";
  quality: "unknown";
}
export interface BarObservation extends ObservationEnvelopeBase {
  kind: "daily_bar" | "minute_bar";
  interval: KlineInterval;
  adjustment: KlineAdjustment;
  values: Omit<Kline, "timestamp">;
}
export interface FactorObservation extends ObservationEnvelopeBase {
  kind: "adjustment_factor";
  factorBasis: "unknown";
  values: { factor: number };
}
export type BarOrFactorObservation = BarObservation | FactorObservation;

const invalid = () => new Error("Invalid Source observation result");
const intervals: readonly KlineInterval[] = ["1d", "1m", "5m", "10m", "15m", "30m", "60m"];
const sources: readonly ProviderSource[] = ["tickflow", "tushare", "akshare", "llmquant-data", "financial-datasets"];
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function instant(value: string): boolean {
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!parts) return false;
  const [, y, m, d, h, min, sec, , offsetHour, offsetMinute] = parts;
  const date = new Date(0); date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
    && Number(h) < 24 && Number(min) < 60 && Number(sec) < 60
    && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60)) && Number.isFinite(Date.parse(value));
}

function metadata(result: ObservationResult<unknown>): Omit<ObservationEnvelopeBase, "symbol" | "timestamp"> {
  if (!result || !sources.includes(result.source) || !text(result.endpoint) || !text(result.observedAt)
    || !instant(result.observedAt) || result.units !== "unknown") throw invalid();
  return { schemaVersion: 1, source: result.source, endpoint: result.endpoint, observedAt: result.observedAt,
    market: "unknown", assetType: "unknown", timezone: "UTC", sourceAsOf: "unknown",
    units: "unknown", finality: "unknown", coverage: "unknown", revision: "unknown", quality: "unknown" };
}

/** Convert one facade result without sorting, filling, applying factors or claiming complete coverage. */
export function toBarObservations(result: KlineResult): BarObservation[] {
  const base = metadata(result);
  if (!text(result.symbol) || !intervals.includes(result.interval) || !["forward", "none"].includes(result.adjustment) || !Array.isArray(result.data)) throw invalid();
  const seen = new Set<number>();
  return result.data.map(row => {
    if (!row || !time(row.timestamp) || seen.has(row.timestamp) || !amount(row.open) || !amount(row.high)
      || !amount(row.low) || !amount(row.close) || !amount(row.volume) || (row.amount !== null && !amount(row.amount))
      || row.high < Math.max(row.open, row.low, row.close) || row.low > Math.min(row.open, row.high, row.close)) throw invalid();
    seen.add(row.timestamp);
    return { ...base, kind: result.interval === "1d" ? "daily_bar" : "minute_bar", symbol: result.symbol,
      timestamp: row.timestamp, interval: result.interval, adjustment: result.adjustment,
      values: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, amount: row.amount } };
  });
}

/** Factor basis is unknown; downstream consumers must not infer how or whether to apply it. */
export function toFactorObservations(result: ObservationResult<Record<string, AdjustmentFactor[]>>): FactorObservation[] {
  const base = metadata(result);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw invalid();
  const output: FactorObservation[] = [];
  for (const [symbol, rows] of Object.entries(result.data)) {
    if (!text(symbol) || !Array.isArray(rows)) throw invalid();
    const seen = new Set<number>();
    for (const row of rows) {
      if (!row || !time(row.timestamp) || seen.has(row.timestamp) || !amount(row.factor) || row.factor === 0) throw invalid();
      seen.add(row.timestamp);
      output.push({ ...base, kind: "adjustment_factor", symbol, timestamp: row.timestamp, factorBasis: "unknown", values: { factor: row.factor } });
    }
  }
  return output;
}

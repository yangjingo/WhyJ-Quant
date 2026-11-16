import type { Bar, DatasetRef, PriceAdjustment } from "./data.ts";

export interface ThesisPriceCheckRequest {
  readonly symbol: string;
  readonly start: string;
  readonly end: string;
}

/** Data obtained through the configured fetch_bars path, not independent financial certification. */
export type ThesisPriceCheck = ThesisPriceCheckRequest & { readonly checkedAt: string } & (
  { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "available"; readonly source: string; readonly origin: "provider" | "cache" | "stale-cache";
      readonly dataset: DatasetRef; readonly bars: readonly Bar[] }
);

export interface ThesisPriceReference extends ThesisPriceCheckRequest {
  readonly adjustment: PriceAdjustment;
  readonly observedAt: string;
  readonly rows: readonly Pick<Bar, "date" | "open" | "high" | "low" | "close">[];
}

export interface ThesisPriceComparison {
  readonly outcome: "matching" | "different" | "incomparable" | "unavailable";
  readonly reason: string;
  readonly comparedDates: readonly string[];
  readonly differences: readonly { readonly date: string; readonly field: "open" | "high" | "low" | "close";
    readonly reference: number; readonly checked: number }[];
  readonly missingDates: readonly string[];
  readonly tolerance: 1e-8;
}

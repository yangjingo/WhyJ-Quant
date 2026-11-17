import { isDailyDate } from "../market/bars.ts";

/** Pinned TSP pipeline revision; inputs are caller-supplied, not provider observations. */
export const TSP_INDICATOR_REVISION = "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc";
export const TSP_INDICATOR_FORMULA_VERSION = 1;
export interface TspIndicatorBar { date: string; open: number; high: number; low: number; close: number; volume: number }
export interface TspIndicatorRow { date: string; rsi6: number; rsi14: number; rsi24: number; atr14: number }

/** Reproduce pinned TSP full-series EWM indicators; no calendar or price-basis inference. */
export function computeTspIndicators(bars: readonly TspIndicatorBar[]): TspIndicatorRow[] {
  if (!Array.isArray(bars)) throw new Error("Invalid TSP indicator bars");
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar || typeof bar.date !== "string" || !isDailyDate(bar.date) || (i > 0 && bar.date <= bars[i - 1]!.date)
      || ![bar.open, bar.high, bar.low, bar.close].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)
      || typeof bar.volume !== "number" || !Number.isFinite(bar.volume) || bar.volume < 0
      || bar.high < Math.max(bar.open, bar.low, bar.close) || bar.low > Math.min(bar.open, bar.high, bar.close)) {
      throw new Error("Invalid TSP indicator bars");
    }
  }
  const periods = [6, 14, 24] as const;
  const gain = [0, 0, 0], loss = [0, 0, 0];
  let atr = 0;
  return bars.map((bar, i) => {
    const previous = bars[i - 1];
    const delta = previous ? bar.close - previous.close : 0;
    const range = previous ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)) : bar.high - bar.low;
    atr = i === 0 ? range : range / 14 + atr * (13 / 14);
    const values = periods.map((period, j) => {
      const a = 1 / period;
      gain[j] = i === 0 ? 0 : a * Math.max(delta, 0) + (1 - a) * gain[j]!;
      loss[j] = i === 0 ? 0 : a * Math.max(-delta, 0) + (1 - a) * loss[j]!;
      return 100 - 100 / (1 + gain[j]! / (loss[j] === 0 ? 1e-12 : loss[j]!));
    });
    return { date: bar.date, rsi6: values[0]!, rsi14: values[1]!, rsi24: values[2]!, atr14: atr };
  });
}

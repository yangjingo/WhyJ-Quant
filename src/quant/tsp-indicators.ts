import { isDailyDate } from "../market/bars.ts";
import { mean, sampleDeviation } from "./statistics.ts";

/** Pinned TSP pipeline revision; inputs are caller-supplied, not provider observations. */
export const TSP_INDICATOR_REVISION = "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc";
export const TSP_INDICATOR_FORMULA_VERSION = 1;
export const TSP_DAILY_INDICATOR_FORMULA_VERSION = 1;
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

const dailyPeriods = [5, 10, 20, 30, 60] as const;
type DailyPeriod = typeof dailyPeriods[number];
type TspDailyIndicatorValues = Record<`ma${DailyPeriod}` | `ema${DailyPeriod}` | `momentum_${DailyPeriod}d`, number | null> & {
  prev_close: number | null;
  change_pct: number | null;
  change_amount: number | null;
  amplitude: number | null;
  macd_dif: number;
  macd_dea: number;
  macd_hist: number;
  boll_upper: number | null;
  boll_lower: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
  atr_14: number;
  vol_ma5: number | null;
  vol_ma10: number | null;
  vol_ratio_5d: number | null;
  high_60d: number | null;
  low_60d: number | null;
  annual_vol_20d: number | null;
  rsi_6: number;
  rsi_14: number;
  rsi_24: number;
};
export type TspDailyIndicatorRow = { date: string } & TspDailyIndicatorValues;

function ema(value: number, previous: number | undefined, alpha: number): number {
  return previous === undefined ? value : (1 - alpha) * previous + alpha * value;
}

function trailingMean(values: number[], period: number): number | null {
  return values.length < period ? null : mean(values.slice(-period));
}

/** Calculate the pinned TSP OHLCV fields for completed daily observations only. */
export function computeTspDailyIndicators(bars: readonly TspIndicatorBar[]): TspDailyIndicatorRow[] {
  const oscillatorRows = computeTspIndicators(bars);
  const closes: number[] = [], volumes: number[] = [], returns: number[] = [];
  const emaByPeriod: Partial<Record<DailyPeriod, number>> = {};
  let ema12: number | undefined, ema26: number | undefined, dea: number | undefined;
  let k: number | undefined, d: number | undefined;

  return bars.map((bar, i) => {
    const previous = bars[i - 1];
    const change = previous ? bar.close / previous.close - 1 : null;
    if (change !== null) returns.push(change);
    const precedingVolume = trailingMean(volumes, 5);
    closes.push(bar.close);
    volumes.push(bar.volume);

    for (const period of dailyPeriods) {
      emaByPeriod[period] = ema(bar.close, emaByPeriod[period], 2 / (period + 1));
    }
    ema12 = ema(bar.close, ema12, 2 / 13);
    ema26 = ema(bar.close, ema26, 2 / 27);
    const dif = ema12 - ema26;
    dea = ema(dif, dea, 2 / 10);

    const ma20 = trailingMean(closes, 20);
    const bollSpread = ma20 === null ? 0 : 2 * sampleDeviation(closes.slice(-20));
    const extremes = i >= 59 ? closes.slice(-60) : null;
    const kdjWindow = i >= 8 ? bars.slice(i - 8, i + 1) : [];
    const low = Math.min(...kdjWindow.map(row => row.low));
    const high = Math.max(...kdjWindow.map(row => row.high));
    const hasRange = high > low;
    if (hasRange) {
      const rsv = 100 * (bar.close - low) / (high - low);
      k = ema(rsv, k, 1 / 3);
      d = ema(k, d, 1 / 3);
    }
    const { rsi6, rsi14, rsi24, atr14 } = oscillatorRows[i]!;
    const momentum = (period: DailyPeriod) => i < period ? null : bar.close / closes[i - period]! - 1;
    const values: TspDailyIndicatorValues = {
      prev_close: previous?.close ?? null, change_pct: change,
      change_amount: previous ? bar.close - previous.close : null,
      amplitude: previous ? (bar.high - bar.low) / previous.close : null,
      ma5: trailingMean(closes, 5), ma10: trailingMean(closes, 10), ma20,
      ma30: trailingMean(closes, 30), ma60: trailingMean(closes, 60),
      ema5: emaByPeriod[5]!, ema10: emaByPeriod[10]!, ema20: emaByPeriod[20]!,
      ema30: emaByPeriod[30]!, ema60: emaByPeriod[60]!,
      macd_dif: dif, macd_dea: dea, macd_hist: 2 * (dif - dea),
      boll_upper: ma20 === null ? null : ma20 + bollSpread,
      boll_lower: ma20 === null ? null : ma20 - bollSpread,
      kdj_k: hasRange ? k! : null, kdj_d: hasRange ? d! : null,
      kdj_j: hasRange ? 3 * k! - 2 * d! : null, atr_14: atr14,
      vol_ma5: trailingMean(volumes, 5), vol_ma10: trailingMean(volumes, 10),
      vol_ratio_5d: precedingVolume !== null && precedingVolume > 0 ? bar.volume / precedingVolume : null,
      high_60d: extremes ? Math.max(...extremes) : null, low_60d: extremes ? Math.min(...extremes) : null,
      momentum_5d: momentum(5), momentum_10d: momentum(10), momentum_20d: momentum(20),
      momentum_30d: momentum(30), momentum_60d: momentum(60),
      annual_vol_20d: returns.length < 20 ? null : sampleDeviation(returns.slice(-20)) * Math.sqrt(252),
      rsi_6: rsi6, rsi_14: rsi14, rsi_24: rsi24,
    };
    if (Object.values(values).some(value => value !== null && !Number.isFinite(value))) {
      throw new Error("TSP indicator exceeds supported numeric range");
    }
    return { date: bar.date, ...values };
  });
}

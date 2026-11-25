import { isDailyDate } from "../market/bars.ts";

export const TSP_INTRADAY_FORMULA_VERSION = 1;

export interface TspCompletedMinuteBar {
  tradingDate: string;
  /** Shanghai wall-clock label at the start of the completed minute. */
  minute: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volumeShares: number | null;
  amountCny: number | null;
}

export interface TspIntradayValues {
  price: number;
  vwap: number | null;
  pct_vs_prev_close: number | null;
  pct_from_open: number | null;
  vol_ratio_1m_today: number | null;
  vol_ratio_3m_today: number | null;
  vol_ratio_5m_today: number | null;
  day_high_dist: number | null;
  day_low_dist: number | null;
  open_30m_high_dist: number | null;
  open_30m_low_dist: number | null;
}

export interface TspIntradaySignals {
  signal_intraday_avg_cross_up: boolean | null;
  signal_intraday_avg_cross_down: boolean | null;
  signal_intraday_zero_cross_up: boolean | null;
  signal_intraday_zero_cross_down: boolean | null;
}

export interface TspIntradayRow {
  tradingDate: string;
  minute: string;
  values: TspIntradayValues;
  signals: TspIntradaySignals;
}

const afternoonIndex = 120;
const openingRangeLength = 30;
const volumeLookback = 10;

export function tspMinuteIndex(minute: string): number {
  if (!/^\d{2}:[0-5]\d$/.test(minute)) return -1;
  const wallMinute = Number(minute.slice(0, 2)) * 60 + Number(minute.slice(3));
  if (wallMinute >= 570 && wallMinute < 690) return wallMinute - 570;
  if (wallMinute >= 780 && wallMinute < 900) return afternoonIndex + wallMinute - 780;
  return -1;
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function isTspMinuteBar(bar: TspCompletedMinuteBar): boolean {
  return isDailyDate(bar.tradingDate) && positive(bar.close)
    && [bar.open, bar.high, bar.low].every(value => value === null || positive(value))
    && [bar.volumeShares, bar.amountCny].every(value => value === null || (Number.isFinite(value) && value >= 0))
    && (bar.high === null || bar.high >= Math.max(bar.close, bar.open ?? 0, bar.low ?? 0))
    && (bar.low === null || bar.low <= Math.min(bar.close, bar.open ?? bar.close));
}

function ratio(numerator: number | null, denominator: number | null, offset = 0): number | null {
  if (numerator === null || !positive(denominator)) return null;
  const value = numerator / denominator - offset;
  return Number.isFinite(value) ? value : null;
}

function volumeRatio(volumes: readonly number[], window: number): number | null {
  if (volumes.length < 2 * window) return null;
  const sum = (values: number[]) => values.reduce((total, volume) => total + volume, 0);
  return ratio(sum(volumes.slice(-window)), sum(volumes.slice(-2 * window, -window)));
}

function accumulate(total: number | null, value: number | null): number | null {
  return total === null || value === null ? null : total + value;
}

function extreme(previous: number | null, value: number | null, compare: typeof Math.max): number | null {
  return previous === null || value === null ? null : compare(previous, value);
}

function crosses(previous: number | null, current: number | null): [boolean | null, boolean | null] {
  if (previous === null || current === null) return [null, null];
  return [previous <= 0 && current > 0, previous >= 0 && current < 0];
}

/** Evaluate one symbol on a consistent price basis using only the completed input prefix. */
export function computeTspIntraday(
  bars: readonly TspCompletedMinuteBar[],
  previousCloseByTradingDate: Readonly<Record<string, number>> = {},
): TspIntradayRow[] {
  for (const [date, close] of Object.entries(previousCloseByTradingDate)) {
    if (!isDailyDate(date) || !positive(close)) throw new Error("Invalid intraday previous close");
  }
  let previous: TspIntradayRow | undefined;
  let previousIndex = -1;
  let open: number | null = null, high: number | null = null, low: number | null = null;
  let openingHigh: number | null = null, openingLow: number | null = null;
  let volume: number | null = null, amount: number | null = null;
  let volumes: number[] = [];

  return bars.map(bar => {
    const { tradingDate, minute, close, volumeShares, amountCny } = bar;
    const index = tspMinuteIndex(minute);
    const newDate = tradingDate !== previous?.tradingDate;
    if (index < 0 || !isTspMinuteBar(bar) || (previous && (tradingDate < previous.tradingDate || (!newDate && index <= previousIndex)))) {
      throw new Error("Invalid or unordered completed A-share minute bars");
    }

    // Consecutive indexes bridge lunch for daily accumulation and crossings only.
    const adjacent = !newDate && index === previousIndex + 1;
    if (newDate) {
      const fromOpen = index === 0;
      open = fromOpen ? bar.open : null;
      high = fromOpen ? bar.high : null;
      low = fromOpen ? bar.low : null;
      volume = fromOpen ? volumeShares : null;
      amount = fromOpen ? amountCny : null;
      openingHigh = openingLow = null;
    } else {
      high = adjacent ? extreme(high, bar.high, Math.max) : null;
      low = adjacent ? extreme(low, bar.low, Math.min) : null;
      volume = adjacent ? accumulate(volume, volumeShares) : null;
      amount = adjacent ? accumulate(amount, amountCny) : null;
    }
    if (index === openingRangeLength - 1) {
      openingHigh = high;
      openingLow = low;
    }
    if (!adjacent || index === afternoonIndex || volumeShares === null) volumes = [];
    if (volumeShares !== null) {
      volumes.push(volumeShares);
      if (volumes.length > volumeLookback) volumes.shift();
    }

    const vwap = ratio(amount, volume);
    const fromPreviousClose = ratio(close, previousCloseByTradingDate[tradingDate] ?? null, 1);
    const values: TspIntradayValues = {
      price: close,
      vwap,
      pct_vs_prev_close: fromPreviousClose,
      pct_from_open: ratio(close, open, 1),
      vol_ratio_1m_today: volumeRatio(volumes, 1),
      vol_ratio_3m_today: volumeRatio(volumes, 3),
      vol_ratio_5m_today: volumeRatio(volumes, 5),
      day_high_dist: ratio(close, high, 1),
      day_low_dist: ratio(close, low, 1),
      open_30m_high_dist: ratio(close, openingHigh, 1),
      open_30m_low_dist: ratio(close, openingLow, 1),
    };
    const before = adjacent ? previous?.values : undefined;
    const previousVwapDelta = before && before.vwap !== null ? before.price - before.vwap : null;
    const [averageUp, averageDown] = crosses(previousVwapDelta, vwap === null ? null : close - vwap);
    const [zeroUp, zeroDown] = crosses(before?.pct_vs_prev_close ?? null, fromPreviousClose);
    const row: TspIntradayRow = {
      tradingDate,
      minute,
      values,
      signals: {
        signal_intraday_avg_cross_up: averageUp,
        signal_intraday_avg_cross_down: averageDown,
        signal_intraday_zero_cross_up: zeroUp,
        signal_intraday_zero_cross_down: zeroDown,
      },
    };
    previous = row;
    previousIndex = index;
    return row;
  });
}

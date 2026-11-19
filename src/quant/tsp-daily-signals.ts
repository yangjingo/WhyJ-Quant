import { computeTspDailyIndicators, type TspDailyIndicatorRow, type TspIndicatorBar } from "./tsp-indicators.ts";

export const TSP_DAILY_SIGNAL_FORMULA_VERSION = 1;

/** Exchange flags use separately supplied raw prices and effective limit thresholds for the same date. */
export interface TspDailySignalBar extends TspIndicatorBar {
  raw_close?: number | null;
  raw_high?: number | null;
  raw_low?: number | null;
  limit_up_price?: number | null;
  limit_down_price?: number | null;
}

/** Convert effective exchange prices to the pinned TSP comparison operands. */
export function tspTradingLimitThresholds(limitUp: number | null, limitDown: number | null) {
  const halfTickCny = 0.005;
  const up = limitUp !== null && limitUp > halfTickCny ? limitUp - halfTickCny : null;
  const down = limitDown !== null ? limitDown + halfTickCny : null;
  if (up !== null && down !== null && up < down) return { limit_up_price: null, limit_down_price: null };
  return { limit_up_price: up, limit_down_price: down };
}

type Field = Exclude<keyof TspDailySignalBar | keyof TspDailyIndicatorRow, "date">;
type Comparison = readonly [Field, ">" | "<" | ">=" | "<=", Field | number, (0 | 1)?];

function cross(left: Field, right: Field, direction: "up" | "down"): readonly Comparison[] {
  return direction === "up" ? [[left, ">", right], [left, "<=", right, 1]]
    : [[left, "<", right], [left, ">=", right, 1]];
}

const rules = {
  signal_boll_breakdown_lower: [["close", "<", "boll_lower"]],
  signal_boll_breakout_upper: [["close", ">", "boll_upper"]],
  signal_broken_limit_up: [["raw_high", ">", 0], ["raw_close", "<", "limit_up_price"], ["raw_high", ">=", "limit_up_price"]],
  signal_limit_down: [["raw_close", ">", 0], ["raw_close", "<=", "limit_down_price"]],
  signal_limit_down_recovery: [["raw_low", ">", 0], ["raw_close", ">", "limit_down_price"], ["raw_low", "<=", "limit_down_price"], ["close", ">", "open"]],
  signal_limit_up: [["raw_close", ">", 0], ["raw_close", ">=", "limit_up_price"]],
  signal_ma10_breakdown: cross("close", "ma10", "down"),
  signal_ma10_breakout: cross("close", "ma10", "up"),
  signal_ma20_breakdown: cross("close", "ma20", "down"),
  signal_ma20_breakout: cross("close", "ma20", "up"),
  signal_ma5_breakdown: cross("close", "ma5", "down"),
  signal_ma5_breakout: cross("close", "ma5", "up"),
  signal_ma_dead_5_20: cross("ma5", "ma20", "down"),
  signal_ma_golden_20_60: cross("ma20", "ma60", "up"),
  signal_ma_golden_5_20: cross("ma5", "ma20", "up"),
  signal_macd_dead: cross("macd_dif", "macd_dea", "down"),
  signal_macd_golden: cross("macd_dif", "macd_dea", "up"),
  signal_n_day_high: [["close", ">=", "high_60d"]],
  signal_n_day_low: [["close", "<=", "low_60d"]],
  signal_volume_surge: [["vol_ratio_5d", ">=", 2]],
} satisfies Record<string, readonly Comparison[]>;

export type TspDailySignalId = keyof typeof rules;
export const TSP_DAILY_SIGNAL_FIELDS: readonly TspDailySignalId[] = Object.keys(rules) as TspDailySignalId[];

export interface TspDailySignalRow { date: string; values: Record<TspDailySignalId, boolean | null> }

function evaluate(series: readonly (TspDailySignalBar & TspDailyIndicatorRow)[], index: number, checks: readonly Comparison[]): boolean | null {
  let matched = true;
  for (const [left, op, right, offset = 0] of checks) {
    const row = series[index - offset];
    const a = row?.[left];
    const b = typeof right === "number" ? right : row?.[right];
    if (a == null || b == null) return null;
    switch (op) {
      case ">": matched &&= a > b; break;
      case "<": matched &&= a < b; break;
      case ">=": matched &&= a >= b; break;
      case "<=": matched &&= a <= b; break;
    }
  }
  return matched;
}

/** Compute the shared indicator series and evaluate the pinned daily seeds against it. */
export function computeTspDailyIndicatorsAndSignals(bars: readonly TspDailySignalBar[]) {
  const indicators = computeTspDailyIndicators(bars);
  const series = indicators.map((indicator, i) => {
    const bar = bars[i]!;
    const { raw_close, raw_high, raw_low, limit_up_price, limit_down_price } = bar;
    if ([raw_close, raw_high, raw_low].some(value => value != null && (!Number.isFinite(value) || value < 0)) ||
        [limit_up_price, limit_down_price].some(value => value != null && (!Number.isFinite(value) || value <= 0)) ||
        (raw_high != null && raw_low != null && raw_low > raw_high) ||
        (raw_close != null && raw_high != null && raw_close > raw_high) ||
        (raw_close != null && raw_low != null && raw_close < raw_low) ||
        (limit_up_price != null && limit_down_price != null && limit_down_price > limit_up_price)) {
      throw new Error("Invalid TSP daily signal price observations");
    }
    return { ...bar, ...indicator };
  });
  const signals: TspDailySignalRow[] = series.map(({ date }, index) => ({ date, values: Object.fromEntries(TSP_DAILY_SIGNAL_FIELDS.map(id => [
    id, evaluate(series, index, rules[id]),
  ])) as TspDailySignalRow["values"] }));
  return { indicators, signals };
}

/** Evaluate the pinned daily seeds from one ordered series, with unknown dependencies preserved. */
export function computeTspDailySignals(bars: readonly TspDailySignalBar[]): TspDailySignalRow[] {
  return computeTspDailyIndicatorsAndSignals(bars).signals;
}

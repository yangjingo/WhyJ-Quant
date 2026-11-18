import { isDailyDate } from "../market/bars.ts";
import { mean, rootMeanSquare, sampleDeviation } from "./statistics.ts";
import { computeTspDailyIndicators, type TspIndicatorBar } from "./tsp-indicators.ts";

export const TSP_RESEARCH_FACTOR_FORMULA_VERSION = 1;

export interface TspResearchFactorBar extends TspIndicatorBar {
  /** Verified CNY amount for the trading day. */
  amountCny?: number | null;
  /** Daily turnover in percentage points, with the historical float-share basis already applied. */
  turnoverPct?: number | null;
  /** Zero indicates a known non-limit-up day. Missing history stays unknown. */
  consecutiveLimitUps?: number | null;
}

export interface TspResearchFinancialReport {
  announcementDate: string;
  bps: number | null;
  roe: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  revenueYoy: number | null;
  netIncomeYoy: number | null;
  debtRatio: number | null;
}

export interface TspResearchFactorInputs {
  volumeUnit?: "share" | "hand";
  /** One symbol's snapshots, strictly increasing by announcement date. */
  financialReports?: readonly TspResearchFinancialReport[];
}

type Value = number | null;

function ratio(numerator: Value | undefined, denominator: Value | undefined): Value {
  if (numerator == null || denominator == null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

function relative(numerator: Value | undefined, denominator: Value | undefined): Value {
  const value = ratio(numerator, denominator);
  return value === null ? null : value - 1;
}

function difference(left: Value, right: Value): Value {
  return left === null || right === null ? null : left - right;
}

/** Complete trailing window ending just before end. */
function window(values: readonly Value[], end: number, size: number): number[] | null {
  if (end < size) return null;
  const sample = values.slice(end - size, end);
  return sample.every(value => value !== null) ? sample : null;
}

function rolling(values: readonly Value[], end: number, size: number, compute: (sample: number[]) => Value): Value {
  const sample = window(values, end, size);
  return sample ? compute(sample) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function skew(values: number[]): Value {
  const average = mean(values);
  const centered = values.map(value => value - average);
  const scale = rootMeanSquare(centered);
  return scale > 0 ? mean(centered.map(value => (value / scale) ** 3)) : null;
}

function correlation(left: number[], right: number[]): Value {
  const x = mean(left);
  const y = mean(right);
  const centeredLeft = left.map(value => value - x);
  const centeredRight = right.map(value => value - y);
  return ratio(mean(centeredLeft.map((value, index) => value * centeredRight[index]!)),
    rootMeanSquare(centeredLeft) * rootMeanSquare(centeredRight));
}

/** Pinned TSP daily research factor definitions for one symbol, with explicit supplemental inputs. */
export function computeTspResearchFactors(bars: readonly TspResearchFactorBar[], inputs: TspResearchFactorInputs = {}) {
  const daily = computeTspDailyIndicators(bars);
  const reports = inputs.financialReports ?? [];
  for (let i = 0; i < reports.length; i++) {
    const report = reports[i]!;
    const { announcementDate, ...values } = report;
    if (!isDailyDate(announcementDate) || (i > 0 && reports[i - 1]!.announcementDate >= announcementDate) ||
        Object.values(values).some(value => value !== null && !Number.isFinite(value))) {
      throw new Error("Invalid TSP financial announcement history");
    }
  }

  for (const { amountCny, turnoverPct, consecutiveLimitUps } of bars) {
    if ([amountCny, turnoverPct].some(value => value != null && (!Number.isFinite(value) || value < 0)) ||
        (consecutiveLimitUps != null && (!Number.isSafeInteger(consecutiveLimitUps) || consecutiveLimitUps < 0))) {
      throw new Error("Invalid TSP research factor observations");
    }
  }

  const close = bars.map(bar => bar.close);
  const volume = bars.map(bar => bar.volume);
  const amount = bars.map(bar => bar.amountCny ?? null);
  const turnover = bars.map(bar => bar.turnoverPct ?? null);
  const limits = bars.map(bar => bar.consecutiveLimitUps == null ? null : Number(bar.consecutiveLimitUps > 0));
  const returns = daily.map(row => row.change_pct);
  const amplitudes = daily.map(row => row.amplitude);
  const overnight = bars.map((bar, index) => relative(bar.open, daily[index]!.prev_close));
  const intraday = bars.map(bar => relative(bar.close, bar.open));
  const illiquidity = returns.map((value, index) => value === null || amount[index] == null
    ? null : ratio(Math.abs(value), amount[index]! / 1e8));
  const unitShares = inputs.volumeUnit === "hand" ? 100 : inputs.volumeUnit === "share" ? 1 : null;
  let reportIndex = 0;

  return daily.map((row, i) => {
    const bar = bars[i]!;
    while (reports[reportIndex] && reports[reportIndex]!.announcementDate < row.date) reportIndex++;
    const financial = reports[reportIndex - 1];
    const end = i + 1;
    const return20 = window(returns, end, 20);
    const amountToday = amount[i]!;
    const turnoverToday = turnover[i]!;
    const turnoverBefore60 = window(turnover, i, 60);
    const turnover20 = window(turnover, end, 20);
    const bollRange = difference(row.boll_upper, row.boll_lower);
    const high240 = rolling(close, end, 240, values => Math.max(...values));
    const low240 = rolling(close, end, 240, values => Math.min(...values));
    const vwap = unitShares === null ? null : ratio(amountToday, bar.volume * unitShares);
    const turnoverZ = turnoverToday === null || turnoverBefore60 === null ? null
      : ratio(turnoverToday - mean(turnoverBefore60), sampleDeviation(turnoverBefore60));
    const values = {
      momentum_5d: row.momentum_5d, momentum_10d: row.momentum_10d, momentum_20d: row.momentum_20d,
      momentum_30d: row.momentum_30d, momentum_60d: row.momentum_60d, change_pct: row.change_pct,
      ma5_bias: relative(bar.close, row.ma5), ma10_bias: relative(bar.close, row.ma10),
      ma20_bias: relative(bar.close, row.ma20), ma30_bias: relative(bar.close, row.ma30), ma60_bias: relative(bar.close, row.ma60),
      ema5_bias: relative(bar.close, row.ema5), ema10_bias: relative(bar.close, row.ema10),
      ema20_bias: relative(bar.close, row.ema20), ema30_bias: relative(bar.close, row.ema30), ema60_bias: relative(bar.close, row.ema60),
      rsi_6: row.rsi_6, rsi_14: row.rsi_14, rsi_24: row.rsi_24,
      macd_hist: row.macd_hist, macd_dif_pct: ratio(row.macd_dif, bar.close),
      macd_dea_pct: ratio(row.macd_dea, bar.close), macd_hist_pct: ratio(row.macd_hist, bar.close),
      kdj_k: row.kdj_k, kdj_d: row.kdj_d, kdj_j: row.kdj_j,
      boll_position: ratio(difference(bar.close, row.boll_lower), bollRange),
      annual_vol_20d: row.annual_vol_20d, atr_14: row.atr_14, atr_pct: ratio(row.atr_14, bar.close),
      amplitude: row.amplitude, boll_width: ratio(bollRange, row.ma20),
      vol_ratio_5d: row.vol_ratio_5d, vol_ratio_10d: ratio(bar.volume, rolling(volume, i, 10, mean)),
      vol_trend_5_10: relative(row.vol_ma5, row.vol_ma10),
      turnover_rate: turnoverToday, turnover_ratio_5d: relative(turnoverToday, rolling(turnover, i, 5, mean)),
      log_amount: amountToday === null ? null : Math.log1p(amountToday),
      amount_ratio_5d: relative(amountToday, rolling(amount, i, 5, mean)),
      gap_return: overnight[i]!, intraday_return: intraday[i]!, close_position: ratio(bar.close - bar.low, bar.high - bar.low),
      distance_to_high_60d: relative(bar.close, row.high_60d), distance_from_low_60d: relative(bar.close, row.low_60d),
      vwap_bias: relative(bar.close, vwap),
      max_ret_20d: return20 ? Math.max(...return20) : null,
      ret_skew_20d: return20 ? skew(return20) : null,
      up_days_20d: return20 ? return20.filter(value => value > 0).length : null,
      amihud_20d: rolling(illiquidity, end, 20, mean), turnover_z_60d: turnoverZ,
      vol_price_corr_20d: return20 ? correlation(return20, volume.slice(end - 20, end)) : null,
      vol_trend_5_60: relative(row.vol_ma5, rolling(volume, end, 60, mean)),
      limit_up_count_20d: rolling(limits, end, 20, sum), limit_up_count_60d: rolling(limits, end, 60, sum),
      pb_latest: financial?.bps != null && financial.bps > 0 ? ratio(bar.close, financial.bps) : null,
      roe_latest: financial?.roe ?? null, gross_margin_latest: financial?.grossMargin ?? null,
      net_margin_latest: financial?.netMargin ?? null, revenue_yoy_latest: financial?.revenueYoy ?? null,
      net_income_yoy_latest: financial?.netIncomeYoy ?? null, debt_ratio_latest: financial?.debtRatio ?? null,
      log_float_mv: unitShares !== null && turnoverToday !== null && turnoverToday > 0 && bar.volume > 0
        ? Math.log(bar.close) + Math.log(bar.volume) + Math.log(unitShares / 100) - Math.log(turnoverToday) : null,
      momentum_120d: relative(bar.close, close[i - 120]),
      mom_accel_20_60: difference(row.momentum_20d, row.momentum_60d),
      rsi_14_delta_5d: difference(row.rsi_14, daily[i - 5]?.rsi_14 ?? null),
      overnight_ret_20d: rolling(overnight, end, 20, sum), intraday_ret_20d: rolling(intraday, end, 20, sum),
      downside_vol_20d: return20 ? rootMeanSquare(return20.map(value => Math.min(0, value))) : null,
      vol_regime_5_60: ratio(rolling(returns, end, 5, sampleDeviation), rolling(returns, end, 60, sampleDeviation)),
      amplitude_trend_20_60: relative(rolling(amplitudes, end, 20, mean), rolling(amplitudes, end, 60, mean)),
      obv_trend_20d: return20 ? ratio(sum(return20.map((change, index) => Math.sign(change) * volume[end - 20 + index]!)),
        sum(volume.slice(end - 20, end))) : null,
      amount_mean_20d: ratio(rolling(amount, end, 20, mean), 1e8),
      turnover_mean_20d: turnover20 ? mean(turnover20) : null,
      turnover_std_20d: turnover20 ? ratio(sampleDeviation(turnover20), mean(turnover20)) : null,
      position_240d: ratio(difference(bar.close, low240), difference(high240, low240)),
      distance_to_high_240d: relative(bar.close, high240), kdj_kd_diff: difference(row.kdj_k, row.kdj_d),
    };
    return { date: row.date, values };
  });
}

export type TspResearchFactorId = keyof ReturnType<typeof computeTspResearchFactors>[number]["values"];

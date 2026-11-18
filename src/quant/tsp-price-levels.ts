import { mean } from "./statistics.ts";
import { computeTspDailyIndicators, type TspIndicatorBar } from "./tsp-indicators.ts";

export const TSP_PRICE_LEVEL_FORMULA_VERSION = 1;
export interface TspPriceLevelBar extends TspIndicatorBar {
  /** Historical turnover in percentage points, when available. */
  turnoverPct?: number | null;
}

function emptyLevels() {
  return { sr: [], pivot: [], extreme: [], boll: [], keltner_s: [], keltner_m: [], keltner_l: [],
    atr_stop: [], gap: [], fib: [], round: [] };
}

type Group = keyof ReturnType<typeof emptyLevels>;
type Side = "resistance" | "support" | "neutral";
type Strength = "strong" | "medium" | "weak";
export interface TspPriceLevel {
  value: number;
  label: string;
  type: Group;
  side: Side;
  strength: Strength;
  rank?: number;
}

function side(price: number, close: number): Side {
  if (price > close * 1.001) return "resistance";
  if (price < close * 0.999) return "support";
  return "neutral";
}

function roundedPrice(price: number): number {
  if (!Number.isFinite(price)) throw new Error("Invalid TSP price level");
  // Exact binary halfway prices are odd multiples of 1/8. TSP rounds ties to even.
  if (Number.isSafeInteger(price * 8) && Math.abs(price * 8) % 2 === 1) {
    const cents = Math.floor(price * 100);
    return (cents % 2 === 0 ? cents : cents + 1) / 100;
  }
  return Number(price.toFixed(2));
}

function point(type: Group, value: number, label: string, direction: Side, strength: Strength): TspPriceLevel {
  return { type, value: roundedPrice(value), label, side: direction, strength };
}

function cluster(values: number[], tolerance: number): number[] {
  const result: number[] = [];
  for (const value of values.sort((a, b) => a - b)) {
    const previous = result.at(-1);
    if (previous !== undefined && (value - previous) / previous <= tolerance) result[result.length - 1] = value;
    else result.push(value);
  }
  return result;
}

function profile(bars: readonly TspPriceLevelBar[], close: number): TspPriceLevel[] {
  if (bars.length < 20) return [];
  const high = bars.reduce((price, bar) => Math.max(price, bar.high), 0);
  const low = bars.reduce((price, bar) => Math.min(price, bar.low), Infinity);
  const width = (high - low) / 40;
  if (width <= 0) return [];
  const bins = new Array<number>(40).fill(0);
  const bin = (price: number) => Math.min(39, Math.floor((price - low) / width));
  for (const bar of bars) {
    const decay = 1 - Math.min(bar.turnoverPct ?? 0, 100) / 100;
    const first = bin(bar.low), last = bin(bar.high);
    const contribution = bar.volume / (last - first + 1);
    for (let i = 0; i < bins.length; i++) {
      bins[i] = bins[i]! * decay + (i >= first && i <= last ? contribution : 0);
    }
  }
  const ranked = bins.map((volume, index) => ({ volume, index })).filter(row => row.volume > 0)
    .sort((a, b) => b.volume - a.volume);
  if (ranked.length === 0) return [];
  const average = mean(ranked.map(row => row.volume));
  const selected = [ranked[0]!, ...ranked.slice(1).filter(row => row.volume > average).slice(0, 2)];
  return selected.map(({ index }, i) => {
    const price = ((low + index * width) + (low + (index + 1) * width)) / 2;
    return point("sr", price, i === 0 ? "成交密集区(POC)" : "成交密集区", side(price, close), i === 0 ? "strong" : "medium");
  });
}

function pivots(bar: TspIndicatorBar): TspPriceLevel[] {
  const { high, low, close } = bar;
  const pivot = (high + low + close) / 3;
  const range = high - low;
  const entries: [number, string, Side, Strength, number][] = [
    [pivot, "枢轴位 P", "neutral", "strong", 0],
    [2 * pivot - low, "压力位 R1", "resistance", "medium", 1],
    [pivot + range, "压力位 R2", "resistance", "medium", 2],
    [high + 2 * (pivot - low), "压力位 R3", "resistance", "weak", 3],
    [2 * pivot - high, "支撑位 S1", "support", "medium", 1],
    [pivot - range, "支撑位 S2", "support", "medium", 2],
    [low - 2 * (high - pivot), "支撑位 S3", "support", "weak", 3],
  ];
  return entries.map(([value, label, direction, strength, rank]) => ({ ...point("pivot", value, label, direction, strength), rank }));
}

function extremes(bars: readonly TspIndicatorBar[], close: number): TspPriceLevel[] {
  const result: TspPriceLevel[] = [];
  for (const count of [60, 250]) {
    if (bars.length < count) continue;
    const recent = bars.slice(-count);
    result.push(point("extreme", Math.max(...recent.map(bar => bar.high)), `${count}日新高`, "resistance", "strong"));
    result.push(point("extreme", Math.min(...recent.map(bar => bar.low)), `${count}日新低`, "support", "strong"));
  }
  const swingHighs: number[] = [], swingLows: number[] = [];
  for (let i = 5; i < bars.length - 5; i++) {
    const bar = bars[i]!;
    const near = bars.slice(i - 5, i + 6);
    if (near.every(neighbor => neighbor.high <= bar.high)) swingHighs.push(bar.high);
    if (near.every(neighbor => neighbor.low >= bar.low)) swingLows.push(bar.low);
  }
  for (const high of cluster(swingHighs, 0.01).filter(value => value > close * 1.001).slice(0, 2)) {
    result.push(point("extreme", high, "前高", "resistance", "medium"));
  }
  for (const low of cluster(swingLows, 0.01).filter(value => value < close * 0.999).slice(-2).reverse()) {
    result.push(point("extreme", low, "前低", "support", "medium"));
  }
  return result;
}

function gaps(bars: readonly TspIndicatorBar[], close: number): TspPriceLevel[] {
  if (bars.length < 5) return [];
  const recent = bars.slice(-120);
  const up: number[] = [], down: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const previous = recent[i - 1]!, current = recent[i]!;
    const upward = current.low > previous.high;
    const downward = current.high < previous.low;
    if (!upward && !downward) continue;
    const lower = upward ? previous.high : current.high;
    const upper = upward ? current.low : previous.low;
    if (!recent.slice(i + 1).some(bar => bar.low <= upper && bar.high >= lower)) {
      (upward ? up : down).push((lower + upper) / 2);
    }
  }
  const nearest = (levels: number[], label: string) => cluster(levels, 0.005)
    .sort((a, b) => Math.abs(a - close) - Math.abs(b - close)).slice(0, 3)
    .map(value => point("gap", value, label, side(value, close), "medium"));
  return [...nearest(up, "向上缺口"), ...nearest(down, "向下缺口")];
}

function fibonacci(bars: readonly TspIndicatorBar[], close: number): TspPriceLevel[] {
  if (bars.length < 10) return [];
  const recent = bars.slice(-120);
  const highs = recent.map(bar => bar.high), lows = recent.map(bar => bar.low);
  const high = Math.max(...highs), low = Math.min(...lows);
  if (high <= low) return [];
  const upward = highs.indexOf(high) > lows.indexOf(low);
  return [0.236, 0.382, 0.5, 0.618, 0.786].map(ratio => {
    const value = upward ? high - (high - low) * ratio : low + (high - low) * ratio;
    return point("fib", value, `Fib ${(ratio * 100).toFixed(1)}%`, side(value, close), "medium");
  });
}

const roundSteps = [[10, 0.5], [20, 1], [100, 5], [500, 10]] as const;

function roundLevels(close: number): TspPriceLevel[] {
  const step = roundSteps.find(([threshold]) => close < threshold)?.[1] ?? 50;
  const center = Math.floor(close / step);
  if (!Number.isSafeInteger(center)) return [];
  // Eight nearest levels can be found within eight steps on either side.
  return Array.from({ length: 17 }, (_, index) => (center + index - 8) * step)
    .filter(value => value > 0 && value >= close * 0.9 && value <= close * 1.1)
    .sort((a, b) => Math.abs(a - close) - Math.abs(b - close)).slice(0, 8)
    .filter(value => Math.abs(value - close) / close >= 0.01)
    .map(value => point("round", value, `整数关口 ${value}`, side(value, close), "weak"));
}

/** Calculate the pinned chart price levels as of the last supplied trading date. */
export function computeTspPriceLevels(bars: readonly TspPriceLevelBar[]) {
  const daily = computeTspDailyIndicators(bars).at(-1);
  const last = bars.at(-1);
  const levels: Record<Group, TspPriceLevel[]> = emptyLevels();
  if (!daily || !last) return { asOf: null, volumeProfileBasis: "volume-only" as const, levels };
  let turnoverRows = 0;
  for (const { turnoverPct } of bars) {
    if (turnoverPct == null) continue;
    if (!Number.isFinite(turnoverPct) || turnoverPct < 0) throw new Error("Invalid TSP turnover observation");
    turnoverRows++;
  }
  const volumeProfileBasis = turnoverRows === 0 ? "volume-only" as const
    : turnoverRows === bars.length ? "turnover-decay" as const : "partial-turnover" as const;

  const { close } = last;
  const { atr_14: atr, ma20, ma60, boll_upper: upper, boll_lower: lower } = daily;
  const around = (group: Group, value: number, label: string) => point(group, value, label, side(value, close), "medium");
  const channel = (group: Group, average: number | null, width: number, label: string) =>
    average === null || atr <= 0 ? [] : [around(group, average + width * atr, `${label}通道上轨`), around(group, average - width * atr, `${label}通道下轨`)];

  levels.sr = profile(bars, close);
  levels.pivot = pivots(last);
  levels.extreme = extremes(bars, close);
  if (upper !== null && lower !== null && upper > 0 && lower > 0 && ma20 !== null) {
    levels.boll = [around("boll", upper, "布林上轨"), around("boll", lower, "布林下轨"), around("boll", ma20, "布林中轨")];
  }
  levels.keltner_s = channel("keltner_s", ma20, 2, "短期");
  levels.keltner_m = channel("keltner_m", ma60, 2.5, "中期");
  levels.keltner_l = channel("keltner_l", bars.length >= 120 ? mean(bars.slice(-120).map(bar => bar.close)) : null, 3, "长期");
  if (atr > 0) {
    levels.atr_stop = [
      point("atr_stop", close + 2 * atr, "ATR 上轨(+2)", "resistance", "medium"),
      point("atr_stop", close + 1.5 * atr, "ATR 上轨(+1.5)", "resistance", "weak"),
      point("atr_stop", close - 1.5 * atr, "ATR 下轨(-1.5)", "support", "weak"),
      point("atr_stop", close - 2 * atr, "ATR 下轨(-2)", "support", "medium"),
    ];
  }
  levels.gap = gaps(bars, close);
  levels.fib = fibonacci(bars, close);
  levels.round = roundLevels(close);
  return { asOf: last.date, volumeProfileBasis, levels };
}

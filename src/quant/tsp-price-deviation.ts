import { isDailyDate } from "../market/bars.ts";

export const TSP_PRICE_DEVIATION_FORMULA_VERSION = 1;
export const TSP_DEVIATION_WINDOWS = [3, 10, 30] as const;
const benchmarks = {
  SH: ["000002.SH", "000001.SH"],
  STAR: ["000688.SH", "000002.SH"],
  SZ: ["399107.SZ", "399001.SZ"],
  GEM: ["399102.SZ", "399107.SZ"],
  BJ: ["899050.BJ", "000001.SH"],
} as const;

export type TspDeviationBoard = keyof typeof benchmarks;
type Window = typeof TSP_DEVIATION_WINDOWS[number];
export type TspDeviationIndex = typeof benchmarks[TspDeviationBoard][number];

export interface TspDeviationClose {
  date: string;
  close: number;
}

export interface TspPriceDeviationInput {
  symbol: string;
  tradingDates: readonly string[];
  stock: readonly TspDeviationClose[];
  benchmark: { symbol: TspDeviationIndex; levels: readonly TspDeviationClose[] } | null;
}

export interface TspPriceDeviationRow {
  date: string;
  values: Record<`deviate_${Window}d`, number | null>;
  comparisonDates: Record<Window, string | null>;
}

function boardFor(symbol: string): TspDeviationBoard {
  if (/^68\d{4}\.SH$/.test(symbol)) return "STAR";
  if (/^6\d{5}\.SH$/.test(symbol)) return "SH";
  if (/^30\d{4}\.SZ$/.test(symbol)) return "GEM";
  if (/^0\d{5}\.SZ$/.test(symbol)) return "SZ";
  if (/^(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ$/.test(symbol)) return "BJ";
  throw new Error("Invalid stock symbol for TSP price deviation");
}

export function tspDeviationBenchmarkCandidates(symbol: string): readonly TspDeviationIndex[] {
  return benchmarks[boardFor(symbol)].slice();
}

function closingLevels(bars: readonly TspDeviationClose[], calendar: ReadonlySet<string>): Map<string, number> {
  const values = new Map<string, number>();
  let previous = "";
  for (const { date, close } of bars) {
    if (!calendar.has(date) || date <= previous || !Number.isFinite(close) || close <= 0) {
      throw new Error("Invalid or unordered TSP price deviation closes");
    }
    values.set(date, close);
    previous = date;
  }
  return values;
}

/** Calculate from the same start and end sessions for stock and benchmark. */
export function computeTspPriceDeviation({ symbol, tradingDates, stock, benchmark }: TspPriceDeviationInput) {
  const board = boardFor(symbol);
  const candidates: readonly TspDeviationIndex[] = benchmarks[board];
  if (benchmark && !candidates.includes(benchmark.symbol)) throw new Error("Benchmark is not eligible for this stock board");
  const calendar = new Set<string>();
  let previous = "";
  for (const date of tradingDates) {
    if (!isDailyDate(date) || date <= previous) throw new Error("Invalid or unordered TSP price deviation calendar");
    calendar.add(date);
    previous = date;
  }
  const stockCloses = closingLevels(stock, calendar);
  const indexLevels = closingLevels(benchmark?.levels ?? [], calendar);
  const rows: TspPriceDeviationRow[] = tradingDates.map((date, index) => {
    const stockEnd = stockCloses.get(date);
    const indexEnd = indexLevels.get(date);
    const compare = (window: Window): number | null => {
      const start = tradingDates[index - window];
      if (start === undefined || stockEnd === undefined || indexEnd === undefined) return null;
      const stockStart = stockCloses.get(start);
      const indexStart = indexLevels.get(start);
      if (stockStart === undefined || indexStart === undefined) return null;
      const value = (stockEnd / stockStart - 1) - (indexEnd / indexStart - 1);
      return Number.isFinite(value) ? value : null;
    };
    return {
      date,
      values: { deviate_3d: compare(3), deviate_10d: compare(10), deviate_30d: compare(30) },
      comparisonDates: { 3: tradingDates[index - 3] ?? null, 10: tradingDates[index - 10] ?? null, 30: tradingDates[index - 30] ?? null },
    };
  });
  return { symbol, board, benchmark: benchmark?.symbol ?? null, rows };
}

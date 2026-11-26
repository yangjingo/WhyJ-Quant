import { isDailyDate } from "../market/bars.ts";
import { compareTotalReturns } from "./relative-return.ts";
import { finiteStatistic, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_BACKTEST_BENCHMARK_SYMBOL = "000001.SH";
export const TSP_BACKTEST_BENCHMARK_FORMULA_VERSION = "tsp-backtest-benchmark-v1";

export interface TspBacktestBenchmarkInput {
  range: { start: string; end: string };
  strategy: { basis: "portfolio-nav" | "independent-exits"; totalReturn: number | null };
  index: {
    symbol: typeof TSP_BACKTEST_BENCHMARK_SYMBOL;
    closes: readonly { tradeDate: string; closePoints: number | null }[];
  };
}

export function computeTspBacktestBenchmark({ range, strategy, index }: TspBacktestBenchmarkInput) {
  const { start, end } = range;
  const { basis, totalReturn } = strategy;
  if (typeof start !== "string" || typeof end !== "string" || start < "0001-01-01" ||
    !isDailyDate(start) || !isDailyDate(end) || start > end ||
    (basis !== "portfolio-nav" && basis !== "independent-exits") ||
    (totalReturn !== null && !Number.isFinite(totalReturn)) ||
    index.symbol !== TSP_BACKTEST_BENCHMARK_SYMBOL || !Array.isArray(index.closes)) {
    throw new Error("Invalid TSP backtest benchmark evidence");
  }
  type Endpoint = { tradeDate: string; closePoints: number; reportClosePoints: number };
  let previous = "", eligibleCount = 0;
  let first: Endpoint | null = null, last: Endpoint | null = null;
  for (const row of index.closes) {
    if (!row || typeof row.tradeDate !== "string" || !isDailyDate(row.tradeDate) ||
      row.tradeDate <= previous || row.tradeDate < start || row.tradeDate > end ||
      (row.closePoints !== null && !Number.isFinite(row.closePoints))) {
      throw new Error("Invalid or unordered benchmark close observation");
    }
    const { tradeDate, closePoints } = row;
    previous = tradeDate;
    if (closePoints === null || closePoints <= 0) continue;
    const reportClosePoints = roundDecimalTiesToEven(closePoints);
    if (reportClosePoints <= 0) continue;
    const endpoint = { tradeDate, closePoints, reportClosePoints };
    first ??= endpoint;
    last = endpoint;
    eligibleCount++;
  }

  const evidence = {
    producer: "whyj" as const,
    formulaVersion: TSP_BACKTEST_BENCHMARK_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    range: { start, end },
    strategy: { basis, totalReturn },
    observation: { symbol: index.symbol, rowCount: index.closes.length, eligibleCount, first, last },
  };
  if (eligibleCount < 2 || !first || !last) return {
    ...evidence, status: "unavailable" as const, reason: "insufficient-index-closes" as const,
    benchmarkReturn: null, excessReturn: null,
  };
  const benchmarkReturn = finiteStatistic(last.reportClosePoints / first.reportClosePoints - 1);
  return {
    ...evidence,
    status: "available" as const,
    benchmarkReturn,
    excessReturn: totalReturn === null ? null : compareTotalReturns(totalReturn, benchmarkReturn).excessReturn,
  };
}

import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspPaperNavRow } from "./tsp-paper-statistics.ts";

export const TSP_PAPER_NAV_BENCHMARK_SYMBOL = "000300.SH";
export const TSP_PAPER_NAV_BENCHMARK_FORMULA_VERSION = "tsp-paper-nav-benchmark-v1";

export interface TspPaperNavBenchmarkInput {
  accountId: string;
  currency: string;
  finalizedNav: readonly TspPaperNavRow[];
  index: {
    symbol: typeof TSP_PAPER_NAV_BENCHMARK_SYMBOL;
    closes: readonly { tradeDate: string; closePoints: number | null }[];
  };
}

interface Baseline {
  tradeDate: string;
  value: number;
}

function base100(value: number | null, baseline: Baseline | null): number | null {
  return value !== null && value > 0 && baseline ? Number(finiteStatistic(value / baseline.value * 100).toFixed(2)) : null;
}

export function computeTspPaperNavBenchmark({ accountId, currency, finalizedNav, index }: TspPaperNavBenchmarkInput) {
  if (typeof accountId !== "string" || !accountId.trim() || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) ||
    !Array.isArray(finalizedNav) || index?.symbol !== TSP_PAPER_NAV_BENCHMARK_SYMBOL || !Array.isArray(index.closes)) {
    throw new Error("Invalid paper NAV benchmark scope");
  }

  const closes = new Map<string, number | null>();
  let previousDate = "";
  for (const row of index.closes as TspPaperNavBenchmarkInput["index"]["closes"]) {
    if (!row || !isDailyDate(row.tradeDate) || row.tradeDate <= previousDate ||
      (row.closePoints !== null && !Number.isFinite(row.closePoints))) throw new Error("Invalid or unordered paper benchmark close");
    closes.set(row.tradeDate, row.closePoints);
    previousDate = row.tradeDate;
  }

  let navBaseline: Baseline | null = null, benchmarkBaseline: Baseline | null = null;
  let positiveNavRows = 0, positiveBenchmarkRows = 0, missingBenchmarkRows = 0;
  previousDate = "";
  const rows = [];
  for (const row of finalizedNav as readonly TspPaperNavRow[]) {
    if (!row || row.currency !== currency || !isDailyDate(row.tradeDate) || row.tradeDate <= previousDate ||
      !Number.isFinite(row.nav)) throw new Error("Invalid or unordered finalized paper NAV");
    const { tradeDate, nav } = row;
    previousDate = tradeDate;
    const benchmarkClosePoints = closes.get(tradeDate) ?? null;
    if (nav > 0) {
      navBaseline ??= { tradeDate, value: nav };
      positiveNavRows++;
    }
    if (benchmarkClosePoints !== null && benchmarkClosePoints > 0) {
      benchmarkBaseline ??= { tradeDate, value: benchmarkClosePoints };
      positiveBenchmarkRows++;
    }
    if (benchmarkClosePoints === null) missingBenchmarkRows++;
    rows.push({ tradeDate, nav, benchmarkClosePoints, navBase100: base100(nav, navBaseline),
      benchmarkBase100: base100(benchmarkClosePoints, benchmarkBaseline) });
  }

  return {
    producer: "whyj" as const, formulaVersion: TSP_PAPER_NAV_BENCHMARK_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    accountId, currency, benchmarkSymbol: index.symbol,
    baselines: { nav: navBaseline, benchmark: benchmarkBaseline },
    coverage: { navRows: rows.length, positiveNavRows, positiveBenchmarkRows, missingBenchmarkRows },
    rows,
  };
}

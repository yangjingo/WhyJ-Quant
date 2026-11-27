import { computeTspPaperNavBenchmark, TSP_PAPER_NAV_BENCHMARK_SYMBOL, type TspPaperNavBenchmarkInput } from "../../quant/index.ts";
import { loadBenchmarkIndexArchive, type BenchmarkIndexArchiveRef } from "../../storage/index.ts";

export interface PaperNavBenchmarkReplayRequest extends Omit<TspPaperNavBenchmarkInput, "index"> {
  benchmarkRefs: readonly BenchmarkIndexArchiveRef[];
}

export async function replayTspPaperNavBenchmark(request: PaperNavBenchmarkReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { benchmarkRefs, ...scope } = structuredClone(request);
  if (!Array.isArray(scope.finalizedNav) || !Array.isArray(benchmarkRefs) ||
    new Set(benchmarkRefs.map(ref => ref?.revision)).size !== benchmarkRefs.length) {
    throw new Error("Invalid paper NAV benchmark replay scope");
  }
  const tradingDates = new Set(scope.finalizedNav.map(row => row?.tradeDate));
  const closes = new Map<string, number>();
  const archives = [];
  let provider: "tickflow" | "tushare" | undefined;
  for (const ref of benchmarkRefs as readonly BenchmarkIndexArchiveRef[]) {
    const { rows, ...receipt } = await loadBenchmarkIndexArchive(ref, signal);
    if (receipt.symbol !== TSP_PAPER_NAV_BENCHMARK_SYMBOL || (provider && provider !== receipt.source)) {
      throw new Error("Paper NAV benchmark requires only CSI 300 archives from one provider");
    }
    provider = receipt.source;
    const matchedRows = [];
    for (const { tradeDate, closePoints, sourceTimestamp } of rows) {
      if (!tradingDates.has(tradeDate)) continue;
      const existing = closes.get(tradeDate);
      if (existing !== undefined && existing !== closePoints) throw new Error("Conflicting CSI 300 closes for a paper NAV date");
      closes.set(tradeDate, closePoints);
      matchedRows.push({ tradeDate, closePoints, sourceTimestamp: sourceTimestamp ?? null });
    }
    archives.push({ ref, ...receipt, rowCount: rows.length, matchedRows });
  }
  archives.sort((left, right) => left.requested.start.localeCompare(right.requested.start) ||
    left.ref.revision.localeCompare(right.ref.revision));
  signal?.throwIfAborted();
  const symbol = TSP_PAPER_NAV_BENCHMARK_SYMBOL;
  return {
    ...computeTspPaperNavBenchmark({ ...scope, index: {
      symbol, closes: [...closes].sort(([left], [right]) => left.localeCompare(right)).map(([tradeDate, closePoints]) =>
        ({ tradeDate, closePoints })),
    } }),
    inputs: { benchmark: { symbol, provider: provider ?? null, archives } },
  };
}

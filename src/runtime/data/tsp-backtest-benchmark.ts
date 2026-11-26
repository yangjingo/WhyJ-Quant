import { isDailyDate } from "../../market/bars.ts";
import { computeTspBacktestBenchmark, TSP_BACKTEST_BENCHMARK_SYMBOL, type TspBacktestBenchmarkInput } from "../../quant/index.ts";
import { loadBenchmarkIndexArchive, type BenchmarkIndexArchiveRef } from "../../storage/index.ts";

export interface TspBacktestBenchmarkReplayRequest {
  range: TspBacktestBenchmarkInput["range"];
  strategy: TspBacktestBenchmarkInput["strategy"];
  refs: readonly BenchmarkIndexArchiveRef[];
}

const dayMs = 86_400_000;

export async function replayTspBacktestBenchmark(request: TspBacktestBenchmarkReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { range, strategy, refs } = structuredClone(request);
  const { start, end } = range;
  if (typeof start !== "string" || typeof end !== "string" || start < "0001-01-01" ||
    !isDailyDate(start) || !isDailyDate(end) || start > end ||
    !Array.isArray(refs) || !refs.length || new Set(refs.map(ref => ref?.revision)).size !== refs.length) {
    throw new Error("Invalid backtest benchmark replay scope");
  }

  const archives = [];
  for (const ref of refs) {
    const batch = await loadBenchmarkIndexArchive(ref, signal);
    if (batch.symbol !== TSP_BACKTEST_BENCHMARK_SYMBOL || batch.requested.start > end || batch.requested.end < start) {
      throw new Error("Archive does not match the benchmark index or requested range");
    }
    archives.push({ ref, batch });
  }
  archives.sort((left, right) => left.batch.requested.start.localeCompare(right.batch.requested.start) ||
    left.ref.revision.localeCompare(right.ref.revision));

  const provider = archives[0]!.batch.source;
  const closes = new Map<string, number>();
  let coveredThrough = Date.parse(start) - dayMs;
  const receipts = archives.map(({ ref, batch }) => {
    signal?.throwIfAborted();
    const { requested, source, endpoint, observedAt, coverage, priceUnit, rows } = batch;
    if (source !== provider || Date.parse(requested.start) > coveredThrough + dayMs) {
      throw new Error("Backtest benchmark requires one provider and continuous archive request coverage");
    }
    coveredThrough = Math.max(coveredThrough, Date.parse(requested.end));
    for (const { tradeDate, closePoints } of rows) {
      if (tradeDate < start || tradeDate > end) continue;
      const existing = closes.get(tradeDate);
      if (existing !== undefined && existing !== closePoints) throw new Error("Conflicting archived benchmark closes");
      closes.set(tradeDate, closePoints);
    }
    return { ref, requested, source, endpoint, observedAt, coverage, priceUnit };
  });
  if (coveredThrough < Date.parse(end)) throw new Error("Archive requests do not cover the backtest range");
  const symbol = TSP_BACKTEST_BENCHMARK_SYMBOL;
  const metrics = computeTspBacktestBenchmark({ range, strategy, index: {
    symbol,
    closes: [...closes].sort(([left], [right]) => left.localeCompare(right)).map(([tradeDate, closePoints]) => ({ tradeDate, closePoints })),
  } });
  return { input: { benchmark: { symbol, archives: receipts } }, metrics };
}

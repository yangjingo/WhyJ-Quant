import { isDailyDate } from "../../market/bars.ts";
import {
  computeTspPriceDeviation, tspDeviationBenchmarkCandidates, TSP_INDICATOR_REVISION, TSP_PRICE_DEVIATION_FORMULA_VERSION,
} from "../../quant/index.ts";
import { loadBenchmarkIndexArchive, loadTradingDateArchive, type BenchmarkIndexArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";

export interface PriceDeviationReplayRequest {
  symbol: string;
  sessions: readonly string[];
  stockRef: TradingDateArchiveRef;
  benchmarkRef?: BenchmarkIndexArchiveRef;
}

/** Replay the pinned stock-versus-index deviation over a caller-supplied exchange calendar. */
export async function replayTspPriceDeviation(request: PriceDeviationReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { symbol } = request;
  const candidates = tspDeviationBenchmarkCandidates(symbol);
  const sessions = [...request.sessions];
  const first = sessions[0], last = sessions.at(-1);
  if (first === undefined || last === undefined ||
    sessions.some((date, index) => !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!))) {
    throw new Error("Price deviation replay requires ordered unique exchange sessions");
  }
  const calendar = new Set(sessions);
  const includesDate = (date: string) => {
    if (date < first || date > last) return false;
    if (!calendar.has(date)) throw new Error("Price deviation archive contains an off-calendar observation");
    return true;
  };
  const stockRef = { ...request.stockRef };
  const benchmarkRef = request.benchmarkRef && { ...request.benchmarkRef };
  const records = await loadTradingDateArchive(stockRef, signal);
  const head = records[0]!;
  const { source, endpoint, observedAt, requested, adjustment, coverage } = head;
  if (head.symbol !== symbol || adjustment !== "forward" || requested.startDate > last || requested.endDate < first) {
    throw new Error("Incompatible price deviation stock archive");
  }
  const stock = records.filter(row => includesDate(row.tradeDate))
    .map(({ tradeDate: date, values }) => ({ date, close: values.close }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const benchmark = benchmarkRef ? await loadBenchmarkIndexArchive(benchmarkRef, signal) : null;
  const indexSymbol = candidates.find(candidate => candidate === benchmark?.symbol);
  if (benchmark && (!indexSymbol || benchmark.requested.start > last || benchmark.requested.end < first)) {
    throw new Error("Incompatible price deviation benchmark archive");
  }
  const levels = benchmark?.rows.filter(row => includesDate(row.tradeDate))
    .map(({ tradeDate: date, closePoints: close }) => ({ date, close })) ?? [];
  signal?.throwIfAborted();
  const result = computeTspPriceDeviation({ symbol, tradingDates: sessions, stock,
    benchmark: indexSymbol ? { symbol: indexSymbol, levels } : null });
  const benchmarkEvidence = benchmark && {
    ref: benchmarkRef!, symbol: benchmark.symbol, source: benchmark.source, endpoint: benchmark.endpoint,
    observedAt: benchmark.observedAt, coverage: benchmark.coverage, requested: benchmark.requested,
    priceUnit: benchmark.priceUnit, rowsUsed: levels.length,
  };
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_price_deviation" as const, version: TSP_PRICE_DEVIATION_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    outputUnit: "fraction" as const,
    calendar: { zone: "Asia/Shanghai" as const, sessions },
    input: {
      stock: { ref: stockRef, symbol, source, endpoint, observedAt, requested, adjustment, coverage, rowsUsed: stock.length },
      benchmark: benchmarkEvidence,
    },
    benchmarkCandidates: candidates,
    ...result,
  };
}

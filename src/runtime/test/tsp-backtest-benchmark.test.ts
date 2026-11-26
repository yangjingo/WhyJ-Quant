import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, resolveDataDir, type StoredBenchmarkIndexBatch } from "../../storage/index.ts";
import { replayTspBacktestBenchmark } from "../data/tsp-backtest-benchmark.ts";

const range = { start: "2024-01-03", end: "2025-01-10" };
const strategy = { basis: "portfolio-nav", totalReturn: 0.08 } as const;
const earlier = { start: "2023-12-30", end: "2024-12-28" };
const later = { start: "2024-12-27", end: "2025-01-13" };
let root: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-tsp-backtest-benchmark-runtime-"));
  process.env.OHQUANT_DIR = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function archive(source: "tickflow" | "tushare", requested: typeof range, closes: [string, number][], symbol = "000001.SH") {
  const identity = source === "tickflow" ? { source, endpoint: "/v1/klines" } as const : { source, endpoint: "index_daily" } as const;
  const batch: StoredBenchmarkIndexBatch = {
    ...identity, symbol, requested, market: "A", coverage: "unknown",
    observedAt: "2025-01-14T00:00:00Z", priceUnit: "index-points", returnUnit: "percentage-points",
    rows: closes.map(([tradeDate, closePoints]) => ({
      tradeDate, closePoints, previousClosePoints: null, changePoints: null, returnPct: null,
      ...(source === "tickflow" && { sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00") }),
    })),
  };
  return archiveBenchmarkIndexObservations(batch);
}

test("replays a multi-year range from either source without fetching, including exact overlapping closes", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline fixture"));
  try {
    const results = [];
    for (const source of ["tickflow", "tushare"] as const) {
      const first = await archive(source, earlier, [["2024-01-02", 2000], ["2024-01-04", 3000], ["2024-12-27", 3210]]);
      const second = await archive(source, later, [["2024-12-27", 3210], ["2025-01-09", 3300], ["2025-01-13", 3800]]);
      const result = await replayTspBacktestBenchmark({ range, strategy, refs: [second, first] });
      expect(result.input.benchmark).toMatchObject({ symbol: "000001.SH", archives: [
        { ref: first, requested: earlier, source, endpoint: source === "tickflow" ? "/v1/klines" : "index_daily", coverage: "unknown" },
        { ref: second, requested: later, source, priceUnit: "index-points", observedAt: "2025-01-14T00:00:00Z" },
      ] });
      expect(result.metrics).toMatchObject({ status: "available", producer: "whyj",
        observation: { rowCount: 3, eligibleCount: 3, first: { tradeDate: "2024-01-04" }, last: { tradeDate: "2025-01-09" } } });
      expect(result.metrics.benchmarkReturn).toBeCloseTo(0.1, 14);
      expect(result.metrics.excessReturn).toBeCloseTo(-0.02, 14);
      expect(await replayTspBacktestBenchmark({ range, strategy, refs: [first, second] })).toEqual(result);
      results.push(result.metrics);
    }
    expect(results[0]).toEqual(results[1]);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test("reports unavailable coverage and rejects incompatible, missing or corrupt archive revisions", async () => {
  const short = { start: "2025-01-02", end: "2025-01-09" };
  const request = { strategy, range: short };
  const empty = await archive("tickflow", short, []);
  const sparse = await archive("tickflow", short, [["2025-01-08", 3100]]);
  for (const ref of [empty, sparse]) {
    expect((await replayTspBacktestBenchmark({ ...request, refs: [ref] })).metrics).toMatchObject({
      status: "unavailable", reason: "insufficient-index-closes", benchmarkReturn: null, excessReturn: null,
    });
  }
  const wrongIndex = await archive("tickflow", short, [], "000300.SH");
  const otherProvider = await archive("tushare", short, []);
  const contradictory = await archive("tickflow", short, [["2025-01-08", 3099]]);
  const gap = await archive("tickflow", { start: "2025-01-05", end: short.end }, []);
  for (const refs of [[wrongIndex], [sparse, otherProvider], [sparse, contradictory], [gap],
    [sparse, sparse], [{ ...empty, revision: "e".repeat(64) }]]) {
    await expect(replayTspBacktestBenchmark({ ...request, refs })).rejects.toThrow();
  }
  writeFileSync(join(resolveDataDir(), "benchmark-index-archives-v1", empty.revision + ".json"), "{}");
  await expect(replayTspBacktestBenchmark({ ...request, refs: [empty] })).rejects.toThrow("Observation archive is damaged");
});

test("requires continuous request coverage independently of observed date gaps", async () => {
  const range = { start: "2025-01-02", end: "2025-01-09" };
  const first = await archive("tickflow", { start: range.start, end: "2025-01-04" }, [["2025-01-03", 3000]]);
  const adjacent = await archive("tickflow", { start: "2025-01-05", end: range.end }, [["2025-01-08", 3300]]);
  const gap = await archive("tickflow", { start: "2025-01-06", end: range.end }, [["2025-01-08", 3300]]);

  const replay = await replayTspBacktestBenchmark({ range, strategy, refs: [first, adjacent] });
  expect(replay.metrics).toMatchObject({ status: "available", observation: { rowCount: 2 } });
  await expect(replayTspBacktestBenchmark({ range, strategy, refs: [first, gap] }))
    .rejects.toThrow("continuous archive request coverage");
});

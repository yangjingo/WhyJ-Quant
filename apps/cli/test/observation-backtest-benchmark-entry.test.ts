import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveBenchmarkIndexObservations, resolveDataDir, type StoredBenchmarkIndexBatch } from "../../../src/storage/index.ts";

test("actual backtest CLI adds independent and portfolio Shanghai comparisons from exact archives", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-backtest-benchmark-cli-"));
  const path = join(root, "backtest.json");
  const previous = process.env.OHQUANT_DIR;
  const range = { start: "2025-02-03", end: "2025-02-07" };
  const dates = ["2025-02-05", "2025-02-06"] as const;
  const common = { schemaVersion: 1, includeMonteCarlo: false } as const;
  const portfolio = { ...common, initialCapital: 100, equityCurve: [
    { date: dates[0], equity: 100, exposureFraction: 0 }, { date: dates[1], equity: 120, exposureFraction: 0.5 },
  ], trades: [] };
  const candidates = { ...common, candidateCount: 2, execution: {}, trades: [
    { symbol: "000001.SZ", exitDate: dates[0], pnlFraction: 0.1, holdingDays: 1 },
    { symbol: "600000.SH", exitDate: dates[1], pnlFraction: 0.02, holdingDays: 3 },
  ] };
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function archive(source: "tickflow" | "tushare", empty = false) {
    const identity = source === "tickflow" ? { source, endpoint: "/v1/klines" } as const : { source, endpoint: "index_daily" } as const;
    const batch: StoredBenchmarkIndexBatch = {
      ...identity, market: "A", symbol: "000001.SH", observedAt: "2025-02-08T00:00:00Z",
      requested: range, coverage: "unknown", priceUnit: "index-points", returnUnit: "percentage-points",
      rows: empty ? [] : dates.map((tradeDate, index) => ({ tradeDate, closePoints: 3000 + 300 * index,
        changePoints: null, previousClosePoints: null, returnPct: null,
        ...(source === "tickflow" && { sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00") }) })),
    };
    return archiveBenchmarkIndexObservations(batch);
  }
  async function replay(action: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    const child = Bun.spawn([...entry, "--json", "observation", action, "--manifest", path], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }

  try {
    process.env.OHQUANT_DIR = root;
    const tickflow = await archive("tickflow"), tushare = await archive("tushare"), empty = await archive("tickflow", true);
    const cases = [
      { action: "replay-backtest-portfolio", report: portfolio, basis: "portfolio-nav", totalReturn: 0.2, excess: 0.1, ref: tickflow, source: "tickflow" },
      { action: "replay-backtest-candidates", report: candidates, basis: "independent-exits", totalReturn: 0.122, excess: 0.022, ref: tushare, source: "tushare" },
    ];
    for (const { action, report, basis, totalReturn, excess, ref, source } of cases) {
      const manifest = { ...report, benchmark: { ...range, benchmarkRevisions: [ref.revision] } };
      const base = await replay(action, report);
      expect(base).toMatchObject({ code: 0, output: { ok: true } });
      expect(base.output.data).not.toHaveProperty("benchmark");
      const result = await replay(action, manifest);
      expect(result).toMatchObject({ code: 0, output: { ok: true } });
      const { benchmark, ...strategy } = result.output.data;
      expect(strategy).toEqual(base.output.data);
      expect(benchmark).toMatchObject({
        input: { benchmark: { symbol: "000001.SH", archives: [{ ref, source, requested: range, coverage: "unknown" }] } },
        metrics: { status: "available", producer: "whyj", formulaVersion: "tsp-backtest-benchmark-v1", strategy: { basis, totalReturn } },
      });
      expect(benchmark.metrics.benchmarkReturn).toBeCloseTo(0.1, 14);
      expect(benchmark.metrics.excessReturn).toBeCloseTo(excess, 14);
    }
    const benchmark = { ...range, benchmarkRevisions: [tickflow.revision] };
    expect(await replay("replay-backtest-portfolio", { ...portfolio, equityCurve: [], benchmark })).toMatchObject({
      code: 0, output: { data: { status: "unavailable", benchmark: { metrics: { status: "available", excessReturn: null } } } },
    });
    expect(await replay("replay-backtest-candidates", { ...candidates, benchmark: { ...benchmark, benchmarkRevisions: [empty.revision] } })).toMatchObject({
      code: 0, output: { data: { status: "available", benchmark: { metrics: { status: "unavailable", benchmarkReturn: null, excessReturn: null } } } },
    });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const patch of [{ benchmarkRevisions: [] }, { benchmarkRevisions: [tickflow.revision, tickflow.revision] },
      { benchmarkRevisions: ["../invalid"] }, { end: "2025-02-05" }, { end: "2025-02-30" }, { source: "tickflow" }]) {
      expect(await replay("replay-backtest-portfolio", { ...portfolio, benchmark: { ...benchmark, ...patch } })).toMatchObject(invalid);
    }
    expect(await replay("replay-backtest-candidates", { ...candidates, benchmark: { ...benchmark, start: dates[1] } })).toMatchObject(invalid);
    const archiveUnavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    for (const benchmarkRevisions of [["e".repeat(64)], [tickflow.revision, tushare.revision]]) {
      expect(await replay("replay-backtest-portfolio", { ...portfolio, benchmark: { ...benchmark, benchmarkRevisions } }))
        .toMatchObject(archiveUnavailable);
    }
    writeFileSync(join(resolveDataDir(), "benchmark-index-archives-v1", tickflow.revision + ".json"), "{}");
    expect(await replay("replay-backtest-portfolio", { ...portfolio, benchmark })).toMatchObject(archiveUnavailable);
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, type StoredBenchmarkIndexBatch } from "../../storage/index.ts";
import { replayTspPaperNavBenchmark } from "../data/paper-nav-benchmark-replay.ts";

const dates = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];
const nav = [0, 100, 80, 115].map((nav, index) => ({ tradeDate: dates[index]!, currency: "CNY", nav }));
const scope = { accountId: "paper", currency: "CNY", finalizedNav: nav };
const quote = (tradeDate: string, closePoints: number): StoredBenchmarkIndexBatch["rows"][number] =>
  ({ tradeDate, closePoints, previousClosePoints: null, changePoints: null, returnPct: null });
const batch: StoredBenchmarkIndexBatch = {
  symbol: "000300.SH", source: "tushare", endpoint: "index_daily", market: "A", observedAt: "2026-03-06T08:00:00Z",
  priceUnit: "index-points", returnUnit: "percentage-points", coverage: "unknown",
  requested: { start: dates[0]!, end: dates[3]! }, rows: [quote(dates[0]!, 4000), quote(dates[2]!, 4100)],
};
let root: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-paper-nav-benchmark-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("binds exact dates to CSI 300 across fixed archives while preserving gaps and references", async () => {
  const first = await archiveBenchmarkIndexObservations(batch);
  const second = await archiveBenchmarkIndexObservations({ ...batch, requested: { start: dates[2]!, end: dates[3]! },
    rows: [quote(dates[2]!, 4100), quote(dates[3]!, 4200)] });
  const result = await replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [second, first] });
  expect(result).toMatchObject({
    producer: "whyj", benchmarkSymbol: "000300.SH", coverage: { navRows: 4, positiveNavRows: 3, positiveBenchmarkRows: 3, missingBenchmarkRows: 1 },
    rows: [{ navBase100: null, benchmarkBase100: 100 }, { navBase100: 100, benchmarkBase100: null },
      { navBase100: 80, benchmarkBase100: 102.5 }, { navBase100: 115, benchmarkBase100: 105 }],
    inputs: { benchmark: { provider: "tushare", archives: [
      { ref: first, priceUnit: "index-points", coverage: "unknown", rowCount: 2,
        matchedRows: [{ tradeDate: dates[0], closePoints: 4000, sourceTimestamp: null }, { tradeDate: dates[2], closePoints: 4100 }] },
      { ref: second, requested: { start: dates[2], end: dates[3] }, matchedRows: [{ tradeDate: dates[2] }, { tradeDate: dates[3] }] },
    ] } },
  });
  expect(await replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [first, second] })).toEqual(result);
  expect(await replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [] })).toMatchObject({
    coverage: { missingBenchmarkRows: 4, positiveBenchmarkRows: 0 }, inputs: { benchmark: { provider: null, archives: [] } },
  });
});

test("rejects conflicting prices, mismatched index/provider, repeated references and cancelled reads", async () => {
  const first = await archiveBenchmarkIndexObservations(batch);
  const wrongIndex = await archiveBenchmarkIndexObservations({ ...batch, symbol: "000001.SH" });
  const wrongProvider = await archiveBenchmarkIndexObservations({ ...batch, source: "tickflow", endpoint: "/v1/klines",
    rows: batch.rows.map(row => ({ ...row, sourceTimestamp: Date.parse(row.tradeDate + "T15:00:00+08:00") })) });
  const conflict = await archiveBenchmarkIndexObservations({ ...batch, rows: [quote(dates[2]!, 4210)] });
  await expect(replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [first, conflict] })).rejects.toThrow("Conflicting");
  await expect(replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [wrongIndex] })).rejects.toThrow("CSI 300");
  await expect(replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [first, wrongProvider] })).rejects.toThrow("one provider");
  await expect(replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [first, first] })).rejects.toThrow("Invalid");
  const cancel = new AbortController();
  cancel.abort(new Error("cancelled paper chart capture"));
  await expect(replayTspPaperNavBenchmark({ ...scope, benchmarkRefs: [first] }, cancel.signal)).rejects.toThrow("cancelled");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, loadBenchmarkIndexArchive, type StoredBenchmarkIndexBatch } from "../index.ts";

const sample = (): StoredBenchmarkIndexBatch => ({
  symbol: "000001.SH", market: "A", source: "tushare", endpoint: "index_daily", coverage: "unknown",
  observedAt: "2024-02-06T16:02:00Z", priceUnit: "index-points", returnUnit: "percentage-points",
  requested: { start: "2024-02-01", end: "2024-02-09" },
  rows: [
    { tradeDate: "2024-02-01", closePoints: 3010, previousClosePoints: 3000, changePoints: 10, returnPct: 0.3333 },
    { tradeDate: "2024-02-02", closePoints: 3010, previousClosePoints: null, changePoints: null, returnPct: null },
    { tradeDate: "2024-02-06", closePoints: 3010, previousClosePoints: 3010, changePoints: 0, returnPct: 0 },
    { tradeDate: "2024-02-07", closePoints: 3000, previousClosePoints: 3010, changePoints: -10, returnPct: -0.3322 },
  ],
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-benchmark-index-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "benchmark-index-archives-v1");

function bse50(): StoredBenchmarkIndexBatch {
  return { ...sample(), symbol: "899050.BJ", source: "tickflow", endpoint: "/v1/klines",
    rows: [{ tradeDate: "2024-02-01", sourceTimestamp: Date.parse("2024-02-01T00:00:00+08:00"),
      closePoints: 841.492, previousClosePoints: null, changePoints: null, returnPct: null }] };
}

test("replays exact captured index points and returns, including empty snapshots and independent corrections", async () => {
  const input = sample();
  const [first, duplicate] = await Promise.all([archiveBenchmarkIndexObservations(input), archiveBenchmarkIndexObservations(sample())]);
  expect(first).toEqual({ version: 1, kind: "benchmark-index", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(duplicate).toEqual(first);
  expect(await loadBenchmarkIndexArchive(first)).toEqual(input);

  const recapture = { ...sample(), observedAt: "2024-02-08T00:00:00Z" };
  const correction = sample();
  correction.rows[0]!.returnPct = 0.3334;
  const empty = { ...sample(), rows: [] };
  for (const batch of [recapture, correction, empty]) {
    const ref = await archiveBenchmarkIndexObservations(batch);
    expect(ref.revision).not.toBe(first.revision);
    expect(await loadBenchmarkIndexArchive(ref)).toEqual(batch);
  }
  expect(await loadBenchmarkIndexArchive(first)).toEqual(input);
});

test("rejects unsorted, misdated and invalid index batches before creating an archive", async () => {
  const duplicate = sample(), unsorted = sample(), outside = sample(), future = sample(), invalid = sample(), extra = sample();
  duplicate.rows.push(duplicate.rows.at(-1)!);
  unsorted.rows.reverse();
  outside.rows[0]!.tradeDate = "2024-01-31";
  future.rows.at(-1)!.tradeDate = "2024-02-08";
  invalid.rows[0]!.closePoints = Infinity;
  Object.assign(extra.rows[0]!, { inferred: true });
  const rejected = [
    duplicate, unsorted, outside, future, invalid, extra,
    { ...sample(), symbol: "000001.SZ" },
    { ...sample(), returnUnit: "fraction" },
    { ...sample(), observedAt: "2024-02-30T00:00:00Z" },
    { ...sample(), requested: { start: "2024-02-01", end: "2025-02-02" } },
  ];
  for (const batch of rejected) {
    await expect(archiveBenchmarkIndexObservations(batch as StoredBenchmarkIndexBatch)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveBenchmarkIndexObservations(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("rejects forged references and corrupt files", async () => {
  const ref = await archiveBenchmarkIndexObservations(sample());
  await expect(loadBenchmarkIndexArchive({ ...ref, revision: "../other.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadBenchmarkIndexArchive({ ...ref, kind: "market-cross-section" } as unknown as typeof ref))
    .rejects.toThrow("Invalid observation archive");
  await expect(loadBenchmarkIndexArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadBenchmarkIndexArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

test("retains TickFlow BSE 50 native timestamps, empty responses and independent revisions", async () => {
  const input = bse50();
  const original = await archiveBenchmarkIndexObservations(input);
  expect(await loadBenchmarkIndexArchive(original)).toEqual(input);
  const recapture = { ...input, observedAt: "2024-02-08T00:00:00Z", rows: [] };
  const next = await archiveBenchmarkIndexObservations(recapture);
  expect(next.revision).not.toBe(original.revision);
  expect(await loadBenchmarkIndexArchive(next)).toEqual(recapture);
  expect(await loadBenchmarkIndexArchive(original)).toEqual(input);
});

test("rejects mismatched provider identity, Shanghai dates and inferred fields in a benchmark capture", async () => {
  const input = bse50();
  const row = input.rows[0]!;
  const { sourceTimestamp: _timestamp, ...withoutTimestamp } = row;
  const cases = [
    { ...input, endpoint: "index_daily" },
    { ...input, source: "tushare", endpoint: "index_daily", rows: [withoutTimestamp] },
    { ...input, symbol: "920001.BJ" },
    { ...input, rows: [withoutTimestamp] },
    { ...input, rows: [{ ...row, sourceTimestamp: Date.parse("2024-02-01T16:00:00Z") }] },
    { ...input, rows: [{ ...row, sourceTimestamp: Infinity }] },
    { ...input, rows: [{ ...row, previousClosePoints: 810 }] },
    { ...input, rows: [{ ...row, changePoints: 31.492 }] },
    { ...input, rows: [{ ...row, returnPct: 3.9 }] },
    { ...sample(), rows: [{ ...sample().rows[0], sourceTimestamp: row.sourceTimestamp }] },
  ];
  for (const batch of cases) {
    await expect(archiveBenchmarkIndexObservations(batch as StoredBenchmarkIndexBatch)).rejects.toThrow("Invalid observation archive");
  }
  expect(existsSync(archiveDir())).toBe(false);
});

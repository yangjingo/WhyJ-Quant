import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDepthSnapshot, loadDepthSnapshotArchive, type StoredDepthSnapshot } from "../index.ts";

const tradeDate = "2025-01-03";
const observedAt = "2025-01-03T07:02:00Z";
const timestamp = Date.parse(tradeDate + "T15:00:00+08:00");
const missingSymbol = "600003.SH";
const batch: StoredDepthSnapshot = {
  market: "A", source: "tickflow", endpoint: "/v1/depth", tradeDate, observedAt, coverage: "unknown", volumeUnit: "unknown",
  requestedSymbols: ["600001.SH", "600002.SH", missingSymbol],
  rows: [
    { symbol: "600001.SH", timestamp, bids: [{ price: 10, volume: 200 }, { price: 9.99, volume: 100 }],
      asks: [{ price: 0, volume: 0 }] },
    { symbol: "600002.SH", timestamp: timestamp - 1_000, bids: [], asks: [{ price: 12.1, volume: 700 }] },
  ],
};

let root: string, prior: string | undefined;
beforeEach(() => {
  prior = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-depth-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "depth-snapshot-archives-v1");

test("reopens exact native levels, explicit zero, empty sides, missing symbols and independent captures", async () => {
  const first = await archiveDepthSnapshot(batch);
  expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(first).toEqual({ version: 1, kind: "depth-snapshot", revision: first.revision });
  expect(await archiveDepthSnapshot(batch)).toEqual(first);
  const capture = await loadDepthSnapshotArchive(first);
  expect(capture).toEqual(batch);
  expect(capture.requestedSymbols.filter(symbol => !capture.rows.some(row => row.symbol === symbol))).toEqual([missingSymbol]);
  expect(capture.rows[0]?.asks).toEqual([{ price: 0, volume: 0 }]);
  expect(capture.rows[1]?.bids).toEqual([]);
  const secondBatch: StoredDepthSnapshot = { ...batch, endpoint: "/v1/depth/batch", observedAt: "2025-01-03T07:03:00Z", rows: [] };
  const second = await archiveDepthSnapshot(secondBatch);
  expect(second.revision).not.toBe(first.revision);
  expect(await loadDepthSnapshotArchive(second)).toEqual(secondBatch);
  expect(await loadDepthSnapshotArchive(first)).toEqual(batch);
});

test("rejects invalid timestamp, books and identity before writing any archive", async () => {
  const row = batch.rows[0]!;
  const invalid = [
    { ...batch, source: "tushare" }, { ...batch, endpoint: "/v1/depth?credential=value" },
    { ...batch, requestedSymbols: ["600002.SH", "600001.SH"] },
    { ...batch, requestedSymbols: ["600001.SH", "600001.SH"] },
    { ...batch, requestedSymbols: ["899050.BJ"] },
    { ...batch, rows: [row, row] }, { ...batch, rows: [{ ...row, symbol: "600004.SH" }] },
    { ...batch, rows: [{ ...row, timestamp: Date.parse("2025-01-02T15:00:00+08:00") }] },
    { ...batch, rows: [{ ...row, timestamp: Date.parse(observedAt) + 1 }] },
    { ...batch, rows: [{ ...row, asks: [{ price: 0, volume: -1 }] }] },
    { ...batch, rows: [{ ...row, asks: [{ price: 0, volume: 0.5 }] }] },
    { ...batch, rows: [{ ...row, bids: [{ price: 9, volume: 1 }, { price: 10, volume: 2 }] }] },
    { ...batch, rows: [{ ...row, bids: Array(6).fill({ price: 10, volume: 2 }) }] },
  ];
  for (const item of invalid) {
    await expect(archiveDepthSnapshot(item as StoredDepthSnapshot)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveDepthSnapshot(batch, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("fails visibly for missing, malformed, cancelled and damaged depth references", async () => {
  const ref = await archiveDepthSnapshot(batch);
  await expect(loadDepthSnapshotArchive({ ...ref, revision: "f".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(loadDepthSnapshotArchive({ ...ref, revision: "../other.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDepthSnapshotArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadDepthSnapshotArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

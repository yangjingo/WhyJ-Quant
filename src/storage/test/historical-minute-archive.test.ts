import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveHistoricalMinuteObservations, loadHistoricalMinuteArchive, loadTradingDateArchive } from "../index.ts";
import type { HistoricalMinuteArchiveRef, StoredHistoricalMinuteBatch } from "../index.ts";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-historical-minute-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const batch = (): StoredHistoricalMinuteBatch => ({
  symbol: "600000.SH", market: "A", source: "tushare", endpoint: "stk_mins", timeZone: "Asia/Shanghai",
  interval: "1m", volumeUnit: "share", amountUnit: "CNY", coverage: "unknown", finality: "unknown", adjustment: "unknown",
  observedAt: "2024-01-04T16:00:00Z", requested: { startDate: "2024-01-02", endDate: "2024-01-03" },
  rows: ["09:30", "09:31", "11:30", "13:01", "15:00"].map((time, i) => ({
    tradeTime: `2024-01-02 ${time}:00`, openingBoundary: i === 0,
    open: 10, high: 11, low: 9, close: 10.5, volume: i === 1 ? 0 : 100, amount: i === 1 ? 0 : i === 2 ? null : 1050,
  })),
});
const path = (ref: HistoricalMinuteArchiveRef) => join(root, "data", "historical-minute-archives-v1", `${ref.revision}.json`);

test("round trips historical minute labels including the opening boundary and legitimate zero", async () => {
  const input = batch();
  const [left, right] = await Promise.all([archiveHistoricalMinuteObservations(input), archiveHistoricalMinuteObservations(input)]);
  expect(left).toEqual(right);
  expect(left.kind).toBe("historical-minute-bars");
  expect(left.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadHistoricalMinuteArchive(left)).toEqual(input);
  const corrected = batch();
  corrected.rows[0]!.amount = 1100;
  const revision = await archiveHistoricalMinuteObservations(corrected);
  expect(revision.revision).not.toBe(left.revision);
  expect(await loadHistoricalMinuteArchive(left)).toEqual(input);
  expect(await loadHistoricalMinuteArchive(revision)).toEqual(corrected);
});

test("rejects unknown kinds, impossible chronology, mislabeled and damaged historical minute data", async () => {
  const input = batch();
  const first = input.rows[0]!;
  const invalid = [
    { ...input, symbol: "899050.BJ" }, { ...input, amountUnit: "unknown" }, { ...input, rows: [] },
    { ...input, observedAt: "2024-01-02T16:00:00Z" }, { ...input, rows: [first, first] },
    { ...input, rows: input.rows.toReversed() }, { ...input, rows: [{ ...first, openingBoundary: false }] },
    { ...input, rows: [{ ...first, tradeTime: "2024-01-02 12:31:00" }] },
    { ...input, rows: [{ ...first, tradeTime: "2024-01-04 09:30:00" }] },
    { ...input, rows: [{ ...first, tradeTime: "2024-01-02 09:30:01" }] },
    { ...input, rows: [{ ...first, low: 10.9 }] }, { ...input, rows: [{ ...first, volume: 100.5 }] },
  ];
  for (const value of invalid) await expect(archiveHistoricalMinuteObservations(value as StoredHistoricalMinuteBatch)).rejects.toThrow("Invalid");
  const ref = await archiveHistoricalMinuteObservations(input);
  await expect(loadHistoricalMinuteArchive({ ...ref, revision: "../private" })).rejects.toThrow("Invalid");
  await expect(loadHistoricalMinuteArchive({ ...ref, kind: "daily-trading-limits" } as never)).rejects.toThrow("Invalid");
  await expect(loadTradingDateArchive(ref as never)).rejects.toThrow("Invalid");
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(loadHistoricalMinuteArchive(ref, cancelled.signal)).rejects.toThrow();
  await expect(archiveHistoricalMinuteObservations(input, cancelled.signal)).rejects.toThrow();
  writeFileSync(path(ref), "{}");
  await expect(loadHistoricalMinuteArchive(ref)).rejects.toThrow("damaged");
  await expect(archiveHistoricalMinuteObservations(input)).rejects.toThrow("damaged");
});

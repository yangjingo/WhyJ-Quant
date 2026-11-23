import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedEtfDailyBars, loadDatedEtfDailyArchive, type StoredDatedEtfDailyBatch } from "../index.ts";

const sample = (): StoredDatedEtfDailyBatch => ({
  market: "A", assetType: "etf", symbol: "510330.SH", source: "tushare", endpoint: "fund_daily",
  requested: { start: "2025-06-16", end: "2025-06-18" }, observedAt: "2025-06-19T01:00:00Z",
  coverage: "unknown", adjustment: "none", interval: "1d", timeZone: "Asia/Shanghai",
  priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
  rows: [
    { tradeDate: "2025-06-16", sourceTimestamp: null, open: 4, high: 4.5, low: 3.9, close: 4.1, volume: 0, amount: null },
    { tradeDate: "2025-06-18", sourceTimestamp: null, open: 4.1, high: 4.8, low: 3.9, close: 4.4, volume: 123, amount: 0 },
  ],
});
const timestamp = (date: string) => Date.parse(date + "T15:00:00+08:00");
const tickflow = (): StoredDatedEtfDailyBatch => ({
  ...sample(), source: "tickflow", endpoint: "/v1/klines", priceUnit: "unknown", volumeUnit: "unknown", amountUnit: "unknown",
  rows: sample().rows.map(row => ({ ...row, sourceTimestamp: timestamp(row.tradeDate) })),
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-etf-daily-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const dir = () => join(root, "data", "dated-etf-daily-archives-v1");

test("preserves both raw provider formats, empty observations and immutable corrections", async () => {
  const [ref, repeated] = await Promise.all([archiveDatedEtfDailyBars(sample()), archiveDatedEtfDailyBars(sample())]);
  expect(ref).toMatchObject({ version: 1, kind: "dated-etf-daily" });
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(ref).toEqual(repeated);
  const revised = sample();
  revised.rows[0]!.close = 4.2;
  for (const batch of [revised, tickflow(), { ...sample(), rows: [] }]) {
    const next = await archiveDatedEtfDailyBars(batch);
    expect(next.revision).not.toBe(ref.revision);
    expect(await loadDatedEtfDailyArchive(next)).toEqual(batch);
  }
  expect(await loadDatedEtfDailyArchive(ref)).toEqual(sample());
});

test("rejects provider, identity, unit, dates and price inconsistencies before writing", async () => {
  const { rows } = sample();
  for (const batch of [
    { ...sample(), symbol: "600001.SH" }, { ...sample(), symbol: "501001.SH" },
    { ...sample(), endpoint: "daily" }, { ...tickflow(), priceUnit: "CNY" }, { ...sample(), adjustment: "forward" },
    { ...sample(), rows: [rows[0], rows[0]] }, { ...sample(), rows: rows.toReversed() },
    { ...sample(), rows: [{ ...rows[0], tradeDate: "2025-06-15" }] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: timestamp("2025-06-16") }] },
    { ...tickflow(), rows: [{ ...tickflow().rows[0], sourceTimestamp: timestamp("2025-06-17") }] },
    { ...sample(), rows: [{ ...rows[0], high: 3.95 }] }, { ...sample(), rows: [{ ...rows[0], amount: -1 }] },
    { ...sample(), observedAt: "2025-06-18T10:00:00Z" }, { ...sample(), requested: { start: "2023-01-01", end: "2025-06-18" } },
  ]) await expect(archiveDatedEtfDailyBars(batch as StoredDatedEtfDailyBatch)).rejects.toThrow("Invalid observation archive");
  await expect(archiveDatedEtfDailyBars(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(dir())).toBe(false);
});

test("rejects forged identities, unavailable revisions and corrupted bytes", async () => {
  const ref = await archiveDatedEtfDailyBars(sample());
  await expect(loadDatedEtfDailyArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  await expect(loadDatedEtfDailyArchive({ ...ref, revision: "../bad.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDatedEtfDailyArchive({ ...ref, revision: "e".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(dir(), ref.revision + ".json"), "{}");
  await expect(loadDatedEtfDailyArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

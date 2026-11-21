import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedIndexDailyBars, loadDatedIndexDailyArchive, type StoredDatedIndexDailyBatch } from "../index.ts";

const timestamp = (date: string) => Date.parse(date + "T15:00:00+08:00");
const sample = (): StoredDatedIndexDailyBatch => ({
  source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: "399001.SZ",
  requested: { start: "2024-02-28", end: "2024-02-29" }, observedAt: "2024-03-01T01:00:00Z", coverage: "unknown",
  interval: "1d", priceBasis: "index-level", priceUnit: "index-points",
  volumeUnit: "provider-native", amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native",
  rows: [
    { tradeDate: "2024-02-28", sourceTimestamp: timestamp("2024-02-28"), openPoints: 800, highPoints: 835,
      lowPoints: 798, closePoints: 830, volume: 0, amount: null },
    { tradeDate: "2024-02-29", sourceTimestamp: timestamp("2024-02-29"), openPoints: 830, highPoints: 865,
      lowPoints: 824, closePoints: 850, volume: 123, amount: 0 },
  ],
});

let root: string;
let prior: string | undefined;
beforeEach(() => {
  prior = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-index-daily-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});
const dir = () => join(root, "data", "dated-index-daily-archives-v1");

test("replays all native dated candles, including corrections and explicit empty observations", async () => {
  const [ref, repeat] = await Promise.all([archiveDatedIndexDailyBars(sample()), archiveDatedIndexDailyBars(sample())]);
  expect(ref.kind).toBe("dated-index-daily");
  expect(ref.version).toBe(1);
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(repeat).toEqual(ref);
  expect(await loadDatedIndexDailyArchive(ref)).toEqual(sample());
  const correction = sample();
  correction.rows[0]!.closePoints = 833;
  for (const batch of [correction, { ...sample(), rows: [] }, { ...sample(), observedAt: "2024-03-02T05:00:00Z" }]) {
    const next = await archiveDatedIndexDailyBars(batch);
    expect(next.revision).not.toBe(ref.revision);
    expect(await loadDatedIndexDailyArchive(next)).toEqual(batch);
  }
  expect(await loadDatedIndexDailyArchive(ref)).toEqual(sample());
});

test("rejects mismatched dates, timestamp identity and prices without an archive write", async () => {
  const { rows } = sample();
  for (const batch of [
    { ...sample(), rows: [...rows].reverse() }, { ...sample(), rows: [rows[0], rows[0]] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: timestamp("2024-02-29") }] },
    { ...sample(), rows: [{ ...rows[0], highPoints: 700 }] },
    { ...sample(), rows: [{ ...rows[0], amount: Infinity }] },
    { ...sample(), rows: [{ ...rows[0], volume: -1 }] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: Number.MAX_SAFE_INTEGER }] },
    { ...sample(), observedAt: "2024-02-29T14:00:00Z" },
    { ...sample(), requested: { start: "2023-01-01", end: "2024-02-29" } },
    { ...sample(), requested: { start: "2024-02-30", end: "2024-03-01" } },
    { ...sample(), symbol: "000001.SZ" }, { ...sample(), priceBasis: "forward-adjusted" },
  ]) {
    await expect(archiveDatedIndexDailyBars(batch as StoredDatedIndexDailyBatch)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveDatedIndexDailyBars(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(dir())).toBe(false);
});

test("rejects a forged or modified archive even when another revision exists", async () => {
  const ref = await archiveDatedIndexDailyBars(sample());
  await expect(loadDatedIndexDailyArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  await expect(loadDatedIndexDailyArchive({ ...ref, revision: "../new.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDatedIndexDailyArchive({ ...ref, revision: "e".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(dir(), ref.revision + ".json"), "{}");
  await expect(loadDatedIndexDailyArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

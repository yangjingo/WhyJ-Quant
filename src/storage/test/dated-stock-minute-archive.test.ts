import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedStockMinutes, loadDatedStockMinuteArchive, type StoredDatedStockMinuteBatch } from "../index.ts";

const tradeDate = "2024-04-08";
const stamp = (time: string) => Date.parse(`${tradeDate}T${time}+08:00`);
const sample = (): StoredDatedStockMinuteBatch => ({
  source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: "600000.SH", assetType: "stock", tradeDate,
  observedAt: "2024-04-09T03:00:00Z", coverage: "unknown", interval: "1m", adjustment: "none", priceUnit: "provider-native",
  volumeUnit: "provider-native", amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native", finality: "unknown",
  rows: [
    { sourceTimestamp: stamp("09:25:00"), open: 10, high: 11, low: 9, close: 10.5, volume: 0, amount: null },
    { sourceTimestamp: stamp("15:05:00"), open: 11, high: 12, low: 10, close: 11.5, volume: 42, amount: 0 },
  ],
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-dated-stock-minute-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "dated-stock-minute-archives-v1");

test("reopens the exact stock minute evidence and retains independent empty and amended revisions", async () => {
  const first = sample();
  const [ref, repeated] = await Promise.all([archiveDatedStockMinutes(first), archiveDatedStockMinutes(sample())]);
  expect(ref).toEqual({ version: 1, kind: "dated-stock-minute", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(repeated).toEqual(ref);
  const amended = sample();
  amended.rows[0]!.close = 10;
  for (const batch of [{ ...sample(), rows: [] }, { ...sample(), observedAt: "2024-04-10T03:00:00Z" }, amended]) {
    const another = await archiveDatedStockMinutes(batch);
    expect(another.revision).not.toBe(ref.revision);
    expect(await loadDatedStockMinuteArchive(another)).toEqual(batch);
  }
  expect(await loadDatedStockMinuteArchive(ref)).toEqual(first);
});

test("rejects incorrect stock and native minute metadata before writing an archive", async () => {
  const { rows } = sample();
  const cases = [
    { ...sample(), rows: rows.toReversed() }, { ...sample(), rows: [rows[0], rows[0]] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: stamp("09:24:59") }] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: stamp("15:05:01") }] },
    { ...sample(), rows: [{ ...rows[0], low: 0 }] }, { ...sample(), rows: [{ ...rows[0], close: 12 }] },
    { ...sample(), rows: [{ ...rows[0], volume: -1 }] }, { ...sample(), rows: [{ ...rows[0], amount: Infinity }] },
    { ...sample(), symbol: "399001.SZ" }, { ...sample(), symbol: "510300.SH" },
    { ...sample(), tradeDate: "2024-04-31" }, { ...sample(), observedAt: "2024-04-08T15:59:59Z" },
    { ...sample(), timestampLabel: "right-edge" }, { ...sample(), volumeUnit: "share" }, { ...sample(), finality: "final" },
  ];
  for (const batch of cases) await expect(archiveDatedStockMinutes(batch as StoredDatedStockMinuteBatch)).rejects.toThrow("Invalid observation archive");
  await expect(archiveDatedStockMinutes(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("rejects malformed, foreign, missing and damaged stock minute archive references", async () => {
  const ref = await archiveDatedStockMinutes(sample());
  await expect(loadDatedStockMinuteArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  await expect(loadDatedStockMinuteArchive({ ...ref, revision: "../archive.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDatedStockMinuteArchive({ ...ref, kind: "dated-index-minute" } as unknown as typeof ref)).rejects.toThrow("Invalid observation archive");
  await expect(loadDatedStockMinuteArchive({ ...ref, revision: "f".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadDatedStockMinuteArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

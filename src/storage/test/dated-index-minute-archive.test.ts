import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedIndexMinutes, loadDatedIndexMinuteArchive, type StoredDatedIndexMinuteBatch } from "../index.ts";

const stamp = (time: string) => Date.parse("2024-02-05T" + time + "+08:00");
const sample = (): StoredDatedIndexMinuteBatch => ({
  source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: "899050.BJ", tradeDate: "2024-02-05",
  observedAt: "2024-02-06T03:00:00Z", coverage: "unknown", interval: "1m", priceBasis: "index-level",
  priceUnit: "index-points", volumeUnit: "provider-native", amountUnit: "provider-native",
  timeZone: "Asia/Shanghai", timestampLabel: "provider-native",
  rows: [
    { sourceTimestamp: stamp("09:25:00"), openPoints: 815, highPoints: 822, lowPoints: 811, closePoints: 818, volume: 0, amount: null },
    { sourceTimestamp: stamp("15:05:00"), openPoints: 819, highPoints: 823, lowPoints: 815, closePoints: 821, volume: 182, amount: 987.3 },
  ],
});

let root: string;
let prior: string | undefined;
beforeEach(() => {
  prior = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-dated-index-minute-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "dated-index-minute-archives-v1");

test("persists exactly one native index minute response and deduplicates concurrent writes", async () => {
  const first = sample();
  const [ref, duplicate] = await Promise.all([archiveDatedIndexMinutes(first), archiveDatedIndexMinutes(sample())]);
  expect(ref).toEqual({ version: 1, kind: "dated-index-minute", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(duplicate).toEqual(ref);
  expect(await loadDatedIndexMinuteArchive(ref)).toEqual(first);

  const empty = { ...sample(), rows: [] };
  const recapture = { ...sample(), observedAt: "2024-02-07T03:00:00Z" };
  const correction = sample();
  correction.rows[0]!.closePoints = 817;
  for (const batch of [empty, recapture, correction]) {
    const next = await archiveDatedIndexMinutes(batch);
    expect(next.revision).not.toBe(ref.revision);
    expect(await loadDatedIndexMinuteArchive(next)).toEqual(batch);
  }
  expect(await loadDatedIndexMinuteArchive(ref)).toEqual(first);
});

test("rejects invalid identity, out-of-window or unordered bars, metadata and cancellation", async () => {
  const { rows } = sample();
  const cases = [
    { ...sample(), rows: [...rows].reverse() },
    { ...sample(), rows: [rows[0], rows[0]] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: stamp("09:24:59") }] },
    { ...sample(), rows: [{ ...rows[0], sourceTimestamp: stamp("15:05:01") }] },
    { ...sample(), rows: [{ ...rows[0], closePoints: 0 }] },
    { ...sample(), rows: [{ ...rows[0], highPoints: Infinity }] },
    { ...sample(), rows: [{ ...rows[0], volume: -1 }] },
    { ...sample(), rows: [{ ...rows[0], amount: -1 }] },
    { ...sample(), rows: [{ ...rows[0], normalized: true }] },
    { ...sample(), observedAt: "2024-02-05T15:59:59Z" },
    { ...sample(), symbol: "920001.BJ" },
    { ...sample(), tradeDate: "2024-02-30" },
    { ...sample(), endpoint: "/v1/intraday" },
    { ...sample(), priceBasis: "forward-adjusted" },
    { ...sample(), timestampLabel: "right-edge" },
  ];
  for (const batch of cases) {
    await expect(archiveDatedIndexMinutes(batch as StoredDatedIndexMinuteBatch)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveDatedIndexMinutes(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("reads only the exact digest and rejects malformed or damaged archives", async () => {
  const ref = await archiveDatedIndexMinutes(sample());
  await expect(loadDatedIndexMinuteArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  await expect(loadDatedIndexMinuteArchive({ ...ref, revision: "../index.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDatedIndexMinuteArchive({ ...ref, kind: "benchmark-index" } as unknown as typeof ref)).rejects.toThrow("Invalid observation archive");
  await expect(loadDatedIndexMinuteArchive({ ...ref, revision: "f".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadDatedIndexMinuteArchive(ref)).rejects.toThrow("Observation archive is damaged");
});
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveObservations, loadObservationArchive } from "../src/observation-archive.ts";
import type { StoredObservation } from "../../types/observation.ts";

let root: string; let old: string | undefined;
beforeEach(() => { old = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-observation-")); process.env.OHQUANT_DIR = root; });
afterEach(() => { if (old === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = old; rmSync(root, { recursive: true, force: true }); });
const base = { schemaVersion: 1, symbol: "600000.SH", timestamp: 1735689600000, market: "unknown", assetType: "unknown", timezone: "UTC", sourceAsOf: "unknown", source: "tickflow", endpoint: "/v1/klines", observedAt: "2025-01-01T00:00:01Z", units: "unknown", finality: "unknown", coverage: "unknown", revision: "unknown", quality: "unknown" } as const;
const daily = (): StoredObservation => ({ ...base, kind: "daily_bar", interval: "1d", adjustment: "none", values: { open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null } });
const minute = (): StoredObservation => ({ ...base, kind: "minute_bar", interval: "1m", adjustment: "forward", values: { open: 10, high: 12, low: 9, close: 11, volume: 0, amount: 0 } });
const factor = (): StoredObservation => ({ ...base, endpoint: "/v1/klines/ex-factors", kind: "adjustment_factor", factorBasis: "unknown", values: { factor: 1.25 } });

test("round trips daily, minute and factor batches with exact provenance and unknowns", async () => {
  for (const record of [daily(), minute(), factor()]) {
    const records = [record, { ...record, timestamp: record.timestamp + 1000 }];
    const ref = await archiveObservations(records);
    expect(await loadObservationArchive(ref)).toEqual(records);
  }
});

test("identical concurrent writes converge; corrections and observed metadata produce separate versions", async () => {
  const first = daily();
  const [a, b] = await Promise.all([archiveObservations([first]), archiveObservations([first])]);
  expect(a).toEqual(b);
  const reordered = { ...first, values: Object.fromEntries(Object.entries(first.values).reverse()) } as StoredObservation;
  expect(await archiveObservations([reordered])).toEqual(a);
  const corrected = { ...first, values: { ...first.values, close: 10 } } as StoredObservation;
  const later = { ...first, observedAt: "2025-01-01T00:00:02Z" };
  expect((await archiveObservations([corrected])).revision).not.toBe(a.revision);
  expect((await archiveObservations([later])).revision).not.toBe(a.revision);
  expect(await loadObservationArchive(a)).toEqual([first]);
});

test("rejects invalid, mixed, duplicated and unsafe data before writing", async () => {
  const first = daily();
  for (const rows of [[], [first, first], [first, minute()], [first, { ...first, symbol: "600001.SH" }],
    [{ ...first, symbol: "../evil" }], [{ ...first, endpoint: "/v1/klines?key=secret" }],
    [{ ...first, timestamp: NaN }], [{ ...first, observedAt: "2025-02-30T00:00:00Z" }],
    [{ ...first, values: { ...first.values, amount: undefined } }],
    [{ ...factor(), values: { factor: 0 } }]]) {
    await expect(archiveObservations(rows as StoredObservation[])).rejects.toThrow("Invalid observation archive");
  }
  await expect(loadObservationArchive({ version: 1, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadObservationArchive({ version: 1, revision: "a".repeat(64) })).rejects.toThrow();
});

test("damaged content is never substituted or overwritten by retry", async () => {
  const record = daily(); const ref = await archiveObservations([record]);
  const file = join(root, "data", "observation-archives-v1", `${ref.revision}.json`);
  writeFileSync(file, "{}");
  await expect(loadObservationArchive(ref)).rejects.toThrow("damaged");
  await expect(archiveObservations([record])).rejects.toThrow("damaged");
});

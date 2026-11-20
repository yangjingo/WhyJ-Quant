import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMoneyFlow, loadMoneyFlowArchive, type StoredMoneyFlowBatch } from "../index.ts";

function sample(): StoredMoneyFlowBatch {
  const bucket = { buyVolumeHand: 0, buyAmount: 0, sellVolumeHand: 14, sellAmount: 4.89 };
  const missing = { buyVolumeHand: null, buyAmount: null, sellVolumeHand: null, sellAmount: null };
  return {
    market: "A", source: "tushare", endpoint: "moneyflow", tradeDate: "2024-09-03",
    observedAt: "2024-09-03T09:30:00Z", coverage: "unknown", volumeUnit: "hand", amountUnit: "CNY-ten-thousand",
    rows: [
      { symbol: "600001.SH", small: bucket, medium: bucket, large: bucket, extraLarge: bucket, netVolumeHand: -2, netAmount: -1.23 },
      { symbol: "000001.SZ", small: missing, medium: missing, large: missing, extraLarge: missing, netVolumeHand: null, netAmount: null },
    ],
  };
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-money-flow-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "money-flow-archives-v1");

test("stores exact money flows, captures an empty response and preserves immutable revisions", async () => {
  const batch = sample();
  const [ref, duplicate] = await Promise.all([archiveMoneyFlow(batch), archiveMoneyFlow(sample())]);
  expect(ref).toEqual(duplicate);
  expect(ref.version).toBe(1);
  expect(ref.kind).toBe("dated-money-flow");
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadMoneyFlowArchive(ref)).toEqual(batch);

  const corrected = sample();
  corrected.rows[0]!.netAmount = 5.01;
  for (const capture of [corrected, { ...sample(), rows: [] }, { ...sample(), observedAt: "2024-09-03T10:30:00Z" }]) {
    const next = await archiveMoneyFlow(capture);
    expect(next.revision).not.toBe(ref.revision);
    expect(await loadMoneyFlowArchive(next)).toEqual(capture);
  }
  expect(await loadMoneyFlowArchive(ref)).toEqual(batch);
});

test("rejects invalid observations before writing any archive", async () => {
  const original = sample();
  const row = original.rows[0]!;
  const invalid = [
    { ...original, tradeDate: "2024-09-04" },
    { ...original, tradeDate: "2009-12-31" },
    { ...original, amountUnit: "CNY" },
    { ...original, endpoint: "moneyflow_ths" },
    { ...original, rows: [row, row] },
    { ...original, rows: [{ ...row, symbol: "920001.BJ" }] },
    { ...original, rows: [{ ...row, symbol: "000001.SH" }] },
    { ...original, rows: [{ ...row, netVolumeHand: 0.25 }] },
    { ...original, rows: [{ ...row, netAmount: Infinity }] },
    { ...original, rows: [{ ...row, large: { ...row.large, buyAmount: -0.01 } }] },
    { ...original, rows: [{ ...row, large: { ...row.large, sellVolumeHand: -2 } }] },
    { ...original, rows: Array.from({ length: 6000 }, (_, i) => ({ ...row, symbol: (601000 + i) + ".SH" })) },
  ];
  for (const batch of invalid) {
    await expect(archiveMoneyFlow(batch as StoredMoneyFlowBatch)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveMoneyFlow(original, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("rejects a corrupt archive, a missing valid revision and a mismatched reference", async () => {
  const ref = await archiveMoneyFlow(sample());
  await expect(loadMoneyFlowArchive({ ...ref, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadMoneyFlowArchive({ ...ref, revision: "0".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(loadMoneyFlowArchive({ ...ref, kind: "market-cross-section" } as unknown as typeof ref))
    .rejects.toThrow("Invalid observation archive");
  await expect(loadMoneyFlowArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadMoneyFlowArchive(ref)).rejects.toThrow("Observation archive is damaged");
  await expect(archiveMoneyFlow(sample())).rejects.toThrow("Observation archive is damaged");
});

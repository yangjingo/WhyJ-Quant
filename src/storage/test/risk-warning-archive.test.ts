import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRiskWarningObservations, loadRiskWarningArchive, type StoredRiskWarningBatch } from "../index.ts";

const sample = (): StoredRiskWarningBatch => ({
  market: "A", source: "tushare", endpoint: "stock_st", tradeDate: "2024-09-03",
  observedAt: "2024-09-02T17:30:00Z", coverage: "unknown",
  rows: [
    { symbol: "000001.SZ", name: "*ST 样本甲", type: "ST", typeName: "风险警示板" },
    { symbol: "600001.SH", name: "样本乙", type: "OTHER", typeName: "其他分类" },
    { symbol: "600001.SH", name: "样本乙", type: "ST", typeName: "风险警示板" },
  ],
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-risk-warning-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "risk-warning-archives-v1");

test("replays exact risk observations, including independent corrections and empty responses", async () => {
  const input = sample();
  const [ref, duplicate] = await Promise.all([archiveRiskWarningObservations(input), archiveRiskWarningObservations(sample())]);
  expect(ref).toEqual(duplicate);
  expect(ref.kind).toBe("dated-risk-warnings");
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadRiskWarningArchive(ref)).toEqual(input);
  const corrected = sample();
  corrected.rows[0]!.typeName = "更正分类";
  for (const batch of [corrected, { ...sample(), rows: [] }, { ...sample(), observedAt: "2024-09-03T01:35:00Z" }]) {
    const next = await archiveRiskWarningObservations(batch);
    expect(next.revision).not.toBe(ref.revision);
    expect(await loadRiskWarningArchive(next)).toEqual(batch);
  }
  expect(await loadRiskWarningArchive(ref)).toEqual(input);
});

test("rejects invalid batch scope, saturated responses, duplicate types and cancelled writes", async () => {
  const repeated = sample();
  repeated.rows.push({ ...repeated.rows[0]!, typeName: "重复分类" });
  const badIndex = sample();
  badIndex.rows[0]!.symbol = "899050.BJ";
  const saturated = { ...sample(), rows: Array.from({ length: 1000 }, (_, i) =>
    ({ ...sample().rows[0]!, symbol: `${600100 + i}.SH` })) };
  for (const batch of [repeated, badIndex, saturated, { ...sample(), tradeDate: "2024-09-04" },
    { ...sample(), tradeDate: "1999-12-31" }, { ...sample(), observedAt: "2024-09-31T17:30:00Z" }]) {
    await expect(archiveRiskWarningObservations(batch)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveRiskWarningObservations(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("requires an exact kind and digest on replay", async () => {
  const ref = await archiveRiskWarningObservations(sample());
  await expect(loadRiskWarningArchive({ ...ref, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadRiskWarningArchive({ ...ref, kind: "market-cross-section" } as unknown as typeof ref))
    .rejects.toThrow("Invalid observation archive");
  await expect(loadRiskWarningArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadRiskWarningArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

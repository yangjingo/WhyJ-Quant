import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatedPopularityList } from "../../types/popularity.ts";
import { archivePopularityList, loadPopularityArchive } from "../index.ts";

function sample(): DatedPopularityList {
  return {
    source: "fuyao", endpoint: "/api/a-share/special-data/hot-stock-list-history", market: "A",
    calendarDate: "2026-06-21", calendarTimeZone: "Asia/Shanghai", calendarDateTimestamp: 1_781_971_200_000,
    observedAt: "2026-06-22T08:00:00Z", coverage: "unknown",
    rows: [
      { symbol: "600519.SH", ticker: "600519", name: "Sample 1", rank: 8 },
      { symbol: "000725.SZ", ticker: "000725", name: "Sample 2", rank: 1 },
    ],
  };
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-popularity-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const directory = () => join(root, "data", "popularity-archives-v1");

test("round-trips the original ranks and calendar metadata across empty and revised captures", async () => {
  const original = sample();
  const [ref, duplicate] = await Promise.all([archivePopularityList(original), archivePopularityList(sample())]);
  expect(ref).toEqual(duplicate);
  expect(ref.kind).toBe("dated-popularity-list");
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadPopularityArchive(ref)).toEqual(original);

  const revised = sample();
  revised.rows[0]!.rank = 4;
  for (const capture of [revised, { ...sample(), rows: [] }, { ...sample(), observedAt: "2026-06-22T08:01:00Z" }]) {
    const next = await archivePopularityList(capture);
    expect(next.revision).not.toBe(ref.revision);
    expect(await loadPopularityArchive(next)).toEqual(capture);
  }
  expect(await loadPopularityArchive(ref)).toEqual(original);
});

test("rejects invalid observation dates, identities and ranks before writing", async () => {
  const batch = sample();
  const row = batch.rows[0]!;
  for (const invalid of [
    { ...batch, calendarDate: "2026-06-20" },
    { ...batch, calendarDateTimestamp: batch.calendarDateTimestamp + 1000 },
    { ...batch, observedAt: "2026-06-20T15:59:59Z" },
    { ...batch, rows: [row, row] },
    { ...batch, rows: [{ ...row, symbol: "000001.SH", ticker: "000001" }] },
    { ...batch, rows: [{ ...row, ticker: "020200" }] },
    { ...batch, rows: [{ ...row, rank: 0 }] },
    { ...batch, rows: [{ ...row, rank: 1.2 }] },
    { ...batch, rows: Array.from({ length: 31 }, (_, i) => {
      const ticker = String(600000 + i);
      return { ...row, symbol: ticker + ".SH", ticker, rank: i + 1 };
    }) },
  ]) {
    await expect(archivePopularityList(invalid)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archivePopularityList(batch, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(directory())).toBe(false);
});

test("rejects wrong-kind, missing and damaged revisions", async () => {
  const ref = await archivePopularityList(sample());
  await expect(loadPopularityArchive({ ...ref, kind: "dated-money-flow" } as unknown as typeof ref)).rejects.toThrow("Invalid observation archive");
  await expect(loadPopularityArchive({ ...ref, revision: "0".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(loadPopularityArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(directory(), ref.revision + ".json"), "{}");
  await expect(loadPopularityArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

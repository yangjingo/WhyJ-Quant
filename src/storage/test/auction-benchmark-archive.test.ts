import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAuctionBenchmark, loadAuctionBenchmarkArchive, type StoredAuctionBenchmark } from "../index.ts";

const sample = (): StoredAuctionBenchmark => ({
  source: "fuyao", endpoint: "/api/a-share/auction/short-term-benchmark", market: "A", tradeDate: "2026-08-14",
  calendarTimeZone: "Asia/Shanghai", tradeDateTimestamp: Date.parse("2026-08-14T00:00:00+08:00"),
  responseAssembledAt: Date.parse("2026-08-14T09:26:01+08:00"), observedAt: "2026-08-14T01:26:05.000Z",
  coverage: "unknown", returnUnit: "percentage-points",
  rows: [
    { symbol: "600519.SH", name: "示例 A", auctionReturnPct: 0, tags: ["换手", "放量"] },
    { symbol: "000858.SZ", name: "示例 B", auctionReturnPct: null, tags: [] },
  ],
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-auction-benchmark-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "auction-benchmark-archives-v1");

test("retains provider order, empty lists, and independent capture revisions", async () => {
  const [first, duplicate] = await Promise.all([archiveAuctionBenchmark(sample()), archiveAuctionBenchmark(sample())]);
  expect(first).toEqual({ version: 1, kind: "auction-benchmark", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(duplicate).toEqual(first);
  expect(await loadAuctionBenchmarkArchive(first)).toEqual(sample());
  const reversed = { ...sample(), rows: sample().rows.reverse() };
  const recapture = { ...sample(), observedAt: "2026-08-14T01:28:05.000Z" };
  for (const batch of [reversed, recapture, { ...sample(), rows: [] }]) {
    const ref = await archiveAuctionBenchmark(batch);
    expect(ref.revision).not.toBe(first.revision);
    expect(await loadAuctionBenchmarkArchive(ref)).toEqual(batch);
  }
  expect(await loadAuctionBenchmarkArchive(first)).toEqual(sample());
});

test("rejects invalid capture and row identity before writing", async () => {
  const mismatch = sample(), duplicate = sample(), extra = sample(), nonfinite = sample(), tags = sample();
  mismatch.rows[0]!.symbol = "000001.SH";
  duplicate.rows.push(duplicate.rows[0]!);
  Object.assign(extra.rows[0]!, { nextDayReturn: 0.05 });
  nonfinite.rows[0]!.auctionReturnPct = NaN;
  tags.rows[0]!.tags = new Array<string>(1);
  for (const batch of [mismatch, duplicate, extra, nonfinite, tags,
    { ...sample(), tradeDate: "2026-08-13" },
    { ...sample(), responseAssembledAt: 0 },
    { ...sample(), observedAt: "2026-02-30T01:26:05.000Z" },
  ]) {
    await expect(archiveAuctionBenchmark(batch)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveAuctionBenchmark(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("checks strict archive kind, revision, and bytes before replay", async () => {
  const ref = await archiveAuctionBenchmark(sample());
  await expect(loadAuctionBenchmarkArchive({ ...ref, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadAuctionBenchmarkArchive({ ...ref, kind: "benchmark-index" } as unknown as typeof ref))
    .rejects.toThrow("Invalid observation archive");
  await expect(loadAuctionBenchmarkArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(archiveDir(), ref.revision + ".json"), "{}");
  await expect(loadAuctionBenchmarkArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

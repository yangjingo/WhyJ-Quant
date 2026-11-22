import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveQuotePollCapture, loadQuotePollArchive, type StoredQuotePollCapture } from "../index.ts";

const timestamp = Date.parse("2025-01-03T01:34:00Z");
const capture: StoredQuotePollCapture = {
  market: "A", source: "tickflow", endpoint: "/v1/quotes", tradeDate: "2025-01-03",
  startedAt: "2025-01-03T01:34:01Z", observedAt: "2025-01-03T01:34:03Z", coverage: "unknown", units: "unknown",
  requestedSymbols: ["600001.SH", "600002.SH", "600003.SH"],
  rows: [
    { symbol: "600001.SH", timestamp, receivedAt: "2025-01-03T01:34:02Z", lastPrice: 9.45, previousClose: 9.3, volume: 0, amount: 0 },
    { symbol: "600002.SH", timestamp, receivedAt: "2025-01-03T01:34:03Z", lastPrice: 0, previousClose: 10, volume: 400, amount: null },
  ],
};

let root: string, prior: string | undefined;
const directory = () => join(root, "data", "quote-poll-archives-v1");
beforeEach(() => {
  prior = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-quote-poll-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

test("reopens immutable captures with the receipt timestamps, explicit zeros and null amounts", async () => {
  const identities = await Promise.all([archiveQuotePollCapture(capture), archiveQuotePollCapture(capture)]);
  const ref = identities[0]!;
  expect(identities[1]).toEqual(ref);
  expect(ref).toMatchObject({ version: 1, kind: "quote-poll" });
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadQuotePollArchive(ref)).toEqual(capture);
  const later = { ...capture, observedAt: "2025-01-03T01:34:04Z" };
  const revised = { ...capture, rows: [{ ...capture.rows[0]!, volume: 1 }, capture.rows[1]!] };
  const empty = { ...capture, rows: [] };
  const newRefs = await Promise.all([later, revised, empty].map(item => archiveQuotePollCapture(item)));
  expect(new Set([ref.revision, ...newRefs.map(item => item.revision)]).size).toBe(4);
  expect(await Promise.all(newRefs.map(item => loadQuotePollArchive(item)))).toEqual([later, revised, empty]);
  expect(await loadQuotePollArchive(ref)).toEqual(capture);
});

test("rejects impossible timing, repeated identities, unsupported units and non-finite counters", async () => {
  const row = capture.rows[0]!;
  const invalid = [
    { ...capture, startedAt: "2025-01-02T01:34:01Z" },
    { ...capture, observedAt: "2025-01-03T01:34:00Z" },
    { ...capture, requestedSymbols: ["600001.SH", "600001.SH"] },
    { ...capture, requestedSymbols: ["899050.BJ"] },
    { ...capture, units: "share" },
    { ...capture, rows: [row, row] },
    { ...capture, rows: [{ ...row, symbol: "600004.SH" }] },
    { ...capture, rows: [{ ...row, timestamp: timestamp - 86_400_000 }] },
    { ...capture, rows: [{ ...row, timestamp: Date.parse(row.receivedAt) + 1 }] },
    { ...capture, rows: [{ ...row, receivedAt: "2025-01-03T01:34:04Z" }] },
    { ...capture, rows: [{ ...row, amount: Infinity }] },
    { ...capture, rows: [{ ...row, volume: -1 }] },
  ];
  for (const item of invalid) {
    await expect(archiveQuotePollCapture(item as StoredQuotePollCapture)).rejects.toThrow("Invalid observation archive");
  }
  await expect(archiveQuotePollCapture(capture, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(directory())).toBe(false);
});

test("rejects missing, damaged and malformed references", async () => {
  const ref = await archiveQuotePollCapture(capture);
  await expect(loadQuotePollArchive({ ...ref, revision: "f".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(loadQuotePollArchive({ ...ref, revision: "../other.json" })).rejects.toThrow("Invalid observation archive");
  await expect(loadQuotePollArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(directory(), ref.revision + ".json"), "{}");
  await expect(loadQuotePollArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

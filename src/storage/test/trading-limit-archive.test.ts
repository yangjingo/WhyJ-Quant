import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, loadDailyTradingLimitArchive, loadTradingDateArchive } from "../index.ts";
import type { StoredDailyTradingLimitBatch, TradingLimitArchiveRef } from "../index.ts";
import { withFileLockAsync } from "../src/atomic-file.ts";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-daily-limits-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const fixture = (): StoredDailyTradingLimitBatch => ({
  symbol: "600000.SH", market: "A", source: "tushare", endpoint: "stk_limit", observedAt: "2024-01-05T09:00:00Z",
  coverage: "unknown", priceUnit: "CNY", requested: { startDate: "2024-01-02", endDate: "2024-01-04" },
  rows: [
    { tradeDate: "2024-01-02", previousClose: 10, limitUp: 11, limitDown: 9 },
    { tradeDate: "2024-01-04", previousClose: 12, limitUp: null, limitDown: null },
  ],
});
const diskPath = (ref: TradingLimitArchiveRef) => join(root, "data", "trading-limit-archives-v1", `${ref.revision}.json`);

test("concurrent identical limit observations converge and revisions remain independently replayable", async () => {
  const input = fixture();
  const [a, b] = await Promise.all([archiveDailyTradingLimits(input), archiveDailyTradingLimits(input)]);
  expect(a).toEqual(b);
  expect(a.version).toBe(1);
  expect(a.kind).toBe("daily-trading-limits");
  expect(a.revision).toMatch(/^[a-f0-9]{64}$/);
  const reorderedKeys = { ...input, rows: input.rows.map(({ tradeDate, limitDown, previousClose, limitUp }) =>
    ({ previousClose, limitDown, limitUp, tradeDate })) };
  expect(await archiveDailyTradingLimits(reorderedKeys)).toEqual(a);
  const corrected = fixture();
  corrected.rows[0]!.limitUp = 11.1;
  const c = await archiveDailyTradingLimits(corrected);
  expect(c.revision).not.toBe(a.revision);
  expect(await loadDailyTradingLimitArchive(a)).toEqual(input);
  expect(await loadDailyTradingLimitArchive(c)).toEqual(corrected);
});

test("rejects foreign types, malformed data, bad dates, invalid references and corruption", async () => {
  const input = fixture();
  const invalid = [
    { ...input, symbol: "899050.BJ" }, { ...input, source: "tickflow" }, { ...input, endpoint: "stk_limit?token=example" },
    { ...input, observedAt: "2024-02-30T00:00:00Z" }, { ...input, rows: [] },
    { ...input, rows: [input.rows[0], input.rows[0]] }, { ...input, rows: input.rows.toReversed() },
    { ...input, rows: [{ ...input.rows[0], tradeDate: "2024-01-05" }] },
    { ...input, rows: [{ ...input.rows[0], limitDown: 12 }] }, { ...input, rows: [{ ...input.rows[0], limitUp: 0 }] },
  ];
  for (const batch of invalid) {
    await expect(archiveDailyTradingLimits(batch as StoredDailyTradingLimitBatch)).rejects.toThrow("Invalid observation archive");
  }
  const ref = await archiveDailyTradingLimits(input);
  await expect(loadDailyTradingLimitArchive({ ...ref, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDailyTradingLimitArchive({ ...ref, version: 2 } as never)).rejects.toThrow("Invalid observation archive");
  await expect(loadDailyTradingLimitArchive({ ...ref, revision: "a".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(loadTradingDateArchive(ref as never)).rejects.toThrow("Invalid observation archive");
  writeFileSync(diskPath(ref), "{}");
  await expect(loadDailyTradingLimitArchive(ref)).rejects.toThrow("damaged");
  await expect(archiveDailyTradingLimits(input)).rejects.toThrow("damaged");
});

test("cancellation while another writer holds the lease cannot publish an archive", async () => {
  const batch = fixture();
  const ref = await archiveDailyTradingLimits(batch);
  const target = diskPath(ref);
  unlinkSync(target);
  const abort = new AbortController();
  const reason = new Error("cancel limit collection");
  await withFileLockAsync(target, async () => {
    const pending = archiveDailyTradingLimits(batch, abort.signal);
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(existsSync(target)).toBe(false);
  });
  expect(await archiveDailyTradingLimits(batch)).toEqual(ref);
});

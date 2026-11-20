import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatedDragonTigerBoard, DragonTigerStockRow } from "../../types/dragon-tiger.ts";
import { archiveDragonTigerBoard, loadDragonTigerArchive, type DragonTigerArchiveRef } from "../index.ts";

const stock = (rangeDays: 1 | 3, netValueCny: number | null): DragonTigerStockRow => ({
  symbol: "002407.SZ", ticker: "002407", name: "Fixture", conceptNames: ["Example", null], rangeDays, changeFraction: 0.02,
  netValueCny, netRate: 0, hotRank: 0, buyValueCny: null, sellValueCny: null, limitReason: null, institutionalNetValueCny: null,
  institutionalNetRate: null, institutionalBuyCount: null, institutionalSellCount: null, amountCny: null,
  hotMoneyNetValueCny: null, hotMoneyNetRate: null, seatNetValueCny: null, seatNetRate: null,
});
const sample = (): DatedDragonTigerBoard => ({
  source: "fuyao", endpoint: "/api/a-share/special-data/dragon-tiger-list", market: "A", tradeDate: "2026-07-01",
  boardKind: "all", providerTimestamp: 1_782_921_600_000, observedAt: "2026-07-01T09:00:00Z", calendarTimeZone: "Asia/Shanghai",
  coverage: "unknown", amountUnit: "CNY", ratioUnit: "fraction", providerRecordCount: 3, providerStockCount: 1,
  stocks: [stock(1, 0), stock(3, null)], seats: [],
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-dragon-tiger-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const archiveDir = () => join(root, "data", "dragon-tiger-archives-v1");

test("commits and reopens exact ordered captures for all three boards", async () => {
  const [first, duplicate] = await Promise.all([archiveDragonTigerBoard(sample()), archiveDragonTigerBoard(sample())]);
  expect(first).toEqual({ version: 1, kind: "dragon-tiger-board", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(duplicate).toEqual(first);
  expect(await loadDragonTigerArchive(first)).toEqual(sample());
  const reversed = { ...sample(), stocks: sample().stocks.reverse() };
  const recapture = { ...sample(), observedAt: "2026-07-01T09:15:00Z" };
  const institutions = { ...sample(), boardKind: "org" as const, stocks: [] };
  const seats = { ...sample(), boardKind: "hot_money" as const, stocks: [], seats: [
    { name: "Seat", netValueCny: -25, stocks: [stock(1, 0), stock(3, null)] },
    { name: null, netValueCny: null, stocks: null },
  ] };
  for (const batch of [reversed, recapture, institutions, seats]) {
    const ref = await archiveDragonTigerBoard(batch);
    expect(ref.revision).not.toBe(first.revision);
    expect(await loadDragonTigerArchive(ref)).toEqual(batch);
  }
  expect(await loadDragonTigerArchive(first)).toEqual(sample());
});

test("rejects wrong shape, invalid nested records and cancellation before writing", async () => {
  const extra = sample(), badTicker = sample(), amount = sample(), range = sample();
  Object.assign(extra.stocks[0]!, { rank: 1 });
  badTicker.stocks[0]!.ticker = "300001";
  amount.stocks[0]!.netValueCny = Infinity;
  Object.assign(range.stocks[0]!, { rangeDays: 2 });
  for (const malformed of [extra, badTicker, amount, range,
    { ...sample(), boardKind: "hot_money" as const },
    { ...sample(), seats: [{ name: null, netValueCny: 0, stocks: [] }] },
    { ...sample(), tradeDate: "2026-02-30" },
    { ...sample(), providerStockCount: -1 },
  ]) await expect(archiveDragonTigerBoard(malformed)).rejects.toThrow("Invalid observation archive");
  await expect(archiveDragonTigerBoard(sample(), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(archiveDir())).toBe(false);
});

test("checks the reference kind and digest independently of the requested trade date", async () => {
  const ref = await archiveDragonTigerBoard(sample());
  await expect(loadDragonTigerArchive({ ...ref, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadDragonTigerArchive({ ...ref, kind: "benchmark-index" } as unknown as DragonTigerArchiveRef))
    .rejects.toThrow("Invalid observation archive");
  await expect(loadDragonTigerArchive(ref, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  writeFileSync(join(archiveDir(), `${ref.revision}.json`), "{}");
  await expect(loadDragonTigerArchive(ref)).rejects.toThrow("Observation archive is damaged");
});

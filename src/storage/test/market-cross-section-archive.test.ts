import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, loadMarketCrossSectionArchive, type StoredMarketCrossSection } from "../index.ts";

const tradeDate = "2024-01-02";
const sourceMeta = { tradeDate, coverage: "unknown" } as const;
const sample = (): StoredMarketCrossSection => ({
  source: "tushare", market: "A", tradeDate,
  universe: { ...sourceMeta, endpoint: "bak_basic", observedAt: "2024-01-03T00:00:01Z",
    universe: "provider-dated-stocks", members: [
      { symbol: "000001.SZ", name: "样本 A", industry: null, listedOn: "1991-04-03" },
      { symbol: "600000.SH", name: "样本 B", industry: "Bank", listedOn: null },
    ] },
  bars: { ...sourceMeta, endpoint: "daily", observedAt: "2024-01-03T00:00:02Z",
    adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [
      { symbol: "000001.SZ", open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: 10,
        changeCny: 0, returnPct: 0, volume: 0, amount: 0 },
      { symbol: "600001.SH", open: 8, high: 9, low: 8, close: 9, exRightsPreviousClose: null,
        changeCny: null, returnPct: null, volume: 0.5, amount: null },
    ] },
  basics: { ...sourceMeta, endpoint: "daily_basic", observedAt: "2024-01-03T00:00:03Z",
    priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [
      { symbol: "000001.SZ", close: 10, turnoverPct: 0, freeFloatTurnoverPct: null, providerVolumeRatio: null,
        totalShares: 400, floatShares: 200, freeFloatShares: 100, pe: -1, peTtm: null, pb: null,
        totalMarketValue: 4_000, circulatingMarketValue: 2_000 },
    ] },
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-market-section-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("keeps each dated observation and captures provider corrections without replacing earlier revisions", async () => {
  const input = sample();
  const [first, duplicate] = await Promise.all([archiveMarketCrossSection(input), archiveMarketCrossSection(sample())]);
  expect(first.version).toBe(1);
  expect(first.kind).toBe("market-cross-section");
  expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(duplicate).toEqual(first);
  expect(await loadMarketCrossSectionArchive(first)).toEqual(input);
  const corrected = sample();
  corrected.basics.rows[0]!.turnoverPct = 0.25;
  const second = await archiveMarketCrossSection(corrected);
  expect(second.revision).not.toBe(first.revision);
  expect(await loadMarketCrossSectionArchive(first)).toEqual(input);
  expect(await loadMarketCrossSectionArchive(second)).toEqual(corrected);
  const empty = sample();
  empty.bars.rows = [];
  empty.basics.rows = [];
  expect(await loadMarketCrossSectionArchive(await archiveMarketCrossSection(empty))).toEqual(empty);
});

test("rejects inconsistent dates, observation metadata, invalid values and duplicate identifiers", async () => {
  const mixedDates = sample(), futureDate = sample(), dup = sample(), futureListed = sample(), invalidUnits = sample(),
    invalidNumber = sample(), invalidBar = sample(), extraField = sample();
  mixedDates.basics.tradeDate = "2024-01-03";
  futureDate.universe.observedAt = "2024-01-01T00:00:00Z";
  dup.bars.rows.push(dup.bars.rows.at(-1)!);
  futureListed.universe.members[0]!.listedOn = "2024-01-03";
  Object.assign(invalidUnits.bars, { volumeUnit: "share" });
  invalidNumber.basics.rows[0]!.pe = Infinity;
  invalidBar.bars.rows[0]!.low = 11;
  Object.assign(extraField.universe.members[0]!, { signal: true });
  for (const bad of [mixedDates, futureDate, dup, futureListed, invalidUnits, invalidNumber, invalidBar, extraField]) {
    await expect(archiveMarketCrossSection(bad)).rejects.toThrow("Invalid observation archive");
  }
  const cancelled = AbortSignal.abort();
  await expect(archiveMarketCrossSection(sample(), cancelled)).rejects.toThrow();
  expect(existsSync(join(root, "data", "market-cross-section-archives-v1"))).toBe(false);
});

test("rejects forged references and corrupted bytes independently of other revisions", async () => {
  const first = await archiveMarketCrossSection(sample());
  const other = sample();
  other.basics.rows = [];
  const second = await archiveMarketCrossSection(other);
  await expect(loadMarketCrossSectionArchive({ ...first, revision: "../private" })).rejects.toThrow("Invalid observation archive");
  await expect(loadMarketCrossSectionArchive({ ...first, revision: "f".repeat(64) })).rejects.toThrow();
  await expect(loadMarketCrossSectionArchive(first, AbortSignal.abort())).rejects.toThrow();
  writeFileSync(join(root, "data", "market-cross-section-archives-v1", first.revision + ".json"), "{}");
  await expect(loadMarketCrossSectionArchive(first)).rejects.toThrow("Observation archive is damaged");
  expect(await loadMarketCrossSectionArchive(second)).toEqual(other);
});

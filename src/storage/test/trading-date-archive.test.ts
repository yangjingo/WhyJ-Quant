import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toTradingDateBarObservations } from "../../source/index.ts";
import type { TradingDateKlineResult } from "../../source/index.ts";
import { archiveObservations, loadObservationArchive, archiveTradingDateObservations, loadTradingDateArchive } from "../index.ts";
import type { StoredTradingDateBarObservation } from "../../types/observation.ts";

let root: string; let previous: string | undefined;
beforeEach(() => { previous = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-dated-")); process.env.OHQUANT_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
const sourceResult = (): TradingDateKlineResult => ({ timeMode: "trading-date", symbol: "600000.SH", market: "A", assetType: "stock",
  calendarTimeZone: "Asia/Shanghai", requested: { startDate: "2024-01-02", endDate: "2024-01-03" }, interval: "1d", adjustment: "none",
  source: "tushare", endpoint: "daily", observedAt: "2024-01-05T00:00:00.000Z", coverage: "unknown", volumeUnit: "hand", amountUnit: "CNY-thousand",
  data: [{ tradeDate: "2024-01-02", sourceTimestamp: null, open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null }] });

test("Source dated batches round trip with exact units and source timestamps", async () => {
  const input = sourceResult();
  const tick = { ...input, source: "tickflow" as const, endpoint: "/v1/klines", volumeUnit: "unknown" as const, amountUnit: "unknown" as const,
    data: [{ ...input.data[0]!, sourceTimestamp: Date.parse("2024-01-01T16:00:00Z") }] };
  for (const result of [input, tick]) {
    const rows = toTradingDateBarObservations(result);
    const [a, b] = await Promise.all([archiveTradingDateObservations(rows), archiveTradingDateObservations(rows)]);
    expect(a).toEqual(b);
    expect(a.version).toBe(2);
    expect(await loadTradingDateArchive(a)).toEqual(rows);
  }
});

test("rejects invalid and mixed dated records before writing", async () => {
  const row = toTradingDateBarObservations(sourceResult())[0]!;
  const tick = { ...row, source: "tickflow", endpoint: "/v1/klines", volumeUnit: "unknown", amountUnit: "unknown", sourceTimestamp: Date.parse("2024-01-01T15:59:59Z") };
  for (const records of [[], [row, row], [row, { ...row, tradeDate: "2024-01-03", symbol: "600001.SH" }],
    [{ ...row, sourceTimestamp: 1 }], [{ ...row, volumeUnit: "unknown" }], [{ ...row, requested: { ...row.requested, endDate: "2024-02-30" } }],
    [{ ...row, values: { ...row.values, close: 13 } }], [tick], [{ ...row, extra: true }]]) {
    await expect(archiveTradingDateObservations(records as StoredTradingDateBarObservation[])).rejects.toThrow("Invalid observation archive");
  }
  await expect(loadTradingDateArchive({ version: 2, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadTradingDateArchive({ version: 2, revision: "a".repeat(64) })).rejects.toThrow();
  await expect(loadTradingDateArchive({ version: 1, revision: "a".repeat(64) } as never)).rejects.toThrow("Invalid observation archive");
});

test("damaged dated archives fail without replacement", async () => {
  const rows = toTradingDateBarObservations(sourceResult());
  const ref = await archiveTradingDateObservations(rows);
  writeFileSync(join(root, "data", "observation-archives-v2", `${ref.revision}.json`), "{}");
  await expect(loadTradingDateArchive(ref)).rejects.toThrow("damaged");
  await expect(archiveTradingDateObservations(rows)).rejects.toThrow("damaged");
});

test("v1 bytes and reference remain stable alongside a v2 archive", async () => {
  const v1 = { schemaVersion: 1, kind: "daily_bar", symbol: "600000.SH", timestamp: 1735689600000,
    market: "unknown", assetType: "unknown", timezone: "UTC", sourceAsOf: "unknown", source: "tickflow",
    endpoint: "/v1/klines", observedAt: "2025-01-01T00:00:01Z", units: "unknown", finality: "unknown",
    coverage: "unknown", revision: "unknown", quality: "unknown", interval: "1d", adjustment: "none",
    values: { open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null } } as const;
  const ref = await archiveObservations([v1]);
  expect(ref).toEqual({ version: 1, revision: "4aee4e1675ec4bd31d679370ab5d518be1a9a88a09476e786008e3e528395a4b" });
  await archiveTradingDateObservations(toTradingDateBarObservations(sourceResult()));
  expect(await loadObservationArchive(ref)).toEqual([v1]);
});

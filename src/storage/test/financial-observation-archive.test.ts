import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFinancialObservations, loadFinancialObservationArchive, loadHistoricalMinuteArchive,
  type StoredFinancialObservationBatch } from "../index.ts";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-financial-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const periodEnd = "2024-12-31";
const identity = { symbol: "600000.SH", market: "A", source: "tushare", coverage: "unknown" } as const;
const reportRow = {
  periodEnd, announcementDate: "2025-04-29", updateFlag: "1", bookValuePerShare: 12.3, bookValueCurrency: "unknown",
  roe: null, grossProfitMargin: 0, netProfitMargin: 5.2, operatingRevenueYoyPct: 6.8, totalOperatingRevenueYoyPct: 8.2,
  parentNetProfitYoyPct: -1, debtToAssets: 62, ratioUnit: "provider-native",
} as const;
const indicators = (): Extract<StoredFinancialObservationBatch, { endpoint: "fina_indicator" }> => ({
  ...identity, endpoint: "fina_indicator", observedAt: "2025-05-02T12:30:01Z", requested: { startPeriod: "2024-01-01", endPeriod: periodEnd },
  rows: [reportRow, { ...reportRow, updateFlag: "0", announcementDate: "2025-04-28", bookValuePerShare: 12 }],
});
const disclosure = (): Extract<StoredFinancialObservationBatch, { endpoint: "disclosure_date" }> => ({
  ...identity, endpoint: "disclosure_date", observedAt: "2025-05-02T12:30:07Z", requested: { periodEnd },
  rows: [{ periodEnd, planAnnouncementDate: "2025-03-01", plannedDisclosureDate: "2025-04-26",
    actualDisclosureDate: null, modificationRecord: "20250425,20250426" }],
});

test("financial archives retain independent observations, repeated periods and row order", async () => {
  const report = indicators();
  const dates = disclosure();
  const [original, same, schedule] = await Promise.all([
    archiveFinancialObservations(report), archiveFinancialObservations(report), archiveFinancialObservations(dates),
  ]);
  expect(original).toEqual(same);
  expect(original.kind).toBe("report-financial-indicators");
  expect(schedule.kind).toBe("financial-disclosure-dates");
  expect(await loadFinancialObservationArchive(original)).toEqual(report);
  expect(await loadFinancialObservationArchive(schedule)).toEqual(dates);
  const corrected = { ...report, observedAt: "2025-05-03T12:30:01Z", rows: [{ ...reportRow, roe: 7 }] };
  const revision = await archiveFinancialObservations(corrected);
  expect(revision.revision).not.toBe(original.revision);
  expect(await loadFinancialObservationArchive(revision)).toEqual(corrected);
  expect(await loadFinancialObservationArchive(original)).toEqual(report);
  const missing = { ...dates, rows: [] };
  const empty = await archiveFinancialObservations(missing);
  expect(empty.revision).not.toBe(schedule.revision);
  expect(await loadFinancialObservationArchive(empty)).toEqual(missing);
});

test("financial archives reject invalid dates, foreign scope and saturated or malformed data", async () => {
  const report = indicators();
  const dates = disclosure();
  const invalid = [
    { ...report, symbol: "000001.SH" }, { ...report, endpoint: "untrusted" },
    { ...report, observedAt: "2025-05-02" }, { ...report, rows: Array.from({ length: 100 }, () => reportRow) },
    { ...report, rows: [{ ...reportRow, bookValuePerShare: Infinity }] },
    { ...report, rows: [{ ...reportRow, periodEnd: "2023-12-31" }] },
    { ...dates, rows: [{ ...dates.rows[0], periodEnd: "2024-09-30" }] },
    { ...dates, rows: [{ ...dates.rows[0], actualDisclosureDate: "2025-02-30" }] },
    { ...dates, rows: Array.from({ length: 6000 }, () => dates.rows[0]) },
    { ...dates, requested: { periodEnd, token: "unexpected" } },
  ];
  for (const batch of invalid) {
    await expect(archiveFinancialObservations(batch as StoredFinancialObservationBatch)).rejects.toThrow("Invalid observation archive");
  }
});

test("financial archive reads require the exact kind and digest and honor cancellation", async () => {
  const report = indicators();
  const ref = await archiveFinancialObservations(report);
  await expect(loadFinancialObservationArchive({ ...ref, kind: "financial-disclosure-dates" })).rejects.toThrow("Invalid");
  await expect(loadFinancialObservationArchive({ ...ref, revision: "../private" })).rejects.toThrow("Invalid");
  await expect(loadHistoricalMinuteArchive(ref as never)).rejects.toThrow("Invalid");
  const mutable = { ...ref };
  const pending = loadFinancialObservationArchive(mutable);
  mutable.kind = "financial-disclosure-dates";
  expect(await pending).toEqual(report);
  const cancelled = AbortSignal.abort();
  await expect(loadFinancialObservationArchive(ref, cancelled)).rejects.toThrow();
  await expect(archiveFinancialObservations(disclosure(), cancelled)).rejects.toThrow();
  writeFileSync(join(root, "data", "financial-observation-archives-v1", `${ref.revision}.json`), "{}");
  await expect(loadFinancialObservationArchive(ref)).rejects.toThrow("damaged");
  await expect(archiveFinancialObservations(report)).rejects.toThrow("damaged");
});

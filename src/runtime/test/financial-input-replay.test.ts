import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFinancialObservations, type StoredReportFinancialIndicator } from "../../storage/index.ts";
import { replayFinancialResearchInputs } from "../data/financial-input-replay.ts";

const symbol = "600000.SH";
const base = { symbol, market: "A", source: "tushare", coverage: "unknown" } as const;
const annual = "2024-12-31", prior = "2024-09-30";
const annualRelease = "2025-04-28", priorRelease = "2024-10-31";
const indicator = (periodEnd: string, announcementDate: string, roe: number | null): StoredReportFinancialIndicator => ({
  periodEnd, announcementDate, updateFlag: "1", bookValuePerShare: 12, bookValueCurrency: "unknown", roe, grossProfitMargin: 0,
  netProfitMargin: null, operatingRevenueYoyPct: 4, totalOperatingRevenueYoyPct: 5, parentNetProfitYoyPct: 6,
  debtToAssets: 71, ratioUnit: "provider-native",
});
const report = (observedAt: string, rows: StoredReportFinancialIndicator[], stock = symbol) => archiveFinancialObservations({
  ...base, symbol: stock, endpoint: "fina_indicator", observedAt, requested: { startPeriod: prior, endPeriod: annual }, rows,
});
const disclosures = (periodEnd: string, observedAt: string, ...actualDates: (string | null)[]) => archiveFinancialObservations({
  ...base, endpoint: "disclosure_date", observedAt, requested: { periodEnd }, rows: actualDates.map(actualDisclosureDate => ({
    periodEnd, planAnnouncementDate: "2024-10-01", plannedDisclosureDate: "2025-04-25", actualDisclosureDate, modificationRecord: null,
  })),
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-financial-input-replay-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("financial replay gates both captures and keeps an earlier period until the next is eligible", async () => {
  const firstReportTime = "2024-11-01T01:00:00Z";
  const firstDisclosureTime = "2024-11-01T02:00:00Z";
  const annualReportTime = "2025-04-29T16:30:00Z";
  const annualDisclosureTime = "2025-04-29T16:35:00Z";
  const updatedTime = "2025-05-07T16:30:00Z";
  const firstReport = await report(firstReportTime, [indicator(prior, priorRelease, 4)]);
  const firstDisclosure = await disclosures(prior, firstDisclosureTime, priorRelease);
  const annualReport = await report(annualReportTime, [indicator(annual, annualRelease, 7)]);
  const annualDisclosure = await disclosures(annual, annualDisclosureTime, annualRelease);
  const updatedReport = await report(updatedTime, [indicator(annual, annualRelease, 8)]);
  const references = [annualReport, firstDisclosure, updatedReport, annualDisclosure, firstReport];
  const tradingDates = ["2024-10-31", "2025-04-28", "2025-04-30", "2025-05-06", "2025-05-08", "2025-05-09"];
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  try {
    const inputs = await replayFinancialResearchInputs({ symbol, references, tradingDates });
    expect(inputs[0]).toEqual({ tradingDate: tradingDates[0], status: "unavailable", reason: "missing-report" });
    for (const index of [1, 2]) expect(inputs[index]).toMatchObject({ status: "available", periodEnd: prior, report: { roe: 4 },
      actualDisclosureDate: priorRelease, reportEvidence: [{ ref: firstReport, observedAt: firstReportTime }],
      disclosureEvidence: [{ ref: firstDisclosure, observedAt: firstDisclosureTime }] });
    for (const index of [3, 4]) expect(inputs[index]).toMatchObject({ status: "available", periodEnd: annual,
      report: { roe: 7, grossProfitMargin: 0, netProfitMargin: null }, actualDisclosureDate: annualRelease,
      reportEvidence: [{ ref: annualReport, observedAt: annualReportTime }],
      disclosureEvidence: [{ ref: annualDisclosure, observedAt: annualDisclosureTime }] });
    expect(inputs[5]).toMatchObject({ status: "available", report: { roe: 8 }, reportEvidence: [{ ref: updatedReport, observedAt: updatedTime }] });
    expect(await replayFinancialResearchInputs({ symbol, references: references.toReversed(), tradingDates })).toEqual(inputs);
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

test("missing, ambiguous and inconsistent financial versions do not become available", async () => {
  const time = "2025-05-06T01:00:00Z";
  const request = { symbol, tradingDates: ["2025-05-07"] };
  const clean = indicator(annual, annualRelease, 10);
  const normal = await report(time, [clean, clean]);
  const conflict = await report(time, [{ ...clean, roe: 11 }]);
  const after = await report("2025-04-24T01:00:00Z", [clean]);
  const published = await disclosures(annual, time, annualRelease);
  const missing = await disclosures(annual, time, null);
  const disagree = await disclosures(annual, time, annualRelease, "2025-04-25");
  const checks = [
    { references: [normal, missing], reason: "missing-disclosure" },
    { references: [normal, conflict, published], reason: "ambiguous-report" },
    { references: [normal, disagree], reason: "ambiguous-disclosure" },
    { references: [after, published], reason: "inconsistent-timing" },
  ] as const;
  for (const { references, reason } of checks) {
    expect(await replayFinancialResearchInputs({ ...request, references })).toEqual([{ tradingDate: "2025-05-07", status: "unavailable", reason }]);
  }
  expect(await replayFinancialResearchInputs({ ...request, references: [normal, published] })).toMatchObject([{ status: "available" }]);
});

test("financial replay rejects corrupt and foreign references, invalid dates and cancellation", async () => {
  const row = indicator(annual, annualRelease, null);
  const observedAt = "2025-05-06T01:00:00Z";
  const foreign = await report(observedAt, [row], "600001.SH");
  const local = await report(observedAt, [row]);
  const request = { symbol, tradingDates: ["2025-05-07"], references: [local] };
  await expect(replayFinancialResearchInputs({ ...request, references: [foreign] })).rejects.toThrow("symbol does not match");
  await expect(replayFinancialResearchInputs({ ...request, references: [local, local] })).rejects.toThrow("Duplicate");
  await expect(replayFinancialResearchInputs({ ...request, tradingDates: ["2025-02-30"] })).rejects.toThrow("ordered unique");
  await expect(replayFinancialResearchInputs(request, AbortSignal.abort())).rejects.toThrow();
  writeFileSync(join(root, "data", "financial-observation-archives-v1", `${local.revision}.json`), "{}");
  await expect(replayFinancialResearchInputs(request)).rejects.toThrow("damaged");
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFinancialObservationArchive, readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectFinancialObservations, type FinancialCollectionRequest } from "../data/financial-collection.ts";

const credential = "fixture-financial-token";
const symbol = "600000.SH";
const periodEnd = "2024-12-31";
const report = { kind: "report-financial-indicators", symbol, startPeriod: "2024-01-01", endPeriod: periodEnd } as const;
const disclosure = { kind: "financial-disclosure-dates", symbol, periodEnd } as const;
const reportFields = ["ts_code", "end_date", "ann_date", "update_flag", "bps", "roe", "grossprofit_margin", "netprofit_margin",
  "or_yoy", "tr_yoy", "netprofit_yoy", "debt_to_assets", "eps"];
const disclosureFields = ["ts_code", "end_date", "ann_date", "pre_date", "actual_date", "modify_date"];
const reportRow = [symbol, "20241231", "20250429", "1", 12, null, 0, 3.5, 8, 10, -1.5, 75, -0.75];
const table = (fields: string[], items: unknown[][]) => Response.json({ code: 0, data: { fields, items } });
const preconnect = fetch.preconnect;

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-financial-collection-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: credential } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("configured financial collection keeps both archived responses separate and offline-readable", async () => {
  const http = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(table(reportFields, [reportRow, [symbol, "20241231", "20250428", "0", 11, 0, 8, null, null, null, null, null, 0]]))
    .mockResolvedValueOnce(table(disclosureFields, [[symbol, "20241231", "20250103", "20250422", "20250428", "20250321,20250422"]]));
  try {
    const indicators = await collectFinancialObservations({ ...report, symbol: "600000" });
    const dates = await collectFinancialObservations(disclosure);
    expect(indicators).toMatchObject({ status: "archived", rowCount: 2, source: "tushare", symbol, endpoint: "fina_indicator",
      ref: { kind: "report-financial-indicators", version: 1 } });
    expect(dates).toMatchObject({ status: "archived", rowCount: 1, source: "tushare", symbol, endpoint: "disclosure_date",
      ref: { kind: "financial-disclosure-dates", version: 1 } });
    expect(JSON.stringify([indicators, dates])).not.toContain(credential);
    expect(http.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toMatchObject([
      { api_name: "fina_indicator", token: credential, params: { ts_code: symbol, start_date: "20240101", end_date: "20241231" } },
      { api_name: "disclosure_date", token: credential, params: { ts_code: symbol, end_date: "20241231" } },
    ]);

    http.mockRejectedValue(new Error("Unexpected provider I/O while reopening"));
    expect(await loadFinancialObservationArchive(indicators.ref)).toMatchObject({ observedAt: indicators.observedAt,
      requested: { startPeriod: report.startPeriod, endPeriod: report.endPeriod }, rows: [
        { periodEnd, updateFlag: "1", roe: null, grossProfitMargin: 0, basicEarningsPerShare: -0.75, earningsPerShareCurrency: "unknown" },
        { periodEnd, updateFlag: "0", roe: 0, basicEarningsPerShare: 0, earningsPerShareCurrency: "unknown" },
      ] });
    expect(await loadFinancialObservationArchive(dates.ref)).toMatchObject({ observedAt: dates.observedAt,
      requested: { periodEnd }, rows: [{ periodEnd, actualDisclosureDate: "2025-04-28", modificationRecord: "20250321,20250422" }] });
    expect(http).toHaveBeenCalledTimes(2);
  } finally { http.mockRestore(); }
});

test("unsupported, denied and cancelled collection leave no financial archive", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    await expect(collectFinancialObservations({ kind: "other", symbol } as unknown as FinancialCollectionRequest)).rejects.toThrow("Invalid");
    saveSettings({ ...DEFAULT_SETTINGS, revision: readSettings().revision, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-tickflow-key" } });
    await expect(collectFinancialObservations(report)).rejects.toMatchObject({ code: "unsupported" });
    expect(http).not.toHaveBeenCalled();

    saveSettings({ ...DEFAULT_SETTINGS, revision: readSettings().revision, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
      env: { WHYJ_QUANT_TUSHARE_TOKEN: credential } });
    http.mockResolvedValueOnce(new Response(credential, { status: 403 }));
    await expect(collectFinancialObservations(report)).rejects.toThrow("Provider reference request failed");
    const controller = new AbortController();
    http.mockImplementationOnce(Object.assign(async () => {
      controller.abort(new Error("Cancelled financial collection"));
      return table(reportFields, [reportRow]);
    }, { preconnect }));
    await expect(collectFinancialObservations(report, { signal: controller.signal })).rejects.toThrow("Cancelled financial collection");
    expect(http).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "data", "financial-observation-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

test("an empty response is a fixed observation and keeps the original in-flight request scope", async () => {
  const request = { ...disclosure, symbol: "600000" };
  const http = spyOn(globalThis, "fetch").mockImplementationOnce(Object.assign(async () => {
    request.symbol = "600001.SH";
    return table(disclosureFields, []);
  }, { preconnect }));
  try {
    const receipt = await collectFinancialObservations(request);
    expect(receipt).toMatchObject({ status: "empty", rowCount: 0, symbol });
    expect(await loadFinancialObservationArchive(receipt.ref)).toMatchObject({ symbol, coverage: "unknown",
      requested: { periodEnd }, rows: [] });
    expect(http).toHaveBeenCalledTimes(1);
  } finally { http.mockRestore(); }
});

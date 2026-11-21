import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const input = { symbol: "600000.SH", market: "A" } as const;
const periodEnd = "2024-12-31";
const range = { ...input, startPeriod: "2024-01-01", endPeriod: periodEnd };
const disclosure = { ...input, periodEnd };
const indicatorFields = ["end_date", "ts_code", "ann_date", "update_flag", "bps", "roe", "grossprofit_margin", "netprofit_margin",
  "or_yoy", "tr_yoy", "netprofit_yoy", "debt_to_assets", "eps"];
const disclosureFields = ["ts_code", "end_date", "ann_date", "pre_date", "actual_date", "modify_date"];
const indicator = ["20241231", input.symbol, "20250429", "1", 12, null, 0, 3.5, 8, 10, -1.5, 75, -0.75];
const options = { source: "tushare", apiKey: "fixture", env: {} } as const;

function table(fields: string[], items: unknown[][]) {
  return Response.json({ code: 0, data: { fields, items } });
}

test("dated Tushare financial observations preserve values, repeated periods and input provenance", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(table(indicatorFields, [
      indicator,
      ["20241231", input.symbol, "20250428", "0", 11, 14, null, null, null, null, null, null, 0],
      ["20240930", input.symbol, "20241027", null, 10, 5, null, null, null, null, null, null, null],
    ]));
    http.mockResolvedValueOnce(table(disclosureFields, [
      [input.symbol, "20241231", "20250103", "20250401", "20250428", "20250301,20250401"],
      [input.symbol, "20241231", "20250102", "20250301", null, null],
    ]));
    const source = createMarketDataSource(options);
    const indicators = await source.fetchReportFinancialIndicators(range);
    const dates = await source.fetchFinancialDisclosureDates(disclosure);
    expect(indicators).toMatchObject({ source: "tushare", market: "A", endpoint: "fina_indicator", coverage: "unknown",
      observedAt: expect.any(String), data: [
        { symbol: input.symbol, periodEnd, announcementDate: "2025-04-29", updateFlag: "1", bookValuePerShare: 12,
          bookValueCurrency: "unknown", basicEarningsPerShare: -0.75, earningsPerShareCurrency: "unknown",
          roe: null, grossProfitMargin: 0, netProfitMargin: 3.5, operatingRevenueYoyPct: 8,
          totalOperatingRevenueYoyPct: 10, parentNetProfitYoyPct: -1.5, debtToAssets: 75, ratioUnit: "provider-native" },
        { periodEnd, announcementDate: "2025-04-28", updateFlag: "0", bookValuePerShare: 11, roe: 14, grossProfitMargin: null,
          basicEarningsPerShare: 0, earningsPerShareCurrency: "unknown" },
        { periodEnd: "2024-09-30", basicEarningsPerShare: null, earningsPerShareCurrency: "unknown" },
      ] });
    expect(dates).toMatchObject({ source: "tushare", market: "A", endpoint: "disclosure_date", coverage: "unknown",
      observedAt: expect.any(String), data: [
        { symbol: input.symbol, periodEnd, planAnnouncementDate: "2025-01-03", plannedDisclosureDate: "2025-04-01",
          actualDisclosureDate: "2025-04-28", modificationRecord: "20250301,20250401" },
        { symbol: input.symbol, periodEnd, planAnnouncementDate: "2025-01-02", plannedDisclosureDate: "2025-03-01",
          actualDisclosureDate: null, modificationRecord: null },
      ] });
    expect(http.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toMatchObject([
      { api_name: "fina_indicator", params: { ts_code: input.symbol, start_date: "20240101", end_date: "20241231" },
        fields: ["ts_code", "end_date", ...indicatorFields.slice(2)].join(",") },
      { api_name: "disclosure_date", params: { ts_code: input.symbol, end_date: "20241231" }, fields: disclosureFields.join(",") },
    ]);
  } finally { http.mockRestore(); }
});

test("financial reads reject unsupported requests and malformed, foreign or cap-saturated rows", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource(options);
    const other = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
    expect(getMarketDataCapabilities("tushare").observations).toMatchObject({
      fetchReportFinancialIndicators: { status: "implemented", markets: ["A"] },
      fetchFinancialDisclosureDates: { status: "implemented", markets: ["A"] },
    });
    expect(getMarketDataCapabilities("tickflow").observations).toMatchObject({
      fetchReportFinancialIndicators: { status: "not-implemented" }, fetchFinancialDisclosureDates: { status: "not-implemented" },
    });
    await expect(other.fetchReportFinancialIndicators(range)).rejects.toMatchObject({ code: "unsupported" });
    await expect(source.fetchFinancialDisclosureDates({ ...disclosure, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(source.fetchFinancialDisclosureDates({ ...disclosure, symbol: "000001.SH" })).rejects.toThrow("Invalid");
    await expect(source.fetchReportFinancialIndicators({ ...range, startPeriod: "2024-02-30" })).rejects.toThrow("valid YYYY-MM-DD");
    await expect(source.fetchReportFinancialIndicators({ ...range, startPeriod: "2025-01-01" })).rejects.toThrow("Start date must be on or before end date");
    expect(http).not.toHaveBeenCalled();

    for (const response of [
      table(indicatorFields, Array.from({ length: 100 }, () => indicator)),
      table(indicatorFields, [indicator.slice(1)]),
      table(indicatorFields, [["20241231", "000002.SZ", ...indicator.slice(2)]]),
      table(indicatorFields, [["20231231", ...indicator.slice(1)]]),
      table(indicatorFields, [[...indicator.slice(0, 4), "12.0", ...indicator.slice(5)]]),
    ]) {
      http.mockResolvedValueOnce(response);
      await expect(source.fetchReportFinancialIndicators(range)).rejects.toThrow();
    }
    for (const row of [
      [input.symbol, "20240930", null, null, null, null],
      [input.symbol, "20241231", null, "20250301", "20250230", null],
    ]) {
      http.mockResolvedValueOnce(table(disclosureFields, [row]));
      await expect(source.fetchFinancialDisclosureDates(disclosure)).rejects.toThrow();
    }
    expect(http).toHaveBeenCalledTimes(7);
  } finally { http.mockRestore(); }
});

test("financial observation reads preserve empty success and cancel without fallback", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource(options);
    http.mockResolvedValueOnce(table(disclosureFields, []));
    expect((await source.fetchFinancialDisclosureDates(disclosure)).data).toEqual([]);
    const controller = new AbortController();
    http.mockImplementationOnce(((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort(new Error("Cancelled report read"));
    })) as typeof fetch);
    await expect(source.fetchReportFinancialIndicators(range, { signal: controller.signal })).rejects.toThrow("Cancelled report read");
    expect(http).toHaveBeenCalledTimes(2);
  } finally { http.mockRestore(); }
});

import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities, SourceRequestError } from "../index.ts";
import * as python from "../src/akshare-python.ts";

const apiKey = "fixture";
const env = {};
const tradeDate = "2026-11-13";
const stamp = Date.parse("2026-11-13T07:00:00Z");

test("latest price snapshots share a contract while keeping actual provider time and endpoints", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const fd = createMarketDataSource({ source: "financial-datasets", apiKey, env });
    http.mockResolvedValueOnce(Response.json({ snapshot: {
      ticker: "AAPL", price: 101, day_change: 1, day_change_percent: 1, time_milliseconds: stamp,
    } }));
    const result = await fd.fetchPriceSnapshot({ symbol: "aapl", market: "US" });
    expect(new URL(String(http.mock.calls[0]?.[0])).searchParams.get("ticker")).toBe("AAPL");
    expect(result).toMatchObject({ source: "financial-datasets", endpoint: "/prices/snapshot",
      data: { symbol: "AAPL", lastPrice: 101, dayChange: 1, dayChangePct: 1, sourceTimestamp: stamp } });
    http.mockResolvedValueOnce(Response.json({ snapshot: { ticker: "MSFT", price: 101 } }));
    await expect(fd.fetchPriceSnapshot({ symbol: "AAPL", market: "US" })).rejects.toThrow();
    http.mockResolvedValueOnce(Response.json({ snapshot: { ticker: "AAPL", price: 101, time_milliseconds: 1.5 } }));
    await expect(fd.fetchPriceSnapshot({ symbol: "AAPL", market: "US" })).rejects.toThrow("invalid");

    const tickflow = createMarketDataSource({ source: "tickflow", apiKey, env });
    http.mockResolvedValueOnce(Response.json({ data: [{
      symbol: "600000.SH", region: "CN", timestamp: stamp, last_price: 11, prev_close: 10,
      open: 10, high: 12, low: 9, volume: 100, amount: null,
    }] }));
    expect(await tickflow.fetchPriceSnapshot({ symbol: "600000.SH", market: "A" })).toMatchObject({
      source: "tickflow", data: { dayChange: 1, dayChangePct: 10, sourceTimestamp: stamp },
    });
    expect(getMarketDataCapabilities("financial-datasets").observations.fetchPriceSnapshot).toEqual({ status: "implemented", markets: ["US"] });
    const unsupported = await fd.fetchPriceSnapshot({ symbol: "600000.SH", market: "A" }).catch(error => error);
    expect(unsupported).toBeInstanceOf(SourceRequestError);
    expect(unsupported).toMatchObject({ code: "unsupported" });
    expect(http).toHaveBeenCalledTimes(4);
  } finally { http.mockRestore(); }
});

test("fund profile, purchase terms and performance project known fields with endpoint evidence", async () => {
  const status = "ok";
  const script = spyOn(python, "runPython").mockImplementation(async (_program, args) => {
    const [symbol, mode] = args ?? [];
    const body = mode === "purchase" ? {
      purchase: { 基金代码: symbol, 申购状态: "开放", 购买起点: 10, 手续费: "0.13%" },
      attempts: [{ endpoint: "fund_purchase_em", status }],
    } : mode === "profile" ? {
      profile: { 基金简称: "Fixture Fund", 成立日期: "2012-08-15" }, attempts: [{ endpoint: "fund_info_ths", status }],
    } : {
      achievement: [{ 周期: "近1月", 本产品区间收益: -1.32 }], analysis: [{ 周期: "近1年", 年化波动率: 18.31 }],
      attempts: [{ endpoint: "fund_individual_achievement_xq", status }, { endpoint: "fund_individual_analysis_xq", status }],
    };
    return { stdout: JSON.stringify({ symbol, ...body }), stderr: "" };
  });
  try {
    const source = createMarketDataSource({ source: "akshare" });
    const input = { symbol: "270042.OF", market: "A" } as const;
    expect(await source.fetchFundProfile(input)).toMatchObject({
      endpoints: ["fund_info_ths"], data: { name: "Fixture Fund", manager: null, establishedOn: "2012-08-15" },
    });
    expect(await source.fetchFundPurchaseTerms(input)).toMatchObject({
      endpoints: ["fund_purchase_em"], data: { subscriptionStatus: "开放", redemptionStatus: null, minimumPurchase: 10, headlineFeePct: 0.13 },
    });
    expect(await source.fetchFundPerformance(input)).toMatchObject({
      endpoints: ["fund_individual_achievement_xq", "fund_individual_analysis_xq"],
      data: { performance: [{ period: "近1月", returnPct: -1.32 }], risk: [{ period: "近1年", annualVolatilityPct: 18.31 }] },
    });
    expect(script.mock.calls.map(call => call[1]?.[1])).toEqual(["profile", "purchase", "performance"]);
  } finally { script.mockRestore(); }
});

test("daily valuation dispatches the exact date and preserves nulls and native market value units", async () => {
  const fields = ["ts_code", "trade_date", "close", "pe", "pe_ttm", "pb", "total_mv", "circ_mv"];
  const http = spyOn(globalThis, "fetch");
  try {
    const valuation = createMarketDataSource({ source: "tushare", apiKey, env });
    http.mockResolvedValueOnce(Response.json({ code: 0, data: { fields, items: [["600000.SH", "20261113", 12, null, 6, 0.6, 100, 90]] } }));
    const result = await valuation.fetchDailyValuation({ symbol: "600000.SH", market: "A", tradeDate });
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body))).toMatchObject({
      api_name: "daily_basic", params: { ts_code: "600000.SH", trade_date: "20261113" },
    });
    expect(result).toMatchObject({ endpoint: "daily_basic", coverage: "unknown",
      data: { tradeDate, pe: null, peTtm: 6, pb: 0.6, totalMarketValue: 100, circulatingMarketValue: 90, marketValueUnit: "CNY-ten-thousand" } });
    http.mockResolvedValueOnce(Response.json({ code: 0, data: { fields, items: [["600000.SH", "20261112", 12, null, 6, 0.6, 100, 90]] } }));
    await expect(valuation.fetchDailyValuation({ symbol: "600000.SH", market: "A", tradeDate })).rejects.toThrow();
    await expect(valuation.fetchDailyValuation({ symbol: "000300.SH", market: "A", tradeDate })).rejects.toThrow("Invalid");
    expect(http).toHaveBeenCalledTimes(2);
  } finally { http.mockRestore(); }
});

test("calendar and main-board universe expose independent endpoints with explicit scope", async () => {
  const script = spyOn(python, "runPython").mockImplementation(async (_script, args) => {
    const first = args?.[0];
    const rows = first === "SH" ? [{ 证券代码: "600000", 证券简称: "Shanghai fixture" }]
      : first === "SZ" ? [{ 板块: "主板", A股代码: "000001", A股简称: "Shenzhen fixture" }]
      : [tradeDate];
    return { stdout: JSON.stringify(rows), stderr: "" };
  });
  try {
    const akshare = createMarketDataSource({ source: "akshare" });
    const calendar = await akshare.fetchTradingCalendar({ market: "A", start: tradeDate, end: tradeDate });
    expect(calendar).toMatchObject({ endpoint: "tool_trade_date_hist_sina", coverage: "unknown",
      data: { sessions: [tradeDate], zone: "Asia/Shanghai" } });
    const universe = await akshare.fetchInstrumentUniverse({ market: "A", universe: "mainboard" });
    expect(universe.members.map(member => member.symbol)).toEqual(["000001.SZ", "600000.SH"]);
    expect(universe.sources.map(entry => entry.endpoint)).toEqual(["stock_info_sh_name_code", "stock_info_sz_name_code"]);
    await expect(akshare.fetchTradingCalendar({ market: "US", start: tradeDate, end: tradeDate })).rejects.toThrow("not implemented");
    script.mockResolvedValueOnce({ stdout: JSON.stringify([tradeDate, tradeDate]), stderr: "" });
    await expect(akshare.fetchTradingCalendar({ market: "A", start: tradeDate, end: tradeDate })).rejects.toThrow("invalid");
  } finally { script.mockRestore(); }
});

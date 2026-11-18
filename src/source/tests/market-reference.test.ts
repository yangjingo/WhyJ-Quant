import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";
import * as python from "../src/akshare-python.ts";

const market = "A" as const;

test("Tushare maps stock identity, listing date, NAV dates and adjusted NAV without synthetic volume", async () => {
  const fetch = spyOn(globalThis, "fetch");
  try {
    const tushare = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    fetch.mockResolvedValueOnce(Response.json({ code: 0, data: { fields: ["ts_code", "name", "list_date"],
      items: [["920001.BJ", "Example", "20250101"]] } }));
    expect(await tushare.searchInstruments({ market, keyword: "Example" })).toMatchObject({
      source: "tushare", endpoint: "stock_basic", data: [{ symbol: "920001.BJ", exchange: "BSE", listedOn: "2025-01-01" }],
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ api_name: "stock_basic", params: { name: "Example" } });
    fetch.mockResolvedValueOnce(Response.json({ code: 0, data: { fields: ["ts_code", "nav_date", "unit_nav", "adj_nav"],
      items: [["270042.OF", "20261113", 1.2, 1.3]] } }));
    const nav = await tushare.fetchFundNav({ market, symbol: "270042", start: "2026-11-13", end: "2026-11-13" });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      api_name: "fund_nav", params: { ts_code: "270042.OF", start_date: "20261113", end_date: "20261113" },
    });
    expect(nav).toMatchObject({ endpoint: "fund_nav", data: [
      { symbol: "270042.OF", date: "2026-11-13", unitNav: 1.2, adjustedNav: 1.3, accumulatedNav: null, dailyReturnPct: null },
    ] });
    expect(nav.data[0]).not.toHaveProperty("volume");
    expect(getMarketDataCapabilities("tushare").reference.fetchIndexQuotes.status).toBe("not-implemented");
    await expect(tushare.fetchIndexQuotes({ market, codes: ["000300"] })).rejects.toThrow("not implemented");
    await expect(tushare.searchInstruments({ market: "HK", keyword: "Example" })).rejects.toThrow("not implemented");
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { fetch.mockRestore(); }
});

test("AKShare maps native NAV, index metadata, constituents and quote evidence", async () => {
  const script = spyOn(python, "runPython").mockImplementation(async (_script, args = []) => {
    const [command] = args;
    const rows = command === "index_stock_info" ? [{ 指数代码: "000300", 指数名称: "CSI 300", 发布日期: "20050408" }]
      : command === "index_stock_cons_csindex" ? [{ 指数代码: "000300", 成分券代码: "600000", 成分券名称: "Stock" }]
      : command === "stock_zh_index_spot_em" ? [{ 代码: "000300", 名称: "CSI 300", 最新价: 4000, 昨收: 3900 }] : [];
    const payload = command === "270042" ? { symbol: command,
      nav: [{ fund_code: command, nav_date: "2026-11-13", unit_nav: 1.5, accumulated_nav: 2, daily_return_pct: null }], attempts: [] }
      : { endpoint: command, rows };
    return { stdout: JSON.stringify(payload), stderr: "" };
  });
  const http = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  try {
    const source = createMarketDataSource({ source: "akshare" });
    const nav = await source.fetchFundNav({ market, symbol: "270042.OF" });
    expect(nav).toMatchObject({ endpoint: "fund_open_fund_info_em", data: [{ symbol: "270042.OF", accumulatedNav: 2, adjustedNav: null }] });
    expect(await source.fetchIndexMetadata({ market, keyword: "000300" })).toMatchObject({
      endpoint: "index_stock_info", data: [{ code: "000300", name: "CSI 300", publishedOn: "2005-04-08" }],
    });
    expect(await source.fetchIndexConstituents({ market, code: "000300" })).toMatchObject({
      endpoint: "index_stock_cons_csindex", data: [{ indexCode: "000300", code: "600000", includedOn: null, exchange: null, weight: null }],
    });
    expect(await source.fetchIndexQuotes({ market, codes: ["000300"] })).toMatchObject({
      endpoint: "stock_zh_index_spot_em", data: [{ lastPrice: 4000, sourceDate: null, sourceTime: null, sourceTimeZone: null }],
    });
    expect(script.mock.calls.at(-1)?.[1]?.[0]).toBe("stock_zh_index_spot_em");
    expect(getMarketDataCapabilities("akshare").reference.fetchFundNav).toEqual({ status: "implemented", markets: ["A"] });
  } finally { script.mockRestore(); http.mockRestore(); }
});

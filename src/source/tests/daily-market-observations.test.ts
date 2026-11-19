import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const request = { market: "A", tradeDate: "2024-01-05" } as const;
const barFields = "ts_code,trade_date,open,high,low,close,vol,amount,pre_close,change,pct_chg".split(",");
const basicFields = "ts_code,trade_date,close,pe,pe_ttm,pb,total_mv,circ_mv,turnover_rate,turnover_rate_f,volume_ratio,total_share,float_share,free_share".split(",");
const shBar = ["600000.SH", "20240105", 10, 11, 9, 10, 100.01, 100.5, 9.5, 0.5, 5.2632];
const szBar = ["000001.SZ", "20240105", 10, 10, 10, 10, 0, null, 10, 0, 0];
const szBasic = ["000001.SZ", "20240105", 10, null, null, -0.4, 120, 95, 0, null, 0, 12, 9.5, null];
const response = (fields: string[], items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });

test("two date-only requests retain independent source provenance, provider units and true zero", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(response(barFields, [shBar, szBar]));
    http.mockResolvedValueOnce(response(basicFields, [szBasic]));
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const bars = await source.fetchDailyMarketBars(request);
    const basics = await source.fetchDailyMarketBasics(request);
    expect(http.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toEqual([
      { api_name: "daily", params: { trade_date: "20240105" }, token: "fixture", fields: barFields.join(",") },
      { api_name: "daily_basic", params: { trade_date: "20240105", ts_code: "" }, token: "fixture", fields: basicFields.join(",") },
    ]);
    expect(http.mock.calls.every(call => call[1]?.redirect === "error")).toBe(true);
    expect(bars).toEqual({ source: "tushare", endpoint: "daily", market: "A", coverage: "unknown", observedAt: expect.any(String),
      data: { tradeDate: request.tradeDate, adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [
        { symbol: "000001.SZ", open: 10, high: 10, low: 10, close: 10, volume: 0, amount: null,
          exRightsPreviousClose: 10, changeCny: 0, returnPct: 0 },
        { symbol: "600000.SH", open: 10, high: 11, low: 9, close: 10, volume: 100.01, amount: 100.5,
          exRightsPreviousClose: 9.5, changeCny: 0.5, returnPct: 5.2632 },
      ] } });
    expect(basics).toEqual({ source: "tushare", endpoint: "daily_basic", market: "A", coverage: "unknown", observedAt: expect.any(String),
      data: { tradeDate: request.tradeDate, priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [
        { symbol: "000001.SZ", close: 10, pe: null, peTtm: null, pb: -0.4, totalMarketValue: 120, circulatingMarketValue: 95,
          turnoverPct: 0, freeFloatTurnoverPct: null, providerVolumeRatio: 0, totalShares: 12, floatShares: 9.5, freeFloatShares: null },
      ] } });
    expect(getMarketDataCapabilities("tushare").observations.fetchDailyMarketBars).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tickflow").observations.fetchDailyMarketBasics).toEqual({ status: "not-implemented" });
  } finally { http.mockRestore(); }
});

test("rejects incomplete layouts, mismatched dates, invalid values and responses at the row cap", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    for (const items of [[szBar, szBar], [["899050.BJ", ...shBar.slice(1)]], [[shBar[0]!, "20240104", ...shBar.slice(2)]],
      [[...shBar.slice(0, 6), -1, ...shBar.slice(7)]], [[...shBar.slice(0, 3), 8, ...shBar.slice(4)]], [shBar.slice(0, -1)], Array(6000).fill(shBar)]) {
      http.mockResolvedValueOnce(response(barFields, items));
      await expect(source.fetchDailyMarketBars(request)).rejects.toThrow();
    }
    http.mockResolvedValueOnce(response(basicFields, [[...szBasic.slice(0, 8), -1, ...szBasic.slice(9)]]));
    await expect(source.fetchDailyMarketBasics(request)).rejects.toThrow("field invalid");
    http.mockResolvedValueOnce(response(basicFields, Array(6000).fill(szBasic)));
    await expect(source.fetchDailyMarketBasics(request)).rejects.toMatchObject({ code: "provider-failure" });
    http.mockResolvedValueOnce(response(barFields, []));
    expect((await source.fetchDailyMarketBars(request)).data.rows).toEqual([]);
    await expect(source.fetchDailyMarketBars({ ...request, tradeDate: "2024-02-30" })).rejects.toThrow("date");
    await expect(source.fetchDailyMarketBasics({ ...request, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tickflow", apiKey: "unused" }).fetchDailyMarketBars(request))
      .rejects.toMatchObject({ code: "unsupported" });
    expect(http).toHaveBeenCalledTimes(10);
  } finally { http.mockRestore(); }
});

test("cancels a dated cross-section rather than returning a late response", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const cancel = new AbortController();
    const reason = new Error("cancelled snapshot");
    http.mockImplementationOnce((async () => {
      cancel.abort(reason);
      return response(barFields, [shBar]);
    }) as unknown as typeof fetch);
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    await expect(source.fetchDailyMarketBars(request, { signal: cancel.signal })).rejects.toBe(reason);
    expect(http).toHaveBeenCalledTimes(1);
  } finally { http.mockRestore(); }
});

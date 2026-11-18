import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";
import * as python from "../src/akshare-python.ts";

const start = "2026-11-13";
const end = start;
const config = { apiKey: "fixture", baseUrl: "http://127.0.0.1:12345", env: {} };
const bar = { date: start, open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null };

test("selected daily dispatch maps the four HTTP providers to one daily series", async () => {
  const transport = spyOn(globalThis, "fetch");
  try {
    transport.mockResolvedValueOnce(Response.json({ code: 0, data: {
      fields: ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"],
      items: [["600000.SH", "20261113", 10, 12, 9, 11, 100, null]],
    } }));
    const tushare = await createMarketDataSource({ source: "tushare", ...config }).fetchDailyBars({
      symbol: "600000", market: "A", start, end, adjustment: "unadjusted",
    });
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toMatchObject({
      api_name: "daily", params: { ts_code: "600000.SH", start_date: "20261113", end_date: "20261113" },
    });
    expect(tushare).toMatchObject({ symbol: "600000.SH", market: "A", requested: { start, end }, source: "tushare",
      endpoint: "daily", adjustment: "unadjusted", volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown", data: [bar] });
    expect(Number.isFinite(Date.parse(tushare.observedAt))).toBe(true);

    transport.mockResolvedValueOnce(Response.json({ data: { timestamp: [Date.parse(start + "T00:00:00+08:00")],
      open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } }));
    const tickflow = await createMarketDataSource({ source: "tickflow", ...config }).fetchDailyBars({ symbol: "600000.SH", market: "A", start, end });
    const tickflowUrl = new URL(String(transport.mock.calls[1]?.[0]));
    expect(tickflowUrl.searchParams.get("period")).toBe("1d");
    expect(tickflowUrl.searchParams.get("adjust")).toBe("forward");
    expect(tickflow).toMatchObject({ source: "tickflow", endpoint: "/v1/klines", adjustment: "forward-adjusted", data: [bar] });

    for (const [source, endpoint, payload] of [
      ["llmquant-data", "/api/equity/historical", { data: { prices: [{ ...bar, adj_close: 7 }] } }],
      ["financial-datasets", "/prices/", { prices: [{ ...bar, adjusted_close: 7 }] }],
    ] as const) {
      transport.mockResolvedValueOnce(Response.json(payload));
      const result = await createMarketDataSource({ source, ...config }).fetchDailyBars({ symbol: "AAPL", market: "US", start, end });
      const requestUrl = new URL(String(transport.mock.calls.at(-1)?.[0]));
      expect(requestUrl.pathname).toBe(endpoint);
      expect(requestUrl.searchParams.get("start_date")).toBe(start);
      expect(requestUrl.searchParams.get("end_date")).toBe(end);
      expect(result).toMatchObject({ source, endpoint, adjustment: "provider-unspecified", data: [{ ...bar, adjClose: 7 }] });
    }
    expect(transport).toHaveBeenCalledTimes(4);
  } finally { transport.mockRestore(); }
});

test("selected AKShare preserves its actual upstream and market-specific price basis", async () => {
  const helper = spyOn(python, "runPython").mockImplementation(async (_script, args) => {
    const endpoint = args?.[0] === "HK" ? "stock_hk_daily" : "stock_zh_a_hist";
    return { stdout: JSON.stringify({ bars: [bar], endpoint, attempts: [{ endpoint, status: "ok", rows: 1 }] }), stderr: "" };
  });
  try {
    const source = createMarketDataSource({ source: "akshare" });
    const hk = await source.fetchDailyBars({ symbol: "0700.HK", market: "HK", start, end, adjustment: "unadjusted" });
    expect(helper.mock.calls[0]?.[1]).toEqual(["HK", "0700", start, end]);
    expect(hk).toMatchObject({ source: "akshare", endpoint: "stock_hk_daily", adjustment: "unadjusted", data: [bar] });
    const a = await source.fetchDailyBars({ symbol: "600000.SH", market: "A", start, end });
    expect(a).toMatchObject({ source: "akshare", endpoint: "stock_zh_a_hist", adjustment: "forward-adjusted", data: [bar] });
    expect(getMarketDataCapabilities("akshare").dailyBars.markets).toEqual(["A", "US", "HK"]);
  } finally { helper.mockRestore(); }
});

test("selected daily rejects unverified market and incompatible basis and sanitizes failures", async () => {
  const transport = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "llmquant-data", ...config });
    const request = { symbol: "AAPL", market: "US", start, end } as const;
    expect(getMarketDataCapabilities("llmquant-data").dailyBars.markets).toEqual(["US"]);
    await expect(source.fetchDailyBars({ ...request, symbol: "0700.HK", market: "HK" })).rejects.toThrow("not implemented");
    await expect(source.fetchDailyBars({ ...request, symbol: "600000.SH" })).rejects.toThrow("does not match market");
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce(Response.json({ data: { prices: [{ ...bar, adj_close: 7 }] } }));
    await expect(source.fetchDailyBars({ ...request, adjustment: "forward-adjusted" })).rejects.toThrow("incompatible");
    transport.mockRejectedValueOnce(new Error("network response contains PRIVATE_PROVIDER_TEXT"));
    await expect(source.fetchDailyBars(request)).rejects.toThrow("Provider connection failed");
    transport.mockReturnValueOnce(new Promise<Response>(() => {}));
    await expect(source.fetchDailyBars(request, { timeoutMs: 20 })).rejects.toThrow("timed out");
    const abort = new AbortController();
    abort.abort(new Error("cancelled by caller"));
    await expect(source.fetchDailyBars(request, { signal: abort.signal })).rejects.toThrow("cancelled by caller");
    expect(transport).toHaveBeenCalledTimes(3);
  } finally { transport.mockRestore(); }
});

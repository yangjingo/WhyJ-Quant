import { afterEach, expect, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const query = { market: "A", symbol: "510330.SH", start: "2025-06-17", end: "2025-06-18" } as const;
const selected = (source: "tickflow" | "tushare" | "akshare") =>
  createMarketDataSource({ source, apiKey: "fixture", env: {}, baseUrl: "http://127.0.0.1:1234" });
const fields = ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"];
const row = [query.symbol, "20250618", 4.008, 4.024, 3.996, 4.017, 382896, 153574.446];

test("Tushare uses fund_daily and retains ETF OHLC, missing days and native units", async () => {
  globalThis.fetch = (async (input, init) => {
    expect(new URL(String(input)).hostname).toBe("127.0.0.1");
    expect(JSON.parse(String(init?.body))).toMatchObject({ api_name: "fund_daily",
      params: { ts_code: "510330.SH", start_date: "20250617", end_date: "20250618" } });
    return Response.json({ code: 0, data: { fields, items: [row] } });
  }) as typeof fetch;
  expect(await selected("tushare").fetchDatedEtfDailyBars(query)).toMatchObject({
    source: "tushare", endpoint: "fund_daily", market: "A", coverage: "unknown",
    data: { symbol: query.symbol, assetType: "etf", requested: { start: query.start, end: query.end },
      adjustment: "none", timeZone: "Asia/Shanghai", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ tradeDate: "2025-06-18", sourceTimestamp: null, open: 4.008, high: 4.024, low: 3.996,
        close: 4.017, volume: 382896, amount: 153574.446 }],
    },
  });
});

test("TickFlow prices retain the exact date and timestamp with unknown native units", async () => {
  const timestamp = Date.parse("2025-06-18T07:00:00Z");
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/klines");
    expect(url.searchParams.get("symbol")).toBe("158123.SZ");
    expect(url.searchParams.get("period")).toBe("1d");
    expect(url.searchParams.get("adjust")).toBe("none");
    expect(url.searchParams.get("start_time")).toBe(String(Date.parse("2025-06-16T16:00:00Z")));
    expect(url.searchParams.get("end_time")).toBe(String(Date.parse("2025-06-18T16:00:00Z") - 1));
    return Response.json({ data: { symbol: "158123.SZ", timestamp: [timestamp], open: [1], high: [1.2],
      low: [0.9], close: [1.1], volume: [150] } });
  }) as typeof fetch;
  expect(await selected("tickflow").fetchDatedEtfDailyBars({ ...query, symbol: "158123.SZ" })).toMatchObject({
    source: "tickflow", endpoint: "/v1/klines", coverage: "unknown",
    data: { symbol: "158123.SZ", assetType: "etf", priceUnit: "unknown", volumeUnit: "unknown", amountUnit: "unknown",
      rows: [{ tradeDate: "2025-06-18", sourceTimestamp: timestamp, close: 1.1, amount: null }] },
  });
});

test("rejects unrelated instruments, date bounds and providers before requests", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected request"); }) as unknown as typeof fetch;
  const service = selected("tushare");
  for (const symbol of ["600001.SH", "000001.SH", "510330", "501001.SH", "520100.SH", "159900.SZ", "160119.SZ"]) {
    await expect(service.fetchDatedEtfDailyBars({ ...query, symbol })).rejects.toThrow("ETF trading code");
  }
  await expect(service.fetchDatedEtfDailyBars({ ...query, end: "2025-02-30" })).rejects.toThrow();
  await expect(service.fetchDatedEtfDailyBars({ ...query, end: "9999-12-31" })).rejects.toThrow("Completed Shanghai");
  await expect(service.fetchDatedEtfDailyBars({ ...query, start: "2024-01-01" })).rejects.toThrow("366 calendar days");
  await expect(service.fetchDatedEtfDailyBars({ ...query, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
  await expect(selected("akshare").fetchDatedEtfDailyBars(query)).rejects.toMatchObject({ code: "unsupported" });
  await expect(service.fetchDatedEtfDailyBars(query, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  expect(getMarketDataCapabilities("tushare").observations.fetchDatedEtfDailyBars).toEqual({ status: "implemented", markets: ["A"] });
  expect(getMarketDataCapabilities("tickflow").observations.fetchDatedEtfDailyBars).toEqual({ status: "implemented", markets: ["A"] });
  expect(getMarketDataCapabilities("akshare").observations.fetchDatedEtfDailyBars).toEqual({ status: "not-implemented" });
  expect(calls).toBe(0);
});

test("empty rows stay empty and ambiguous provider identities or dates fail", async () => {
  const provider = selected("tushare");
  globalThis.fetch = (async () => Response.json({ code: 0, data: { fields, items: [] } })) as unknown as typeof fetch;
  expect((await provider.fetchDatedEtfDailyBars({ ...query, symbol: "520870.SH" })).data.rows).toEqual([]);
  for (const items of [[row, row], [["510300.SH", ...row.slice(1)]], [[row[0], "20250616", ...row.slice(2)]]]) {
    globalThis.fetch = (async () => Response.json({ code: 0, data: { fields, items } })) as unknown as typeof fetch;
    await expect(provider.fetchDatedEtfDailyBars(query)).rejects.toMatchObject({ code: "provider-failure" });
  }
});

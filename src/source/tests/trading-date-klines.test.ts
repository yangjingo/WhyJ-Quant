import { afterEach, expect, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";
import type { KlineResult, MarketDataSource, SourceConnection, TradingDateKlineRequest } from "../index.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const req: TradingDateKlineRequest = { timeMode: "trading-date", assetType: "stock", symbol: "600000.SH", interval: "1d", adjustment: "none", startDate: "2026-11-13", endDate: "2026-11-13" };
const fields = ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"];
const item = ["600000.SH", "20261113", 10, 12, 9, 11, 100, null];
const client = (source: "tushare" | "tickflow") => createMarketDataSource({ source, apiKey: "fixture", env: {}, baseUrl: "http://127.0.0.1:1234" });

test("Tushare date mode retains trade date and units without inventing a timestamp or cache", async () => {
  let count = 0;
  globalThis.fetch = (async (input, init) => {
    count++; expect(new URL(String(input)).hostname).toBe("127.0.0.1");
    expect(JSON.parse(String(init?.body))).toMatchObject({ api_name: "daily", token: "fixture", params: { ts_code: "600000.SH", start_date: "20261113", end_date: "20261113" } });
    return Response.json({ code: 0, data: { fields, items: [item] } });
  }) as typeof fetch;
  for (let i = 0; i < 2; i++) {
    const result = await client("tushare").fetchKlines(req);
    expect(result).toMatchObject({ timeMode: "trading-date", source: "tushare", endpoint: "daily", market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", requested: { startDate: "2026-11-13", endDate: "2026-11-13" }, adjustment: "none", coverage: "unknown", volumeUnit: "hand", amountUnit: "CNY-thousand",
      data: [{ tradeDate: "2026-11-13", sourceTimestamp: null, close: 11, volume: 100, amount: null }] });
  }
  expect(count).toBe(2);
});

test("TickFlow maps Shanghai session boundaries while preserving its real timestamp", async () => {
  const timestamp = Date.parse("2026-11-12T16:00:00Z");
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    expect(url.searchParams.get("start_time")).toBe(String(timestamp));
    expect(url.searchParams.get("end_time")).toBe(String(timestamp + 86_400_000 - 1));
    return Response.json({ data: { timestamp: [timestamp], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [0] } });
  }) as typeof fetch;
  const result = await client("tickflow").fetchKlines({ ...req, adjustment: "forward" });
  expect(result).toMatchObject({ source: "tickflow", volumeUnit: "unknown", amountUnit: "unknown", adjustment: "forward", data: [{ tradeDate: "2026-11-13", sourceTimestamp: timestamp }] });
});

test("TickFlow uses Shanghai historical daylight-saving rules instead of assuming UTC+8", async () => {
  const timestamp = Date.parse("1991-06-30T15:00:00Z");
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    expect(url.searchParams.get("start_time")).toBe(String(timestamp));
    return Response.json({ data: { timestamp: [timestamp], open: [10], high: [12], low: [9], close: [11], volume: [0], amount: [null] } });
  }) as typeof fetch;
  expect((await client("tickflow").fetchKlines({ ...req, startDate: "1991-07-01", endDate: "1991-07-01" })).data[0])
    .toMatchObject({ tradeDate: "1991-07-01", sourceTimestamp: timestamp, volume: 0 });
});

test("TickFlow date windows follow a 25-hour Shanghai daylight-saving transition", async () => {
  const start = Date.parse("1991-09-14T15:00:00Z"), end = Date.parse("1991-09-15T16:00:00Z") - 1;
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    expect(url.searchParams.get("start_time")).toBe(String(start));
    expect(url.searchParams.get("end_time")).toBe(String(end));
    return Response.json({ data: { timestamp: [start], open: [10], high: [12], low: [9], close: [11], volume: [0], amount: [null] } });
  }) as typeof fetch;
  expect((await client("tickflow").fetchKlines({ ...req, startDate: "1991-09-15", endDate: "1991-09-15" })).data[0]?.tradeDate).toBe("1991-09-15");
});

test("unsupported providers and request shapes fail before network; existing facade types stay assignable", async () => {
  let count = 0; globalThis.fetch = (async () => { count++; throw new Error("unexpected request"); }) as unknown as typeof fetch;
  const old: MarketDataSource = client("tickflow"); expect(typeof old.fetchKlines).toBe("function");
  const timestampReturn: Awaited<ReturnType<ReturnType<typeof createMarketDataSource>["fetchKlines"]>> = {} as KlineResult;
  expect(timestampReturn).toBeDefined();
  expect(getMarketDataCapabilities("tushare")).toMatchObject({ dailyByTradingDate: { status: "implemented", adjustments: ["none"], maxCalendarDays: 366 }, operations: { klines: "not-implemented" }, entitlement: "unknown" });
  for (const bad of [{ ...req, startDate: "2026-02-30" }, { ...req, startDate: "2024-01-01" }, { ...req, symbol: "000001.SH" },
    { ...req, symbol: "510050.SH" }, { ...req, assetType: "fund" }, { ...req, interval: "1m" }, { ...req, extra: 1 }])
    await expect(client("tushare").fetchKlines(bad as TradingDateKlineRequest)).rejects.toThrow();
  await expect(client("tushare").fetchKlines({ ...req, adjustment: "forward" })).rejects.toThrow("not implemented");
  await expect(createMarketDataSource({ source: "akshare" }).fetchKlines(req)).rejects.toThrow("not implemented");
  expect(count).toBe(0);
});

test("Tushare rejects mismatched, incomplete, duplicate, out-of-window and malformed data", async () => {
  for (const items of [[item, item], [["000001.SZ", ...item.slice(1)]], [["600000.SH", "20261112", ...item.slice(2)]],
    [[...item.slice(0, 6), null, 0]], [[...item.slice(0, 3), 8, ...item.slice(4)]], [[...item.slice(0, 6), "100", 0]]]) {
    globalThis.fetch = (async () => Response.json({ code: 0, data: { fields, items } })) as unknown as typeof fetch;
    await expect(client("tushare").fetchKlines(req)).rejects.toThrow("Provider response invalid");
  }
});

test("Tushare errors do not leak provider messages and cancellation avoids requests", async () => {
  globalThis.fetch = (async () => Response.json({ code: -1, msg: "fixture-private" })) as unknown as typeof fetch;
  try { await client("tushare").fetchKlines(req); throw new Error("unexpected success"); }
  catch (error) { expect((error as Error).message).toBe("Provider response invalid"); expect((error as Error).message).not.toContain("fixture-private"); }
  const controller = new AbortController(); controller.abort(); let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error("unexpected"); }) as unknown as typeof fetch;
  await expect(client("tushare").fetchKlines(req, { signal: controller.signal })).rejects.toThrow();
  expect(called).toBe(false);
});

test("Tushare bounds response size and timeout without leaking provider output", async () => {
  globalThis.fetch = (async () => new Response("x".repeat(2 * 1024 * 1024 + 1))) as unknown as typeof fetch;
  await expect(client("tushare").fetchKlines(req)).rejects.toThrow("Provider response truncated");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("fixture-private")), { once: true });
  })) as unknown as typeof fetch;
  await expect(client("tushare").fetchKlines(req, { timeoutMs: 20 })).rejects.toThrow("Provider request timed out");
});

test("in-flight edits cannot change the requested window, source or cancellation signal", async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = (async () => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
  const connection: SourceConnection = { source: "tushare", apiKey: "fixture", env: {}, baseUrl: "http://127.0.0.1:1234" };
  const source = createMarketDataSource(connection); connection.source = "tickflow";
  const input = { ...req }, pending = source.fetchKlines(input);
  input.symbol = "000001.SZ"; input.startDate = "2026-11-12";
  finish(Response.json({ code: 0, data: { fields, items: [item] } }));
  expect(await pending).toMatchObject({ source: "tushare", symbol: "600000.SH", requested: { startDate: "2026-11-13", endDate: "2026-11-13" } });

  const first = new AbortController(), second = new AbortController(), options = { signal: first.signal };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  })) as unknown as typeof fetch;
  const cancelled = client("tushare").fetchKlines(req, options); options.signal = second.signal; first.abort();
  await expect(cancelled).rejects.toThrow();
});

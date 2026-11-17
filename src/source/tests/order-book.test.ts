import { afterEach, expect, test } from "bun:test";
import { createMarketDataSource } from "../index.ts";
import type { MarketDataCapabilities, MarketDataSource } from "../index.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const source = () => createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
const depth = () => ({ symbol: "600000.SH", region: "CN", timestamp: 1762992000000,
  bid_prices: [10, 9.9, 0], bid_volumes: [100, 20, 0], ask_prices: [10.1, 10.2, 0], ask_volumes: [30, 40, 0] });

test("existing public facade and capability implementations remain assignable", () => {
  const unavailable = async (): Promise<never> => { throw new Error("fixture"); };
  const legacy: MarketDataSource = { fetchKlines: unavailable, fetchAdjustmentFactors: unavailable,
    fetchQuotes: unavailable, fetchFinancials: unavailable, subscribeQuotes: unavailable };
  const capabilities: MarketDataCapabilities = { source: "tickflow", entitlement: "unknown", connectivity: "unknown",
    operations: { klines: "implemented", adjustmentFactors: "implemented", quotes: "implemented",
      financials: "implemented", quoteSubscription: "implemented" } };
  expect(typeof legacy.fetchQuotes).toBe("function");
  expect(capabilities.operations.quotes).toBe("implemented");
  expect(typeof source().fetchOrderBook).toBe("function");
});

test("maps provider depth without caching or interpreting zero levels", async () => {
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests++;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/depth");
    expect(url.searchParams.get("symbol")).toBe("600000.SH");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture");
    return Response.json({ data: depth() });
  }) as typeof fetch;
  const client = source();
  for (let i = 0; i < 2; i++) {
    const result = await client.fetchOrderBook({ symbol: "600000.SH" });
    expect(result).toMatchObject({ source: "tickflow", endpoint: "/v1/depth", units: "unknown", data: {
      symbol: "600000.SH", timestamp: 1762992000000,
      bids: [{ price: 10, volume: 100 }, { price: 9.9, volume: 20 }, { price: 0, volume: 0 }],
      asks: [{ price: 10.1, volume: 30 }, { price: 10.2, volume: 40 }, { price: 0, volume: 0 }],
    } });
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  }
  expect(requests).toBe(2);
});

test("rejects invalid identity, timestamp, paired levels, order and values", async () => {
  const bad = [
    { ...depth(), symbol: "000001.SZ" }, { ...depth(), region: "US" }, { ...depth(), timestamp: 0 },
    { ...depth(), bid_volumes: [1] }, { ...depth(), bid_prices: [9, 10, 0] },
    { ...depth(), ask_prices: [10.2, 10.1, 0] }, { ...depth(), ask_volumes: [30, -1, 0] },
    { ...depth(), bid_prices: [10, 9, 8, 7, 6, 5], bid_volumes: [1, 2, 3, 4, 5, 6] },
  ];
  for (const row of bad) {
    globalThis.fetch = (async () => Response.json({ data: row })) as unknown as typeof fetch;
    await expect(source().fetchOrderBook({ symbol: "600000.SH" })).rejects.toThrow();
  }
});

test("returns provider authorization failures without switching providers or leaking bodies", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response("private details", { status: 403 }); }) as unknown as typeof fetch;
  await expect(source().fetchOrderBook({ symbol: "600000.SH" })).rejects.toThrow("HTTP 403");
  expect(requests).toBe(1);
});

test("pre-cancelled requests do not contact the provider", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ data: depth() }); }) as unknown as typeof fetch;
  const controller = new AbortController();
  controller.abort();
  await expect(source().fetchOrderBook({ symbol: "600000.SH" }, { signal: controller.signal })).rejects.toThrow();
  expect(requests).toBe(0);
});

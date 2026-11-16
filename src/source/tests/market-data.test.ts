import { afterEach, expect, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const t = Date.parse("2026-11-13T00:00:00+08:00");
const client = () => createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });

test("capability declarations describe adapter implementation without probing or sharing state", () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("unexpected network request"); }) as unknown as typeof fetch;
  const operations = ["klines", "adjustmentFactors", "quotes", "financials", "quoteSubscription"] as const;
  for (const provider of ["tickflow", "tushare", "akshare", "llmquant-data", "financial-datasets"] as const) {
    const result = getMarketDataCapabilities(provider);
    expect(result.source).toBe(provider);
    expect(result.connectivity).toBe("unknown");
    expect(result.entitlement).toBe("unknown");
    for (const operation of operations) expect(result.operations[operation]).toBe(provider === "tickflow" ? "implemented" : "not-implemented");
    result.operations.klines = "not-implemented";
  }
  expect(getMarketDataCapabilities("tickflow").operations.klines).toBe("implemented");
  expect(() => getMarketDataCapabilities("other" as any)).toThrow("Unknown market data source");
  expect(requests).toBe(0);
});

test("neutral facade maps both daily and minute requests and exposes actual provenance", async () => {
  const intervals: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); intervals.push(url.searchParams.get("period")!);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture");
    expect(url.searchParams.get("adjust")).toBe("none");
    return Response.json({ data: { timestamp: [t], open: [10], high: [11], low: [9], close: [10], volume: [100], amount: [null] } });
  }) as typeof fetch;
  for (const interval of ["1d", "1m"] as const) {
    const result = await client().fetchKlines({ symbol: "600000.SH", interval, adjustment: "none", startTime: t, endTime: t });
    expect(result).toMatchObject({ source: "tickflow", endpoint: "/v1/klines", symbol: "600000.SH", interval, adjustment: "none", units: "unknown", data: [{ timestamp: t, close: 10 }] });
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  }
  expect(intervals).toEqual(["1d", "1m"]);
});

test("neutral factors and quotes preserve requested identities and source time", async () => {
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    return url.pathname.endsWith("ex-factors") ? Response.json({ data: { "600000.SH": [{ timestamp: t, ex_factor: 1.5 }] } })
      : Response.json({ data: [{ symbol: "600000.SH", region: "CN", timestamp: t, last_price: 10, prev_close: 9, open: 9, high: 10, low: 9, volume: 100, amount: null }] });
  }) as typeof fetch;
  const source = client();
  expect(await source.fetchAdjustmentFactors({ symbols: ["600000.SH"], startTime: t, endTime: t })).toMatchObject({ source: "tickflow", data: { "600000.SH": [{ timestamp: t, factor: 1.5 }] } });
  expect(await source.fetchQuotes({ symbols: ["600000.SH", "000001.SZ"] })).toMatchObject({ source: "tickflow", data: [{ symbol: "600000.SH", timestamp: t, lastPrice: 10 }], missingSymbols: ["000001.SZ"] });
});

test("unsupported providers fail every operation without attempting network or another provider", async () => {
  let requests = 0; globalThis.fetch = (async () => { requests++; return Response.json({}); }) as unknown as typeof fetch;
  for (const provider of ["tushare", "akshare", "llmquant-data", "financial-datasets"] as const) {
    const source = createMarketDataSource({ source: provider });
    await expect(source.fetchKlines({ symbol: "600000.SH", interval: "1d", adjustment: "forward" })).rejects.toThrow("Source capability not implemented");
    await expect(source.fetchAdjustmentFactors({ symbols: ["600000.SH"] })).rejects.toThrow("Source capability not implemented");
    await expect(source.fetchQuotes({ symbols: ["600000.SH"] })).rejects.toThrow("Source capability not implemented");
    await expect(source.fetchFinancials({ symbols: ["600000.SH"], kind: "income" })).rejects.toThrow("Source capability not implemented");
    await expect(source.subscribeQuotes({ symbols: ["600000.SH"] }, { onQuotes() {}, onError() {} })).rejects.toThrow("Source capability not implemented");
  }
  expect(requests).toBe(0);
});

test("neutral kline contract rejects missing interval or basis instead of silently choosing one", async () => {
  const source = client();
  await expect(source.fetchKlines({ symbol: "600000.SH", interval: "1d" } as any)).rejects.toThrow("Invalid kline request");
  await expect(source.fetchKlines({ symbol: "600000.SH", adjustment: "forward" } as any)).rejects.toThrow("Invalid kline request");
});

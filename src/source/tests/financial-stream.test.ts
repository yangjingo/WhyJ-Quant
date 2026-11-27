import { expect, test } from "bun:test";
import { createMarketDataSource } from "../index.ts";

const quote = { symbol: "600000.SH", region: "CN", timestamp: 1794553202000, last_price: 10, prev_close: 9, open: 9, high: 10, low: 9, volume: 100, amount: null };
test("five neutral financial datasets map documented fields and preserve announcement time", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url); requests.push(url.pathname);
    expect(req.headers.get("x-api-key")).toBe("private-fixture");
    expect(url.searchParams.get("start_date")).toBe("2025-01-01");
    expect(url.searchParams.get("end_date")).toBe("2025-12-31");
    expect(url.searchParams.get("latest")).toBe("true");
    return Response.json({ data: { "600000.SH": [{ period_end: "2025-12-31", announce_date: "2026-04-01", revenue: 10, total_assets: 20, net_operating_cash_flow: 30, roe: .2, total_shares: 50 }] } });
  } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "private-fixture", baseUrl: server.url.origin });
    for (const [kind, field, expected] of [["income", "revenue", 10], ["balance-sheet", "totalAssets", 20], ["cash-flow", "netOperatingCashFlow", 30], ["metrics", "roe", .2], ["shares", "totalShares", 50]] as const) {
      const response = await source.fetchFinancials({ kind, symbols: ["600000.SH"], startDate: "2025-01-01", endDate: "2025-12-31", latest: true });
      expect(response).toMatchObject({ source: "tickflow", endpoint: `/v1/financials/${kind}`, data: [{ symbol: "600000.SH", periodEnd: "2025-12-31", announcementDate: "2026-04-01", currency: null, values: { [field]: expected } }] });
    }
    expect(requests).toHaveLength(5);
  } finally { server.stop(true); }
});

test("financial response rejects mismatched identity and invalid values", async () => {
  let payload: unknown = { data: { "000001.SZ": [] } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(payload) });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", baseUrl: server.url.origin });
    await expect(source.fetchFinancials({ kind: "income", symbols: ["600000.SH"] })).rejects.toThrow("identity mismatch");
    payload = { data: { "600000.SH": [{ period_end: "2025-12-31", revenue: "100" }] } };
    await expect(source.fetchFinancials({ kind: "income", symbols: ["600000.SH"] })).rejects.toThrow("response invalid");
  } finally { server.stop(true); }
});

test("quote stream waits for acknowledgement, maps ticks and closes on caller request", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, instance) { const url = new URL(req.url); if (url.searchParams.get("api_key") !== "fixture") return new Response("denied", { status: 401 });
      return instance.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 }); },
    websocket: { message(ws, message) { const value = JSON.parse(String(message));
      ws.send(JSON.stringify({ op: "subscribed", channel: "quotes", symbols: value.symbols, total: 1 }));
      ws.send(JSON.stringify({ op: "quotes", data: [{ ...quote, ext: { turnover_rate: 0 } }] })); } },
  });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", baseUrl: server.url.origin });
    const delivered = Promise.withResolvers<unknown>();
    const subscription = await source.subscribeQuotes({ symbols: ["600000.SH"] },
      { onQuotes: event => delivered.resolve(event.data[0]), onError: delivered.reject }, { timeoutMs: 3000 });
    expect(await delivered.promise).toMatchObject({ lastPrice: 10, reportedTurnoverFraction: 0 });
    subscription.close(); await subscription.closed;
  } finally { server.stop(true); }
});

test("quote stream rejects an explicit permission error without exposing provider message", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, instance) { return instance.upgrade(req) ? undefined : new Response("bad"); },
    websocket: { message(ws) { ws.send(JSON.stringify({ op: "error", message: "private-fixture no permission" })); } } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "private-fixture", baseUrl: server.url.origin });
    try { await source.subscribeQuotes({ symbols: ["600000.SH"] }, { onQuotes: () => {}, onError: () => {} }, { timeoutMs: 3000 }); throw new Error("unexpected success"); }
    catch (error) { expect(String(error)).toContain("rejected"); expect(String(error)).not.toContain("private-fixture"); }
  } finally { server.stop(true); }
});

test("quote stream supports cancellation after acknowledgement and reports closure", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, instance) { return instance.upgrade(req) ? undefined : new Response("bad"); },
    websocket: { message(ws, message) { const value = JSON.parse(String(message)); ws.send(JSON.stringify({ op: "subscribed", channel: "quotes", symbols: value.symbols, total: value.symbols.length })); } } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", baseUrl: server.url.origin }), abort = new AbortController();
    const subscription = await source.subscribeQuotes({ symbols: ["600000.SH"] }, { onQuotes: () => {}, onError: () => {} }, { signal: abort.signal, timeoutMs: 3000 });
    abort.abort(); await subscription.closed;
  } finally { server.stop(true); }
});

test("quote stream rejects malformed acknowledgement without returning a subscription", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, instance) { return instance.upgrade(req) ? undefined : new Response("bad"); },
    websocket: { message(ws) { ws.send(JSON.stringify({ op: "subscribed", channel: "quotes", symbols: ["000001.SZ"], total: 1 })); } } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", baseUrl: server.url.origin });
    await expect(source.subscribeQuotes({ symbols: ["600000.SH"] }, { onQuotes: () => {}, onError: () => {} }, { timeoutMs: 3000 })).rejects.toThrow("response invalid");
  } finally { server.stop(true); }
});

test("quote stream rejects malformed updates after acknowledgement and ends the subscription", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, instance) { return instance.upgrade(req) ? undefined : new Response("bad"); },
    websocket: { message(ws, message) { const value = JSON.parse(String(message)); ws.send(JSON.stringify({ op: "subscribed", channel: "quotes", symbols: value.symbols, total: 1 })); ws.send(JSON.stringify({ op: "quotes", data: [{ ...quote, symbol: "000001.SZ" }] })); } } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", baseUrl: server.url.origin });
    let result = ""; const subscription = await source.subscribeQuotes({ symbols: ["600000.SH"] }, { onQuotes: () => { throw new Error("unexpected"); }, onError: error => { result = error.message; } }, { timeoutMs: 3000 });
    await subscription.closed; expect(result).toContain("response invalid");
  } finally { server.stop(true); }
});

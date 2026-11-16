import { afterEach, expect, test } from "bun:test";
import { fetchFromTickFlowDetailed, fetchTickFlowFactors, fetchTickFlowKlines, fetchTickFlowQuotes } from "../src/tickflow.ts";
import { providerOrderFor, pullBarsFromProviders } from "../src/source-providers.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const options = { apiKey: "private-tickflow-fixture", env: {} };
const first = Date.parse("2026-11-12T00:00:00+08:00"), second = first + 86400_000;
const compact = () => ({ timestamp: [second, first], open: [10, 9], high: [12, 11], low: [9, 8], close: [11, 10], volume: [100, 90], amount: [null, 900] });
function mock(data: unknown) { globalThis.fetch = (async () => Response.json(data)) as unknown as typeof fetch; }

test("native daily HTTP uses a header key, Shanghai dates and explicit forward adjustment", async () => {
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    calls++; const url = new URL(String(input));
    expect(url.origin).toBe("https://api.tickflow.org"); expect(url.pathname).toBe("/v1/klines");
    expect(url.searchParams.get("symbol")).toBe("600000.SH"); expect(url.searchParams.get("period")).toBe("1d");
    expect(url.searchParams.get("start_time")).toBe(String(first)); expect(url.searchParams.get("end_time")).toBe(String(second + 86400_000 - 1));
    expect(url.searchParams.get("adjust")).toBe("forward"); expect(url.searchParams.get("count")).toBe("10000");
    expect(String(input)).not.toContain(options.apiKey); expect(new Headers(init?.headers).get("x-api-key")).toBe(options.apiKey);
    expect(init?.redirect).toBe("error"); return Response.json({ data: compact() });
  }) as typeof fetch;
  const result = await fetchFromTickFlowDetailed("600000.SH", "2026-11-12", "2026-11-13", options);
  expect(result).toEqual({ bars: [
    { date: "2026-11-12", open: 9, high: 11, low: 8, close: 10, volume: 90, amount: 900 },
    { date: "2026-11-13", open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null },
  ], endpoint: "tickflow_daily_forward", adjustment: "forward-adjusted" });
  expect(calls).toBe(1);
});

test("minute observations retain distinct timestamps, period and unadjusted basis", async () => {
  const data = compact(); data.timestamp = [first + 60_000, first]; mock({ data });
  const result = await fetchTickFlowKlines("600000.SH", { period: "1m", adjustment: "none", count: 2 }, options);
  expect(result.period).toBe("1m"); expect(result.adjustment).toBe("none");
  expect(result.rows.map(row => row.timestamp)).toEqual([first, first + 60_000]);
  expect(result.rows[0]).not.toHaveProperty("date");
});

test("missing turnover stays null; empty data is distinct from an invalid response", async () => {
  const { amount, ...data } = compact(); mock({ data });
  expect((await fetchFromTickFlowDetailed("600000.SH", undefined, undefined, options)).bars.every(row => row.amount === null)).toBe(true);
  mock({ data: Object.fromEntries(Object.keys(compact()).map(key => [key, []])) });
  expect((await fetchFromTickFlowDetailed("600000.SH", undefined, undefined, options)).bars).toEqual([]);
  mock({ data: {} }); await expect(fetchTickFlowKlines("600000.SH", {}, options)).rejects.toThrow("response invalid");
});

test("compact column mismatches, invalid OHLCV, repeated timestamps and out-of-window rows fail as a whole", async () => {
  const cases = [
    { ...compact(), close: [11] }, { ...compact(), amount: [null] }, { ...compact(), high: [8, 11] },
    { ...compact(), volume: [-1, 90] }, { ...compact(), open: ["10", 9] }, { ...compact(), amount: [-1, 900] },
    { ...compact(), timestamp: [first, first] }, { ...compact(), timestamp: ["2026-11-13", first] },
    { ...compact(), timestamp: [second + 86400_000, first] },
  ];
  for (const data of cases) {
    mock({ data });
    await expect(fetchTickFlowKlines("600000.SH", { startTime: first, endTime: second }, options)).rejects.toThrow("response invalid");
  }
  mock({ data: { ...compact(), timestamp: [first + 60_000, first] } });
  await expect(fetchFromTickFlowDetailed("600000.SH", undefined, undefined, options)).rejects.toThrow("response invalid");
});

test("declared identity conflicts and bounded windows at the response cap are rejected", async () => {
  for (const payload of [{ symbol: "000001.SZ", data: compact() }, { data: { symbol: "000001.SZ", ...compact() } }]) {
    mock(payload); await expect(fetchTickFlowKlines("600000.SH", {}, options)).rejects.toThrow("identity mismatch");
  }
  mock({ data: compact() });
  await expect(fetchTickFlowKlines("600000.SH", { count: 2, startTime: first, endTime: second }, options)).rejects.toThrow("response truncated");
});

test("unsupported symbols, periods, ranges and unsafe base URLs fail before a request", async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  for (const symbol of ["AAPL", "00700.HK", "270042.OF"])
    await expect(fetchTickFlowKlines(symbol, {}, options)).rejects.toThrow();
  for (const query of [{ period: "1w" as "1d" }, { count: 10001 }, { count: 0 }, { startTime: second, endTime: first }, { startTime: -1 }])
    await expect(fetchTickFlowKlines("600000.SH", query, options)).rejects.toThrow();
  for (const baseUrl of ["http://remote.example", "https://user:secret@example.com", "https://example.com?key=secret", "invalid"])
    await expect(fetchTickFlowKlines("600000.SH", {}, { ...options, baseUrl })).rejects.toThrow("Invalid TickFlow base URL");
  await expect(fetchTickFlowKlines("600000.SH", {}, { env: {} })).rejects.toThrow("not configured");
  expect(calls).toBe(0);
});

test("upstream HTTP and malformed bodies do not expose response text or transport secrets", async () => {
  for (const status of [401, 403, 429, 500]) {
    globalThis.fetch = (async () => new Response(options.apiKey, { status, statusText: options.apiKey })) as unknown as typeof fetch;
    await expect(fetchTickFlowKlines("600000.SH", {}, options)).rejects.toThrow(new RegExp(`^HTTP ${status}$`));
  }
  globalThis.fetch = (async () => { throw new Error("Network failure " + options.apiKey); }) as unknown as typeof fetch;
  try { await fetchTickFlowKlines("600000.SH", {}, options); throw new Error("unexpected success"); }
  catch (error) { expect(String(error)).not.toContain(options.apiKey); }
  globalThis.fetch = (async () => new Response("x".repeat(8 * 1024 * 1024 + 1))) as unknown as typeof fetch;
  await expect(fetchTickFlowKlines("600000.SH", {}, options)).rejects.toThrow("response truncated");
});

test("explicit cancellation aborts the request without retrying or returning partial bars", async () => {
  const controller = new AbortController(); let calls = 0;
  globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
    calls++; init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    queueMicrotask(() => controller.abort(new Error("caller cancelled")));
  })) as typeof fetch;
  await expect(fetchTickFlowKlines("600000.SH", {}, { ...options, signal: controller.signal })).rejects.toThrow("caller cancelled");
  expect(calls).toBe(1);
});

test("factors retain source timestamps and require exact requested identities", async () => {
  mock({ data: { "600000.SH": [{ timestamp: second, ex_factor: 2 }, { timestamp: first, ex_factor: 1 }] } });
  expect(await fetchTickFlowFactors(["600000.SH"], {}, options)).toEqual({ "600000.SH": [{ timestamp: first, factor: 1 }, { timestamp: second, factor: 2 }] });
  mock({ data: { "000001.SZ": [] } });
  await expect(fetchTickFlowFactors(["600000.SH"], {}, options)).rejects.toThrow("identity mismatch");
  for (const rows of [null, [{ timestamp: first, ex_factor: 0 }], [{ timestamp: first, ex_factor: 1 }, { timestamp: first, ex_factor: 2 }]]) {
    mock({ data: { "600000.SH": rows } }); await expect(fetchTickFlowFactors(["600000.SH"], {}, options)).rejects.toThrow("response invalid");
  }
  mock({ data: {} }); await expect(fetchTickFlowFactors(["600000.SH"], {}, options)).rejects.toThrow("response invalid");
});

test("quotes expose source timestamps and missing symbols, rejecting foreign identities", async () => {
  const quote = { symbol: "600000.SH", region: "CN", timestamp: second, last_price: 11, prev_close: 10, open: 10, high: 12, low: 9, volume: 100, amount: 1100 };
  mock({ data: [quote] }); const result = await fetchTickFlowQuotes(["600000.SH", "000001.SZ"], options);
  expect(result.quotes[0]?.timestamp).toBe(second); expect(result.quotes[0]?.lastPrice).toBe(11); expect(result.missingSymbols).toEqual(["000001.SZ"]);
  mock({ data: [{ ...quote, region: "US" }] }); await expect(fetchTickFlowQuotes(["600000.SH"], options)).rejects.toThrow("identity mismatch");
  mock({ data: [quote, quote] }); await expect(fetchTickFlowQuotes(["600000.SH", "000001.SZ"], options)).rejects.toThrow("response invalid");
});

test("TickFlow is explicitly selectable without changing default or cross-market fallback", async () => {
  expect(providerOrderFor("A", "auto")).toEqual(["akshare", "tushare"]);
  expect(providerOrderFor("A", "tickflow")).toEqual(["tickflow", "akshare", "tushare"]);
  expect(providerOrderFor("US", "tickflow")).not.toContain("tickflow");
  mock({ data: compact() }); let credentials = 0;
  const result = await pullBarsFromProviders("600000.SH", "A", "2026-11-12", "2026-11-13", "tickflow", {
    loadCredentials: () => { credentials++; return { tickflow: options }; }, fallbackOrder: { A: ["tickflow"] },
  });
  expect(result.source).toBe("tickflow"); expect(result.bars).toHaveLength(2); expect(result.providerEndpoint).toBe("tickflow_daily_forward");
  expect(result.adjustment).toBe("forward-adjusted"); expect(credentials).toBe(1);
});

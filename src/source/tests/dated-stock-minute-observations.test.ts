import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const tradeDate = "2024-04-08", symbol = "600000.SH";
const query = { market: "A", symbol, tradeDate } as const;
const stamp = (time: string) => Date.parse(`${tradeDate}T${time}+08:00`);

function compactFrame(timestamps: number[], code?: string, amount?: (number | null)[]) {
  return { ...(code !== undefined && { symbol: code }), timestamp: timestamps,
    open: timestamps.map(() => 10), high: timestamps.map(() => 11), low: timestamps.map(() => 9), close: timestamps.map(() => 10.5),
    volume: timestamps.map(() => 42), ...(amount === undefined ? {} : { amount }),
  };
}

function payload(timestamps: number[], code = symbol, amount?: (number | null)[]) {
  return Response.json({ data: compactFrame(timestamps, code, amount) });
}

test("reads a bounded latest-session stock batch without treating stale or future labels as current", async () => {
  const observedTime = stamp("10:32:30");
  const clock = spyOn(Date, "now").mockReturnValue(observedTime);
  const symbols = [symbol, "000001.SZ", "830799.BJ", "000002.SZ", "600010.SH"];
  const requests: URL[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("x-api-key") !== "stock-minute-batch-fixture") return new Response(null, { status: 403 });
    requests.push(new URL(request.url));
    return Response.json({ data: {
      "600000.SH": compactFrame([stamp("10:32:00"), stamp("09:31:00")], undefined, [0, 12_300]),
      "000001.SZ": compactFrame([]),
      "000002.SZ": compactFrame([Date.parse("2024-04-03T09:31:00+08:00")]),
      "600010.SH": compactFrame([stamp("10:33:00")]),
    } });
  } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "stock-minute-batch-fixture", baseUrl: server.url.origin, env: {} });
    const observation = await source.fetchCurrentStockMinuteBatch({ symbols: [" 600000.sh ", ...symbols.slice(1)], market: "A", tradeDate });
    expect(observation).toMatchObject({
      source: "tickflow", market: "A", endpoint: "/v1/klines/intraday/batch", coverage: "unknown", observedAt: new Date(observedTime).toISOString(),
      data: { tradeDate, assetType: "stock", interval: "1m", adjustment: "unknown", timeZone: "Asia/Shanghai",
        priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native", timestampLabel: "provider-native",
        finality: "provisional", rowLimitPerSymbol: 300, requestedSymbols: symbols,
        frames: [
          { symbol, status: "observed", sourceTradeDate: tradeDate, rows: [
            { sourceTimestamp: stamp("09:31:00"), open: 10, high: 11, low: 9, close: 10.5, volume: 42, amount: 12_300 },
            { sourceTimestamp: stamp("10:32:00"), close: 10.5, amount: 0 },
          ] },
          { symbol: "000001.SZ", status: "empty", sourceTradeDate: null, rows: [] },
          { symbol: "830799.BJ", status: "missing", sourceTradeDate: null, rows: [] },
          { symbol: "000002.SZ", status: "different-session", sourceTradeDate: "2024-04-03", rows: [] },
          { symbol: "600010.SH", status: "future-timestamp", sourceTradeDate: tradeDate, rows: [] },
        ],
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/klines/intraday/batch");
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ symbols: symbols.join(","), period: "1m", count: "300" });
  } finally { await server.stop(true); clock.mockRestore(); }
});

test("validates the current stock scope and rejects malformed or mixed provider frames", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(stamp("10:32:30"));
  const fetcher = spyOn(globalThis, "fetch");
  const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
  const request = { symbols: [symbol], market: "A", tradeDate } as const;
  try {
    expect(getMarketDataCapabilities("tickflow").observations.fetchCurrentStockMinuteBatch).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tushare").observations.fetchCurrentStockMinuteBatch).toEqual({ status: "not-implemented" });
    await expect(source.fetchCurrentStockMinuteBatch({ ...request, tradeDate: "2024-04-03" })).rejects.toThrow("current Shanghai");
    await expect(source.fetchCurrentStockMinuteBatch({ ...request, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tushare" }).fetchCurrentStockMinuteBatch(request)).rejects.toMatchObject({ code: "unsupported" });
    for (const invalid of [[], [symbol, " 600000.sh "], ["399001.SZ"], ["899050.BJ"], Array(101).fill(symbol)]) {
      await expect(source.fetchCurrentStockMinuteBatch({ ...request, symbols: invalid })).rejects.toThrow();
    }
    await expect(source.fetchCurrentStockMinuteBatch(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(0);
    const day = stamp("09:31:00");
    for (const response of [
      Response.json({ data: { "600001.SH": compactFrame([day]) } }),
      Response.json({ data: { [symbol]: compactFrame([day], "600001.SH") } }),
      Response.json({ data: { [symbol]: compactFrame([day, day]) } }),
      Response.json({ data: { [symbol]: compactFrame([day - 86_400_000, day]) } }),
      Response.json({ data: { [symbol]: { ...compactFrame([day]), close: [] } } }),
      Response.json({ data: { [symbol]: compactFrame(Array.from({ length: 301 }, (_, i) => day + i)) } }),
      new Response(null, { status: 403 }),
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(source.fetchCurrentStockMinuteBatch(request)).rejects.toMatchObject({ code: "provider-failure" });
    }
    expect(fetcher).toHaveBeenCalledTimes(7);
  } finally { fetcher.mockRestore(); clock.mockRestore(); }
});

test("captures one completed stock date from the selected TickFlow source without relabeling or converting", async () => {
  const requests: URL[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("x-api-key") !== "stock-minute-fixture") return new Response(null, { status: 403 });
    requests.push(new URL(request.url));
    return requests.length === 1 ? payload([stamp("15:05:00"), stamp("09:25:00")], symbol, [0, 12_300]) : payload([]);
  } });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "stock-minute-fixture", baseUrl: server.url.origin, env: {} });
    const observation = await source.fetchDatedStockMinutes({ ...query, symbol: " 600000.sh " });
    expect(observation).toMatchObject({ source: "tickflow", market: "A", endpoint: "/v1/klines", coverage: "unknown", observedAt: expect.any(String),
      data: { symbol, tradeDate, interval: "1m", assetType: "stock", adjustment: "none", timestampLabel: "provider-native",
        timeZone: "Asia/Shanghai", priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native", finality: "unknown",
        rows: [
          { sourceTimestamp: stamp("09:25:00"), open: 10, high: 11, low: 9, close: 10.5, volume: 42, amount: 12_300 },
          { sourceTimestamp: stamp("15:05:00"), open: 10, high: 11, low: 9, close: 10.5, volume: 42, amount: 0 },
        ] },
    });
    expect(requests[0]?.pathname).toBe("/v1/klines");
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ symbol, period: "1m", adjust: "none", count: "10000",
      start_time: String(stamp("09:25:00")), end_time: String(stamp("15:05:00")) });
    expect((await source.fetchDatedStockMinutes(query)).data).toMatchObject({ symbol, tradeDate, rows: [] });
    expect(requests).toHaveLength(2);
  } finally { await server.stop(true); }
});

test("rejects malformed requests, provider failures and foreign data independently of empty results", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const tickflow = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
  try {
    expect(getMarketDataCapabilities("tickflow").observations.fetchDatedStockMinutes).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tushare").observations.fetchDatedStockMinutes).toEqual({ status: "not-implemented" });
    await expect(createMarketDataSource({ source: "tushare" }).fetchDatedStockMinutes(query)).rejects.toMatchObject({ code: "unsupported" });
    await expect(tickflow.fetchDatedStockMinutes({ ...query, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    for (const other of ["000001.SH", "399001.SZ", "510300.SH", "600000"]) {
      await expect(tickflow.fetchDatedStockMinutes({ ...query, symbol: other })).rejects.toThrow("exchange-qualified A-share stock");
    }
    for (const date of ["2024-02-30", "9999-12-31"]) {
      await expect(tickflow.fetchDatedStockMinutes({ ...query, tradeDate: date })).rejects.toThrow("completed Shanghai");
    }
    await expect(tickflow.fetchDatedStockMinutes(query, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(payload([stamp("09:31:00")]));
    expect((await tickflow.fetchDatedStockMinutes(query)).data.rows[0]?.amount).toBeNull();
    fetch.mockResolvedValueOnce(new Response("access denied", { status: 403 }));
    await expect(tickflow.fetchDatedStockMinutes(query)).rejects.toMatchObject({ code: "provider-failure" });
    for (const response of [payload([stamp("09:24:59")]), payload([stamp("15:05:01")]),
      payload([stamp("09:31:00"), stamp("09:31:00")]), payload([stamp("09:31:00")], "600001.SH")]) {
      fetch.mockResolvedValueOnce(response);
      await expect(tickflow.fetchDatedStockMinutes(query)).rejects.toThrow();
    }
    expect(fetch).toHaveBeenCalledTimes(6);
  } finally { fetch.mockRestore(); }
});

import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const tradeDate = "2024-04-08", symbol = "600000.SH";
const query = { market: "A", symbol, tradeDate } as const;
const stamp = (time: string) => Date.parse(`${tradeDate}T${time}+08:00`);

function payload(timestamps: number[], code = symbol, amount?: (number | null)[]) {
  return Response.json({ data: { symbol: code, timestamp: timestamps,
    open: timestamps.map(() => 10), high: timestamps.map(() => 11), low: timestamps.map(() => 9), close: timestamps.map(() => 10.5),
    volume: timestamps.map(() => 42), ...(amount === undefined ? {} : { amount }),
  } });
}

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

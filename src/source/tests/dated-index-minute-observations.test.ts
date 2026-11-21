import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const query = { market: "A", symbol: " 000001.sh ", tradeDate: "2024-04-08" } as const;
const stamp = (time: string) => Date.parse(query.tradeDate + "T" + time + "+08:00");
function payload(timestamp: number[], symbol = "000001.SH", amount?: number[]) {
  return Response.json({ data: { symbol, timestamp,
    open: timestamp.map(() => 3_002), high: timestamp.map(() => 3_007),
    low: timestamp.map(() => 2_999), close: timestamp.map(() => 3_005),
    volume: timestamp.map(() => 42), ...(amount !== undefined && { amount }),
  } });
}

test("requests exactly one Shanghai index session and retains native labels and numeric observations", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  const selected = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
  try {
    fetcher.mockResolvedValueOnce(payload([stamp("15:05:00"), stamp("09:25:00")], "000001.SH", [111, 222]));
    expect(await selected.fetchDatedIndexMinutes(query)).toMatchObject({
      source: "tickflow", endpoint: "/v1/klines", market: "A", observedAt: expect.any(String), coverage: "unknown",
      data: {
        symbol: "000001.SH", tradeDate: query.tradeDate, interval: "1m", priceBasis: "index-level", priceUnit: "index-points",
        volumeUnit: "provider-native", amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native",
        rows: [
          { sourceTimestamp: stamp("09:25:00"), openPoints: 3_002, highPoints: 3_007, lowPoints: 2_999, closePoints: 3_005, volume: 42, amount: 222 },
          { sourceTimestamp: stamp("15:05:00"), openPoints: 3_002, highPoints: 3_007, lowPoints: 2_999, closePoints: 3_005, volume: 42, amount: 111 },
        ],
      },
    });
    const [rawUrl, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin + url.pathname).toBe("https://api.tickflow.org/v1/klines");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: "000001.SH", period: "1m", adjust: "none", count: "10000",
      start_time: String(stamp("09:25:00")), end_time: String(stamp("15:05:00")),
    });
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture");
    fetcher.mockResolvedValueOnce(payload([stamp("10:00:00")], "899050.BJ"));
    expect((await selected.fetchDatedIndexMinutes({ ...query, symbol: "899050.BJ" })).data.rows[0]?.amount).toBeNull();
    fetcher.mockResolvedValueOnce(payload([]));
    expect((await selected.fetchDatedIndexMinutes(query)).data).toMatchObject({ tradeDate: query.tradeDate, rows: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { fetcher.mockRestore(); }
});

test("separates an empty dated result from permission, identity, malformed and unsupported inputs", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  const selected = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
  try {
    expect(getMarketDataCapabilities("tickflow").observations.fetchDatedIndexMinutes).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tushare").observations.fetchDatedIndexMinutes).toEqual({ status: "not-implemented" });
    await expect(selected.fetchDatedIndexMinutes({ ...query, symbol: "000001.SZ" })).rejects.toThrow("exchange-qualified");
    await expect(selected.fetchDatedIndexMinutes({ ...query, tradeDate: "2024-02-30" })).rejects.toThrow("completed Shanghai");
    await expect(selected.fetchDatedIndexMinutes({ ...query, tradeDate: "9999-12-31" })).rejects.toThrow("completed Shanghai");
    await expect(selected.fetchDatedIndexMinutes({ ...query, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tushare" }).fetchDatedIndexMinutes(query)).rejects.toMatchObject({ code: "unsupported" });
    const abort = new AbortController();
    abort.abort();
    await expect(selected.fetchDatedIndexMinutes(query, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(selected.fetchDatedIndexMinutes(query)).rejects.toMatchObject({ code: "provider-failure" });
    for (const response of [
      payload([stamp("09:24:59")]), payload([stamp("15:05:01")]),
      payload([stamp("10:00:00")], "399001.SZ"), payload([stamp("10:00:00"), stamp("10:00:00")]),
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(selected.fetchDatedIndexMinutes(query)).rejects.toThrow();
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
  } finally { fetcher.mockRestore(); }
});
test("reads the requested historical index session through a loopback TickFlow endpoint", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests++;
      const url = new URL(request.url);
      if (url.pathname !== "/v1/klines" || url.searchParams.get("symbol") !== "399001.SZ" ||
        url.searchParams.get("period") !== "1m" || url.searchParams.get("start_time") !== String(stamp("09:25:00")) ||
        request.headers.get("x-api-key") !== "fixture") return new Response("", { status: 400 });
      return payload([stamp("09:31:00")], "399001.SZ");
    },
  });
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "fixture", baseUrl: server.url.origin, env: {} });
    const result = await source.fetchDatedIndexMinutes({ ...query, symbol: "399001.SZ" });
    expect(result.data.rows).toMatchObject([{ sourceTimestamp: stamp("09:31:00"), closePoints: 3_005 }]);
    expect(requests).toBe(1);
  } finally { await server.stop(true); }
});

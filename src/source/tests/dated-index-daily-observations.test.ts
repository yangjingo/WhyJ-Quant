import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const query = { market: "A", symbol: " 000001.sh ", start: "2024-02-28", end: "2024-02-29" } as const;
const start = Date.parse(query.start + "T00:00:00+08:00");
const end = Date.parse("2024-03-01T00:00:00+08:00") - 1;
const selected = () => createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });

function frame(symbol: string, timestamp: number[], amount?: (number | null)[]) {
  return Response.json({ data: { symbol, timestamp, open: timestamp.map(() => 3_000), high: timestamp.map(() => 3_020),
    low: timestamp.map(() => 2_995), close: timestamp.map(() => 3_010), volume: timestamp.map(() => 0),
    ...(amount !== undefined && { amount }),
  } });
}

test("retains index daily OHLC for exact Shanghai dates, native units and exchange-qualified codes", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    for (const symbol of ["000001.SH", "399001.SZ", "899050.BJ"]) {
      fetcher.mockResolvedValueOnce(frame(symbol, [end, start], [0, null]));
      const result = await selected().fetchDatedIndexDailyBars({ ...query, symbol: symbol === "000001.SH" ? query.symbol : symbol });
      expect(result).toEqual({
        source: "tickflow", endpoint: "/v1/klines", market: "A", coverage: "unknown", observedAt: expect.any(String),
        data: { symbol, requested: { start: query.start, end: query.end }, interval: "1d", priceBasis: "index-level",
          priceUnit: "index-points", volumeUnit: "provider-native", amountUnit: "provider-native",
          timeZone: "Asia/Shanghai", timestampLabel: "provider-native", rows: [
            { tradeDate: query.start, sourceTimestamp: start, openPoints: 3_000, highPoints: 3_020,
              lowPoints: 2_995, closePoints: 3_010, volume: 0, amount: null },
            { tradeDate: query.end, sourceTimestamp: end, openPoints: 3_000, highPoints: 3_020,
              lowPoints: 2_995, closePoints: 3_010, volume: 0, amount: 0 },
          ],
        },
      });
      const [url, init] = fetcher.mock.calls.at(-1)!;
      expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({
        symbol, period: "1d", adjust: "none", count: "10000", start_time: String(start), end_time: String(end),
      });
      expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture");
    }
    fetcher.mockResolvedValueOnce(frame("000001.SH", []));
    expect((await selected().fetchDatedIndexDailyBars(query)).data).toMatchObject({ requested: { start: query.start, end: query.end }, rows: [] });
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { fetcher.mockRestore(); }
});

test("strictly rejects duplicate dates, incompatible scope, malformed data and provider failures", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    expect(getMarketDataCapabilities("tickflow").observations.fetchDatedIndexDailyBars).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tushare").observations.fetchDatedIndexDailyBars).toEqual({ status: "not-implemented" });
    const source = selected();
    await expect(source.fetchDatedIndexDailyBars({ ...query, symbol: "000001.SZ" })).rejects.toThrow("exchange-qualified");
    await expect(source.fetchDatedIndexDailyBars({ ...query, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tushare" }).fetchDatedIndexDailyBars(query)).rejects.toMatchObject({ code: "unsupported" });
    await expect(source.fetchDatedIndexDailyBars({ ...query, end: "9999-12-31" })).rejects.toThrow("Completed Shanghai");
    await expect(source.fetchDatedIndexDailyBars({ ...query, end: "2025-03-01" })).rejects.toThrow("366 calendar days");
    await expect(source.fetchDatedIndexDailyBars(query, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    for (const response of [
      frame("000001.SH", [start, start + 60_000]), frame("000001.SH", [end + 1]), frame("399001.SZ", [start]),
      frame("000001.SH", [start], [-1]), new Response("denied", { status: 403 }),
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(source.fetchDatedIndexDailyBars(query)).rejects.toMatchObject({ code: "provider-failure" });
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
  } finally { fetcher.mockRestore(); }
});

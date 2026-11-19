import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const request = { symbol: "600000.SH", market: "A", start: "2023-08-25", end: "2023-08-25" } as const;
const fields = ["trade_time", "ts_code", "close", "open", "high", "low", "vol", "amount"];
const row = (clock: string, volume = 100, amount: number | null = 990) =>
  [`${request.start} ${clock}:00`, request.symbol, 9.90, 9.91, 9.94, 9.88, volume, amount];
const payload = (items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });

test("historical minute observations preserve endpoint, units, all time labels, and zero trade data", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(payload([row("15:00"), row("13:01"), row("11:30", 0, 0), row("09:31", 0, 0), row("09:30", 10, null)]));
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const result = await source.fetchHistoricalMinuteBars(request);
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body))).toMatchObject({ api_name: "stk_mins", params: {
      ts_code: request.symbol, freq: "1min", start_date: "2023-08-25 09:00:00", end_date: "2023-08-25 19:00:00",
    } });
    expect(http.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(result).toMatchObject({ source: "tushare", endpoint: "stk_mins", coverage: "unknown", market: "A",
      observedAt: expect.any(String), data: { timeZone: "Asia/Shanghai", interval: "1m", volumeUnit: "share", amountUnit: "CNY",
        adjustment: "unknown", finality: "unknown", requested: { start: request.start, end: request.end } } });
    expect(result.data.bars.map(bar => [bar.tradeTime, bar.openingBoundary])).toEqual([
      ["2023-08-25 09:30:00", true], ["2023-08-25 09:31:00", false], ["2023-08-25 11:30:00", false],
      ["2023-08-25 13:01:00", false], ["2023-08-25 15:00:00", false],
    ]);
    expect(result.data.bars[0]).toMatchObject({ symbol: request.symbol, tradeDate: request.start, volume: 10, amount: null });
    expect(result.data.bars[1]).toMatchObject({ volume: 0, amount: 0 });
    expect(getMarketDataCapabilities("tushare").observations.fetchHistoricalMinuteBars).toEqual({ status: "implemented", markets: ["A"] });
    http.mockResolvedValueOnce(payload([]));
    expect((await source.fetchHistoricalMinuteBars(request)).data.bars).toEqual([]);
  } finally { http.mockRestore(); }
});

test("historical minute observations reject invalid provider payloads and unsupported queries without fallback", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const invalidRows = [
      [row("09:30"), row("09:30")], [row("12:00")], [row("09:31", 0.5)], [row("09:31", 100, -1)],
      [["2023-08-24 09:31:00", ...row("09:31").slice(1)]],
      [[row("09:31")[0]!, "000001.SZ", ...row("09:31").slice(2)]], [row("09:31").slice(0, -1)],
    ];
    for (const items of invalidRows) {
      http.mockResolvedValueOnce(payload(items));
      await expect(source.fetchHistoricalMinuteBars(request)).rejects.toThrow();
    }
    for (const invalid of [
      { ...request, symbol: "000300.SH" }, { ...request, symbol: "899050.BJ" },
      { ...request, start: "2023-07-01" }, { ...request, end: "2099-01-01" },
    ]) await expect(source.fetchHistoricalMinuteBars(invalid)).rejects.toThrow();
    const tickflow = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
    await expect(tickflow.fetchHistoricalMinuteBars(request)).rejects.toMatchObject({ code: "unsupported" });
    expect(http).toHaveBeenCalledTimes(invalidRows.length);
  } finally { http.mockRestore(); }
});

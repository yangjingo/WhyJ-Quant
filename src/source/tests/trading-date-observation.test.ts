import { expect, test } from "bun:test";
import { createMarketDataSource, toTradingDateBarObservations } from "../index.ts";
import type { TradingDateKlineResult } from "../index.ts";

const timestamp = Date.parse("2024-01-01T16:00:00Z");
const dated = (): TradingDateKlineResult => ({ timeMode: "trading-date", symbol: "600000.SH", market: "A", assetType: "stock",
  calendarTimeZone: "Asia/Shanghai", requested: { startDate: "2024-01-02", endDate: "2024-01-03" }, interval: "1d", adjustment: "none",
  source: "tushare", endpoint: "daily", observedAt: "2024-01-05T00:00:00.000Z", coverage: "unknown", volumeUnit: "hand", amountUnit: "CNY-thousand",
  data: [{ tradeDate: "2024-01-02", sourceTimestamp: null, open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null }] });

test("date records preserve both providers' units and timestamp semantics without fetching", () => {
  const result = dated();
  expect(toTradingDateBarObservations(result)).toEqual([{ schemaVersion: 2, kind: "trading_date_daily_bar", symbol: "600000.SH",
    tradeDate: "2024-01-02", sourceTimestamp: null, requested: result.requested, market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
    source: "tushare", endpoint: "daily", observedAt: result.observedAt, interval: "1d", adjustment: "none", volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown",
    values: { open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null } }]);
  const tick = { ...result, source: "tickflow" as const, endpoint: "/v1/klines", volumeUnit: "unknown" as const, amountUnit: "unknown" as const,
    adjustment: "forward" as const, data: [{ ...result.data[0]!, sourceTimestamp: timestamp }] };
  expect(toTradingDateBarObservations(tick)[0]).toMatchObject({ source: "tickflow", tradeDate: "2024-01-02", sourceTimestamp: timestamp, adjustment: "forward", volumeUnit: "unknown" });
  expect(toTradingDateBarObservations({ ...result, data: [] })).toEqual([]);
  const requested = { ...result.requested, extra: "discard" };
  expect(toTradingDateBarObservations({ ...result, requested })[0]!.requested).toEqual(result.requested);
});

test("rejects contradictory metadata, invalid values, timestamps and dates without partial data", () => {
  const r = dated(), row = r.data[0]!;
  const tick = { ...r, source: "tickflow" as const, endpoint: "/v1/klines", volumeUnit: "unknown" as const, amountUnit: "unknown" as const };
  const invalid = [
    { ...r, requested: { startDate: "2024-02-30", endDate: "2024-03-01" } },
    { ...r, requested: { startDate: "2023-01-01", endDate: "2024-01-03" } },
    { ...r, data: [row, row] }, { ...r, data: [row, { ...row, tradeDate: "2024-01-04" }] },
    { ...r, data: [{ ...row, sourceTimestamp: timestamp }] }, { ...r, volumeUnit: "unknown" },
    { ...r, adjustment: "forward" }, { ...r, source: "akshare" }, { ...r, endpoint: "/v1/klines" }, { ...r, symbol: "000001.SH" },
    { ...r, data: [{ ...row, volume: -1 }] }, { ...r, data: [{ ...row, close: 13 }] },
    { ...tick, data: [{ ...row, sourceTimestamp: timestamp - 1 }] }, { ...tick, data: [{ ...row, sourceTimestamp: null }] },
  ];
  for (const value of invalid) expect(() => toTradingDateBarObservations(value as TradingDateKlineResult)).toThrow("Invalid Source observation result");
});

test("selected Tushare result flows directly through the date converter", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ code: 0, data: { fields: ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"],
    items: [["600000.SH", "20240102", 10, 12, 9, 11, 100, null]] } }); }) as unknown as typeof fetch;
  try {
    const result = await createMarketDataSource({ source: "tushare", apiKey: "synthetic", env: {} }).fetchKlines({ timeMode: "trading-date", symbol: "600000.SH",
      assetType: "stock", interval: "1d", adjustment: "none", startDate: "2024-01-02", endDate: "2024-01-03" });
    expect(toTradingDateBarObservations(result)[0]).toMatchObject({ source: "tushare", tradeDate: "2024-01-02", sourceTimestamp: null, volumeUnit: "hand" });
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

test("selected TickFlow result retains its actual timestamp through the converter", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ data: { timestamp: [timestamp], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } }); }) as unknown as typeof fetch;
  try {
    const result = await createMarketDataSource({ source: "tickflow", apiKey: "synthetic", env: {} }).fetchKlines({ timeMode: "trading-date", symbol: "600000.SH",
      assetType: "stock", interval: "1d", adjustment: "none", startDate: "2024-01-02", endDate: "2024-01-03" });
    expect(toTradingDateBarObservations(result)[0]).toMatchObject({ source: "tickflow", tradeDate: "2024-01-02", sourceTimestamp: timestamp, volumeUnit: "unknown" });
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

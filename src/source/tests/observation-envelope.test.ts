import { expect, test } from "bun:test";
import { createMarketDataSource, toBarObservations, toFactorObservations } from "../index.ts";
import type { KlineResult, AdjustmentFactor, ObservationResult } from "../index.ts";

const time = 1762992000000;
const base = { source: "tickflow" as const, endpoint: "/v1/klines", observedAt: "2026-11-13T01:02:03.000Z", units: "unknown" as const };
const row = { timestamp: time, open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null };
const bar = (): KlineResult => ({ ...base, symbol: "600000.SH", interval: "1d", adjustment: "none", data: [{ ...row }] });
const factors = (): ObservationResult<Record<string, AdjustmentFactor[]>> => ({ ...base, endpoint: "/v1/klines/ex-factors", data: {
  "600000.SH": [{ timestamp: time, factor: 1.25 }], "000001.SZ": [{ timestamp: time, factor: 2 }],
} });

test("daily and minute records preserve source values, basis, timestamps and unknowns", () => {
  const daily = toBarObservations(bar());
  expect(daily).toEqual([{ schemaVersion: 1, kind: "daily_bar", symbol: "600000.SH", timestamp: time,
    source: "tickflow", endpoint: "/v1/klines", observedAt: base.observedAt, units: "unknown", finality: "unknown",
    market: "unknown", assetType: "unknown", timezone: "UTC", sourceAsOf: "unknown", quality: "unknown",
    coverage: "unknown", revision: "unknown", interval: "1d", adjustment: "none",
    values: { open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null } }]);
  const minute = { ...bar(), interval: "5m" as const, adjustment: "forward" as const, data: [{ ...row, timestamp: time + 300000, amount: 0 }, { ...row }] };
  expect(toBarObservations(minute).map(value => [value.kind, value.timestamp, value.interval, value.adjustment, value.values.amount]))
    .toEqual([["minute_bar", time + 300000, "5m", "forward", 0], ["minute_bar", time, "5m", "forward", null]]);
  expect(toBarObservations({ ...bar(), data: [] })).toEqual([]);
});

test("factors retain each symbol and factor without asserting basis or applying it", () => {
  const result = toFactorObservations(factors());
  expect(result.map(value => [value.kind, value.symbol, value.timestamp, value.values.factor, value.factorBasis]))
    .toEqual([["adjustment_factor", "600000.SH", time, 1.25, "unknown"], ["adjustment_factor", "000001.SZ", time, 2, "unknown"]]);
  expect(result.every(value => value.coverage === "unknown" && value.units === "unknown" && value.endpoint === "/v1/klines/ex-factors")).toBe(true);
  expect(toFactorObservations({ ...factors(), data: {} })).toEqual([]);
});

test("malformed, duplicate or incompatible data fails without a partial result", () => {
  for (const value of [
    { ...bar(), symbol: "" }, { ...bar(), interval: "2m" }, { ...bar(), adjustment: "unknown" },
    { ...bar(), observedAt: "2026-02-30T01:02:03Z" }, { ...bar(), observedAt: "2026-01-01" },
    { ...bar(), units: "shares" }, { ...bar(), data: [row, row] },
    { ...bar(), data: [{ ...row, timestamp: NaN }] }, { ...bar(), data: [{ ...row, volume: -1 }] },
    { ...bar(), data: [{ ...row, close: 13 }] }, { ...bar(), data: [{ ...row, amount: undefined }] },
  ]) expect(() => toBarObservations(value as KlineResult)).toThrow("Invalid Source observation result");
  for (const data of [{ "": [{ timestamp: time, factor: 1 }] }, { "600000.SH": [{ timestamp: time, factor: 0 }] },
    { "600000.SH": [{ timestamp: time, factor: 1 }, { timestamp: time, factor: 2 }] }, { "600000.SH": null }])
    expect(() => toFactorObservations({ ...factors(), data } as unknown as ReturnType<typeof factors>)).toThrow("Invalid Source observation result");
});

test("selected TickFlow facade results feed the same envelope without fallback or another request", async () => {
  const original = globalThis.fetch; const paths: string[] = [];
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    return path.endsWith("ex-factors") ? Response.json({ data: { "600000.SH": [{ timestamp: time, ex_factor: 1.25 }] } })
      : Response.json({ data: { timestamp: [time], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } });
  }) as typeof fetch;
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "synthetic", env: {} });
    const daily = await source.fetchKlines({ symbol: "600000.SH", interval: "1d", adjustment: "none", startTime: time, endTime: time });
    const minute = await source.fetchKlines({ symbol: "600000.SH", interval: "1m", adjustment: "forward", startTime: time, endTime: time });
    const adjustment = await source.fetchAdjustmentFactors({ symbols: ["600000.SH"], startTime: time, endTime: time });
    expect(toBarObservations(daily)[0]).toMatchObject({ kind: "daily_bar", source: "tickflow", timestamp: time, adjustment: "none" });
    expect(toBarObservations(minute)[0]).toMatchObject({ kind: "minute_bar", source: "tickflow", timestamp: time, adjustment: "forward" });
    expect(toFactorObservations(adjustment)[0]).toMatchObject({ kind: "adjustment_factor", symbol: "600000.SH", values: { factor: 1.25 } });
    expect(paths).toEqual(["/v1/klines", "/v1/klines", "/v1/klines/ex-factors"]);
  } finally { globalThis.fetch = original; }
});

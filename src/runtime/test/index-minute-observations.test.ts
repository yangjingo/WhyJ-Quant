import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, readSettings, saveSettings, type StoredBenchmarkIndexBatch } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectDatedIndexMinutes, replayDatedIndexMinutes } from "../data/index-minute-observations.ts";

const date = "2024-02-05";
const previousDate = "2024-02-02";
const symbol = "899050.BJ";
const times = [Date.parse(date + "T09:31:00+08:00"), Date.parse(date + "T09:32:00+08:00")];
const calendar = { revision: "fixture-calendar", previousTradeDate: previousDate, tradeDate: date };
const providerData = { symbol, timestamp: times, open: [800, 800], high: [810, 820],
  low: [790, 795], close: [800, 816], volume: [0, 42], amount: [0, 876] };
const emptyData = { symbol, timestamp: [], open: [], high: [], low: [], close: [], volume: [] };
const daily = (identity = symbol): StoredBenchmarkIndexBatch => ({
  symbol: identity, source: "tickflow", market: "A", endpoint: "/v1/klines", coverage: "unknown",
  observedAt: "2024-02-06T00:00:00Z", priceUnit: "index-points", returnUnit: "percentage-points",
  requested: { start: "2024-02-01", end: date },
  rows: [{ tradeDate: previousDate, sourceTimestamp: Date.parse(previousDate + "T00:00:00+08:00"), closePoints: 800,
    changePoints: null, previousClosePoints: null, returnPct: null }],
});
let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-index-minute-runtime-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-index-minute" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("collects exact index series and replays its raw observations and WhyJ metrics offline", async () => {
  const provider = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: providerData })).mockResolvedValueOnce(Response.json({ data: emptyData }))
    .mockRejectedValue(new Error("Provider offline"));
  try {
    const first = await collectDatedIndexMinutes({ symbol: " 899050.bj ", tradeDate: date });
    const empty = await collectDatedIndexMinutes({ symbol, tradeDate: date });
    expect(first).toMatchObject({ status: "archived", tradeDate: date, symbol, rowCount: 2, ref: { kind: "dated-index-minute" } });
    expect(empty).toMatchObject({ status: "empty", tradeDate: date, rowCount: 0, ref: { kind: "dated-index-minute" } });
    const [url, init] = provider.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("symbol")).toBe(symbol);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-index-minute");
    const dailyRef = await archiveBenchmarkIndexObservations(daily());
    saveSettings({ ...readSettings(), preferences: DEFAULT_SETTINGS.preferences, env: {} });
    const replay = await replayDatedIndexMinutes({ minuteRef: first.ref, previousClose: { dailyRef, calendar } });
    expect(replay.input.minutes).toMatchObject({ ref: first.ref, rows: [
      { sourceTimestamp: times[0], closePoints: 800, volume: 0, amount: 0 },
      { sourceTimestamp: times[1], closePoints: 816, volume: 42, amount: 876 },
    ] });
    expect(replay.input.previousClose).toMatchObject({ dailyRef, calendar, row: { tradeDate: previousDate, closePoints: 800 } });
    expect(replay.metrics).toMatchObject({ producer: "whyj", returnUnit: "fraction", previousClosePoints: 800 });
    expect(replay.metrics.points[0]?.returnFraction).toBe(0);
    expect(replay.metrics.points[1]?.returnFraction).toBeCloseTo(0.02, 12);
    const without = await replayDatedIndexMinutes({ minuteRef: first.ref });
    expect(without.metrics.points.every(row => row.returnFraction === null)).toBe(true);
    expect((await replayDatedIndexMinutes({ minuteRef: empty.ref })).input.minutes.rows).toEqual([]);
    expect(provider).toHaveBeenCalledTimes(2);
  } finally { provider.mockRestore(); }
});

test("preserves a missing prior session and rejects misbound archives and provider failures", async () => {
  const provider = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("", { status: 403 }))
    .mockResolvedValueOnce(Response.json({ data: providerData }));
  try {
    await expect(collectDatedIndexMinutes({ symbol, tradeDate: date })).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectDatedIndexMinutes({ symbol, tradeDate: date }, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(root, "data", "dated-index-minute-archives-v1"))).toBe(false);
    const { ref: minuteRef } = await collectDatedIndexMinutes({ symbol, tradeDate: date });
    const next = daily();
    next.rows = [{ ...next.rows[0]!, tradeDate: date, sourceTimestamp: Date.parse(date + "T00:00:00+08:00") }];
    const [missing, foreign] = await Promise.all([
      archiveBenchmarkIndexObservations(next),
      archiveBenchmarkIndexObservations(daily("000001.SH")),
    ]);
    const missingReference = await replayDatedIndexMinutes({ minuteRef, previousClose: { dailyRef: missing, calendar } });
    expect(missingReference.input.previousClose?.row).toBeNull();
    expect(missingReference.metrics.previousClosePoints).toBeNull();
    expect(missingReference.metrics.points.every(point => point.returnFraction === null)).toBe(true);
    await expect(replayDatedIndexMinutes({ minuteRef, previousClose: { dailyRef: foreign, calendar } })).rejects.toThrow("does not match the index");
    await expect(replayDatedIndexMinutes({ minuteRef, previousClose: { dailyRef: missing,
      calendar: { ...calendar, previousTradeDate: date } } })).rejects.toThrow("Previous-close calendar");
    await expect(replayDatedIndexMinutes({ minuteRef }, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(provider).toHaveBeenCalledTimes(2);
  } finally { provider.mockRestore(); }
});
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, readSettings, saveSettings, type StoredBenchmarkIndexBatch } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectDatedIndexMinutes, previewCurrentIndexMinutes, replayDatedIndexMinutes } from "../data/index-minute-observations.ts";

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

test("previews current provider-native index minutes and fixed previous-close returns without archiving", async () => {
  const now = Date.parse(date + "T09:32:30+08:00");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const provider = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: providerData }))
    .mockResolvedValueOnce(Response.json({ data: providerData }))
    .mockResolvedValueOnce(Response.json({ data: emptyData }));
  try {
    const dailyRef = await archiveBenchmarkIndexObservations(daily());
    const request = { symbol: " 899050.bj ", tradeDate: date, previousClose: { dailyRef, calendar } };
    const observed = await previewCurrentIndexMinutes(request);
    expect(observed).toMatchObject({ status: "observed", input: {
      minutes: { source: "tickflow", endpoint: "/v1/klines", symbol, tradeDate: date, finality: "provisional",
        volumeUnit: "provider-native", amountUnit: "provider-native", coverage: "unknown", observedAt: expect.any(String),
        requestedWindow: { startTime: Date.parse(date + "T09:25:00+08:00"), endTime: now },
        rows: [{ sourceTimestamp: times[0], closePoints: 800, volume: 0, amount: 0 },
          { sourceTimestamp: times[1], closePoints: 816, volume: 42, amount: 876 }] },
      previousClose: { dailyRef, calendar, row: { tradeDate: previousDate, closePoints: 800 } },
    }, metrics: { producer: "whyj", returnUnit: "fraction", previousClosePoints: 800 } });
    expect(observed.metrics.points[0]).toEqual({ sourceTimestamp: times[0], returnFraction: 0 });
    expect(observed.metrics.points[1]?.returnFraction).toBeCloseTo(0.02, 12);
    const url = new URL(String(provider.mock.calls[0]![0]));
    expect(url.searchParams.get("symbol")).toBe(symbol);
    expect(url.searchParams.get("end_time")).toBe(String(now));

    const missing = await archiveBenchmarkIndexObservations({ ...daily(), rows: [] });
    const noClose = await previewCurrentIndexMinutes({ ...request, previousClose: { dailyRef: missing, calendar } });
    expect(noClose.input.previousClose?.row).toBeNull();
    expect(noClose.metrics.points).toEqual(times.map(sourceTimestamp => ({ sourceTimestamp, returnFraction: null })));
    expect(await previewCurrentIndexMinutes({ symbol, tradeDate: date })).toMatchObject({
      status: "empty", input: { minutes: { rows: [], requestedWindow: expect.any(Object) }, previousClose: null }, metrics: { points: [] },
    });
    clock.mockReturnValue(Date.parse(date + "T08:00:00+08:00"));
    expect(await previewCurrentIndexMinutes({ symbol, tradeDate: date })).toMatchObject({
      status: "before-window", input: { minutes: { requestedWindow: null, rows: [] } }, metrics: { points: [] },
    });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "dated-index-minute-archives-v1"))).toBe(false);
  } finally { provider.mockRestore(); clock.mockRestore(); }
});

test("rejects an invalid preview scope or prior close before contacting the current index provider", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(date + "T09:35:00+08:00"));
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 403 }));
  try {
    const request = { symbol, tradeDate: date };
    const wrong = await archiveBenchmarkIndexObservations(daily("000001.SH"));
    await expect(previewCurrentIndexMinutes({ ...request, previousClose: { dailyRef: wrong, calendar } }))
      .rejects.toThrow("does not match the index");
    await expect(previewCurrentIndexMinutes({ ...request, previousClose: { dailyRef: wrong, calendar: { ...calendar, tradeDate: previousDate } } }))
      .rejects.toThrow("calendar");
    await expect(previewCurrentIndexMinutes({ ...request, tradeDate: previousDate })).rejects.toThrow("current Shanghai");
    await expect(previewCurrentIndexMinutes(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(provider).toHaveBeenCalledTimes(0);
    await expect(previewCurrentIndexMinutes(request)).rejects.toMatchObject({ code: "provider-failure" });
    expect(provider).toHaveBeenCalledTimes(1);
  } finally { provider.mockRestore(); clock.mockRestore(); }
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
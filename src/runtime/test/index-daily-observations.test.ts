import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectDatedIndexDailyBars, replayDatedIndexDailyBars } from "../data/index-daily-observations.ts";

const dates = Array.from({ length: 66 }, (_, index) => new Date(Date.UTC(2024, 0, 2 + index)).toISOString().slice(0, 10));
const close = dates.map((_, index) => 100 + index);
const symbol = "399006.SZ";
const query = { symbol, start: dates[0]!, end: dates.at(-1)! };
const fixture = { symbol, timestamp: dates.map(date => Date.parse(date + "T15:00:00+08:00")),
  open: close, close, high: close.map(value => value + 2), low: close.map(value => value - 2),
  volume: dates.map(() => 0), amount: dates.map(() => null) };
const empty = { symbol, timestamp: [], open: [], close: [], high: [], low: [], volume: [] };

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-index-daily-runtime-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "index-daily-runtime-fixture" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("replays the fixed chart with warm-up before the view and raw evidence separate", async () => {
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: fixture }))
    .mockResolvedValueOnce(Response.json({ data: empty })).mockRejectedValue(new Error("Provider offline"));
  try {
    const receipt = await collectDatedIndexDailyBars({ ...query, symbol: " 399006.sz " });
    const blank = await collectDatedIndexDailyBars(query);
    expect(receipt).toMatchObject({ status: "archived", rowCount: 66, symbol, source: "tickflow" });
    expect(blank).toMatchObject({ status: "empty", rowCount: 0, symbol });
    saveSettings({ ...readSettings(), preferences: DEFAULT_SETTINGS.preferences, env: {} });

    const displayRange = { start: dates[59]!, end: dates[60]! };
    const replay = await replayDatedIndexDailyBars({ ref: receipt.ref, displayRange });
    expect(replay.input.daily).toMatchObject({ ref: receipt.ref, requested: { start: query.start, end: query.end }, source: "tickflow" });
    expect(replay.input.daily.rows).toHaveLength(66);
    expect(replay.input.daily.rows[59]).toMatchObject({ tradeDate: dates[59], closePoints: 159, volume: 0, amount: null });
    expect(replay.metrics).toMatchObject({ producer: "whyj", displayRange,
      calculationWindow: { firstDate: query.start, lastDate: dates[60], rowCount: 61 } });
    expect(replay.metrics.rows.map(row => row.date)).toEqual([dates[59], dates[60]]);
    const row = replay.metrics.rows[0]!;
    expect(Object.keys(row)).toHaveLength(16);
    expect(row.ma5).toBeCloseTo(157, 12);
    expect(row.ma10).toBeCloseTo(154.5, 12);
    expect(row.ma20).toBeCloseTo(149.5, 12);
    expect(row.ma60).toBeCloseTo(129.5, 12);
    expect(row.boll_upper).toBeCloseTo(149.5 + 2 * Math.sqrt(35), 10);
    expect(row.boll_lower).toBeCloseTo(149.5 - 2 * Math.sqrt(35), 10);
    for (const field of ["macd_dif", "macd_dea", "macd_hist", "rsi_6", "rsi_14", "rsi_24", "kdj_k", "kdj_d", "kdj_j"] as const) {
      expect(Number.isFinite(row[field])).toBe(true);
    }
    const full = await replayDatedIndexDailyBars({ ref: receipt.ref });
    expect(full.metrics.rows[0]).toMatchObject({ ma5: null, ma60: null, boll_upper: null, kdj_k: null });
    expect(full.metrics.rows[59]).toEqual(row);
    expect(await replayDatedIndexDailyBars({ ref: blank.ref })).toMatchObject({
      input: { daily: { rows: [] } }, metrics: { calculationWindow: { firstDate: null, lastDate: null, rowCount: 0 }, rows: [] },
    });
    expect(provider).toHaveBeenCalledTimes(2);
  } finally { provider.mockRestore(); }
});

test("fails without a receipt on cancellation or provider errors and rejects bad replay scope", async () => {
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 403 }))
    .mockResolvedValueOnce(Response.json({ data: fixture }));
  try {
    await expect(collectDatedIndexDailyBars(query, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    await expect(collectDatedIndexDailyBars(query)).rejects.toMatchObject({ code: "provider-failure" });
    expect(existsSync(join(root, "data", "dated-index-daily-archives-v1"))).toBe(false);
    const { ref } = await collectDatedIndexDailyBars(query);
    for (const displayRange of [{ start: "2023-01-01", end: query.end }, { start: query.start, end: "2025-01-01" },
      { start: query.end, end: query.start }]) {
      await expect(replayDatedIndexDailyBars({ ref, displayRange })).rejects.toThrow("display range");
    }
    await expect(replayDatedIndexDailyBars({ ref: { ...ref, revision: "f".repeat(64) } })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(replayDatedIndexDailyBars({ ref }, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(provider).toHaveBeenCalledTimes(2);
  } finally { provider.mockRestore(); }
});
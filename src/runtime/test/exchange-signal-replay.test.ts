import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveTradingDateObservations, loadDailyTradingLimitArchive, readSettings, saveSettings } from "../../storage/index.ts";
import type { StoredDailyTradingLimitBatch, StoredTradingDateBarObservation } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectTradingLimitObservations, deriveTspArchiveIndicators } from "../data/observation-collection.ts";

let root: string;
let previous: string | undefined;
const symbol = "600000.SH", startDate = "2024-01-02", endDate = "2024-01-09";
const requested = { startDate, endDate };
const request = { symbol, ...requested };
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09"];
const observedAt = "2024-01-10T02:00:00.000Z";
const fields = ["ts_code", "trade_date", "pre_close", "up_limit", "down_limit"];
const provider = (items: unknown[][]) => Response.json({ code: 0, data: { fields, items } });
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-exchange-signals-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const raw = (tradeDate: string, open: number, high: number, low: number, close: number): StoredTradingDateBarObservation => ({
  schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, sourceTimestamp: null, requested,
  market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tushare", endpoint: "daily",
  observedAt, interval: "1d", adjustment: "none", volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown",
  values: { open, high, low, close, volume: 100, amount: null },
});

const adjusted = (row: StoredTradingDateBarObservation): StoredTradingDateBarObservation => ({
  ...row, source: "tickflow", sourceTimestamp: Date.parse(`${row.tradeDate}T00:00:00+08:00`), endpoint: "/v1/klines",
  adjustment: "forward", volumeUnit: "unknown", amountUnit: "unknown",
  values: { ...row.values, open: row.values.open / 2, high: row.values.high / 2, low: row.values.low / 2, close: row.values.close / 2 },
});

const limitFixture = (): StoredDailyTradingLimitBatch => ({
  symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt, coverage: "unknown", priceUnit: "CNY", requested,
  rows: dates.slice(0, 5).map(tradeDate => ({ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 })),
});

test("collects dated provider limit observations by explicit request and archives them without any formula transform", async () => {
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "synthetic-token" } });
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(provider([[symbol, "20240103", 10, null, null], [symbol, "20240102", 10, 11, 9]]));
    const receipt = await collectTradingLimitObservations(request);
    if (receipt.status !== "archived") throw new Error("No archived rows");
    const stored = await loadDailyTradingLimitArchive(receipt.ref);
    expect(stored.requested).toEqual(requested);
    expect(stored.rows).toEqual([
      { tradeDate: "2024-01-02", previousClose: 10, limitUp: 11, limitDown: 9 },
      { tradeDate: "2024-01-03", previousClose: 10, limitUp: null, limitDown: null },
    ]);
    expect(stored.observedAt).toBe(receipt.observedAt);
    expect(receipt.source).toBe("tushare");
    expect(receipt.endpoint).toBe("stk_limit");
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body))).toMatchObject({ api_name: "stk_limit",
      params: { ts_code: symbol, start_date: "20240102", end_date: "20240109" } });
    expect(JSON.stringify(stored)).not.toContain("synthetic-token");
  } finally { http.mockRestore(); }
});

test("empty, failing, cancelled and unsupported limit requests create no archive", async () => {
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "synthetic-token" } });
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(provider([]));
    expect(await collectTradingLimitObservations(request)).toMatchObject({ status: "empty", ref: null, rowCount: 0 });
    http.mockResolvedValueOnce(new Response("private", { status: 403 }));
    await expect(collectTradingLimitObservations(request)).rejects.toThrow("Provider reference request failed");
    const cancel = new AbortController();
    const reason = new Error("cancel fixture request");
    http.mockImplementationOnce((async () => {
      cancel.abort(reason);
      return provider([[symbol, "20240102", 10, 11, 9]]);
    }) as unknown as typeof fetch);
    await expect(collectTradingLimitObservations(request, { signal: cancel.signal })).rejects.toBe(reason);
    const current = readSettings();
    saveSettings({ ...current, preferences: { ...current.preferences, source: "tickflow" } });
    await expect(collectTradingLimitObservations(request)).rejects.toThrow("not implemented");
    expect(http).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "trading-limit-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

test("joins fixed exchange prices by exact date and replays all four rules at threshold boundaries", async () => {
  const rawRows = [
    raw(dates[0]!, 10, 11, 9.8, 10.995),
    raw(dates[1]!, 10, 10.995, 9.8, 10.9),
    raw(dates[2]!, 9.3, 10, 9, 9.005),
    raw(dates[3]!, 9.15, 10, 9.005, 9.5),
    raw(dates[5]!, 10, 11, 9, 11),
  ];
  const primaryRows = [...rawRows.slice(0, 4), raw(dates[4]!, 10, 11, 9, 11), rawRows[4]!].map(adjusted);
  const [archiveRef, rawArchiveRef, tradingLimitArchiveRef] = await Promise.all([
    archiveTradingDateObservations(primaryRows), archiveTradingDateObservations(rawRows), archiveDailyTradingLimits(limitFixture()),
  ]);
  const exchange = { rawArchiveRef, tradingLimitArchiveRef };
  const http = spyOn(globalThis, "fetch");
  try {
    const first = await deriveTspArchiveIndicators(archiveRef, undefined, exchange);
    const bare = await deriveTspArchiveIndicators(archiveRef);
    expect(first.daily).toEqual(bare.daily);
    expect(bare.dailySignals.exchangeInputs).toBeUndefined();
    const rules = first.dailySignals.rows.map(({ values }) => [
      values.signal_limit_up, values.signal_broken_limit_up, values.signal_limit_down, values.signal_limit_down_recovery,
    ]);
    expect(rules).toEqual([
      [true, false, false, false], [false, true, false, false], [false, false, true, false],
      [false, false, false, true], [null, null, null, null], [null, null, null, null],
    ]);
    expect(first.dailySignals.exchangeInputs?.raw.ref).toEqual(rawArchiveRef);
    expect(first.dailySignals.exchangeInputs?.limits.ref).toEqual(tradingLimitArchiveRef);
    const revised = limitFixture();
    revised.rows[0]!.limitUp = 11.5;
    const revisedRef = await archiveDailyTradingLimits(revised);
    expect((await deriveTspArchiveIndicators(archiveRef, undefined, { ...exchange, tradingLimitArchiveRef: revisedRef }))
      .dailySignals.rows[0]!.values.signal_limit_up).toBe(false);
    expect(await deriveTspArchiveIndicators(archiveRef, undefined, exchange)).toEqual(first);
    const reused = await deriveTspArchiveIndicators(rawArchiveRef, undefined, { tradingLimitArchiveRef });
    expect(reused.dailySignals.exchangeInputs?.raw.ref).toEqual(rawArchiveRef);
    expect(reused.dailySignals.rows[0]!.values.signal_limit_up).toBe(true);
    await expect(deriveTspArchiveIndicators(archiveRef, undefined, { tradingLimitArchiveRef })).rejects.toThrow("unadjusted");
    const wrongSymbol = await archiveDailyTradingLimits({ ...limitFixture(), symbol: "600001.SH" });
    await expect(deriveTspArchiveIndicators(archiveRef, undefined, { ...exchange, tradingLimitArchiveRef: wrongSymbol })).rejects.toThrow("same symbol");
    const wrongRaw = await archiveTradingDateObservations(rawRows.map(row => ({ ...row, symbol: "600001.SH" })));
    await expect(deriveTspArchiveIndicators(archiveRef, undefined, { ...exchange, rawArchiveRef: wrongRaw })).rejects.toThrow("same symbol");
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

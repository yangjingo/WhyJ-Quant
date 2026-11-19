import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, loadHistoricalMinuteArchive, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectHistoricalMinuteObservations, deriveTspArchiveIntraday } from "../data/intraday-replay.ts";

const request = { symbol: "600000.SH", startDate: "2024-01-02", endDate: "2024-01-03" };
const fields = ["trade_time", "ts_code", "close", "open", "high", "low", "vol", "amount"];
const row = (date: string, time: string, price: number, volume: number, amount: number | null) =>
  [date + " " + time + ":00", request.symbol, price, price, price, price, volume, amount];
const payload = (...items: ReturnType<typeof row>[]) => Response.json({ code: 0, data: { fields, items } });

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-intraday-replay-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "fixture-secret" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const limitArchive = (symbol = request.symbol) => archiveDailyTradingLimits({
  symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt: "2024-01-04T00:00:00.000Z",
  coverage: "unknown", priceUnit: "CNY", requested: { startDate: "2024-01-02", endDate: "2024-01-04" },
  rows: [{ tradeDate: "2024-01-02", previousClose: 10, limitUp: 11, limitDown: 9 },
    { tradeDate: "2024-01-04", previousClose: 7, limitUp: 7.7, limitDown: 6.3 }],
});

test("collects original data and deterministically replays the exact historical minute inputs offline", async () => {
  const http = spyOn(globalThis, "fetch").mockResolvedValueOnce(payload(
    row("2024-01-02", "15:00", 10.4, 100, 1040), row("2024-01-02", "13:01", 10.3, 100, 1030),
    row("2024-01-02", "11:30", 10.2, 0, 0), row("2024-01-02", "09:32", 10.2, 100, 1020),
    row("2024-01-02", "09:30", 11, 9000, 99_000), row("2024-01-02", "09:31", 9.8, 100, 980),
    row("2024-01-03", "09:31", 8, 10, null),
  ));
  try {
    const receipt = await collectHistoricalMinuteObservations(request);
    if (receipt.status !== "archived") throw new Error("Missing archive");
    expect(receipt).toMatchObject({ source: "tushare", endpoint: "stk_mins", rowCount: 7 });
    expect(JSON.stringify(receipt)).not.toContain("fixture-secret");
    const archive = await loadHistoricalMinuteArchive(receipt.ref);
    expect(archive.rows[0]).toMatchObject({ openingBoundary: true, amount: 99_000, volume: 9000 });
    expect(archive.rows[3]).toMatchObject({ amount: 0, volume: 0 });

    const fixedClose = await limitArchive();
    const options = { previousClose: { ref: fixedClose, priceBasis: "caller-confirmed-same-basis" as const } };
    const result = await deriveTspArchiveIntraday(receipt.ref, options);
    expect(result).toMatchObject({ archiveRef: receipt.ref, producer: "whyj",
      formula: { id: "tsp_intraday", version: 1, revision: expect.any(String) },
      input: { timeZone: "Asia/Shanghai", finality: "unknown", adjustment: "unknown", coverage: "unknown",
        volumeUnit: "share", amountUnit: "CNY", requested: { startDate: request.startDate, endDate: request.endDate },
        labelConvention: "tushare-stk-mins-end-time-v1", previousClose: { archiveRef: fixedClose, endpoint: "stk_limit",
          priceBasis: "caller-confirmed-same-basis" } },
      openingBoundaries: [{ tradeTime: "2024-01-02 09:30:00", openingBoundary: true, volume: 9000 }],
    });
    expect(result.rows.map(({ minute }) => minute)).toEqual(["09:30", "09:31", "11:29", "13:00", "14:59", "09:30"]);
    const [first, second, gap, afternoon, close, nextDay] = result.rows;
    expect(Object.keys(first!.values)).toHaveLength(11);
    expect(Object.keys(first!.signals)).toHaveLength(4);
    expect(first).toMatchObject({ originalTradeTime: "2024-01-02 09:31:00",
      values: { vwap: 9.8, pct_from_open: 0 }, signals: { signal_intraday_zero_cross_up: null } });
    expect(first!.values.pct_vs_prev_close).toBeCloseTo(-0.02);
    expect(second).toMatchObject({ values: { vwap: 10 }, signals: { signal_intraday_zero_cross_up: true } });
    expect(gap!.values.vwap).toBeNull();
    expect(afternoon!.values.vol_ratio_1m_today).toBeNull();
    expect(close!.originalTradeTime).toBe("2024-01-02 15:00:00");
    expect(nextDay!.values.pct_vs_prev_close).toBeNull();
    expect(nextDay!.values.vwap).toBeNull();
    expect(await deriveTspArchiveIntraday(receipt.ref, options)).toEqual(result);
    const withoutClose = await deriveTspArchiveIntraday(receipt.ref);
    expect(withoutClose.input.previousClose).toBeNull();
    expect(withoutClose.rows[1]!.signals.signal_intraday_zero_cross_up).toBeNull();

    const unrelated = await limitArchive("000001.SZ");
    await expect(deriveTspArchiveIntraday(receipt.ref, {
      previousClose: { ...options.previousClose, ref: unrelated },
    })).rejects.toThrow("does not match");
    await expect(deriveTspArchiveIntraday({ ...receipt.ref, revision: "f".repeat(64) })).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(1);
  } finally { http.mockRestore(); }
});

test("empty, denied and cancelled collection cannot commit a minute archive", async () => {
  const controller = new AbortController();
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(payload());
    expect(await collectHistoricalMinuteObservations(request)).toMatchObject({ status: "empty", ref: null, rowCount: 0 });
    http.mockResolvedValueOnce(new Response("private body", { status: 403 }));
    await expect(collectHistoricalMinuteObservations(request)).rejects.toMatchObject({
      code: "provider-failure", message: "Provider reference request failed",
    });
    http.mockImplementationOnce((async () => {
      controller.abort();
      return payload(row("2024-01-02", "09:31", 9.8, 100, 980));
    }) as unknown as typeof fetch);
    await expect(collectHistoricalMinuteObservations(request, { signal: controller.signal })).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "historical-minute-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

test("preserves a boundary-only archive and rejects an unmapped afternoon label at replay", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    http.mockResolvedValueOnce(payload(row("2024-01-02", "09:30", 10, 0, 0)));
    const boundary = await collectHistoricalMinuteObservations(request);
    if (boundary.status !== "archived") throw new Error("Missing archive");
    const result = await deriveTspArchiveIntraday(boundary.ref);
    expect(result.rows).toEqual([]);
    expect(result.openingBoundaries).toHaveLength(1);

    http.mockResolvedValueOnce(payload(row("2024-01-02", "13:00", 10, 0, 0)));
    const unknownLayout = await collectHistoricalMinuteObservations(request);
    if (unknownLayout.status !== "archived") throw new Error("Missing archive");
    expect((await loadHistoricalMinuteArchive(unknownLayout.ref)).rows[0]!.tradeTime).toBe("2024-01-02 13:00:00");
    await expect(deriveTspArchiveIntraday(unknownLayout.ref)).rejects.toThrow("Unsupported Tushare historical minute label");
    expect(http).toHaveBeenCalledTimes(2);
  } finally { http.mockRestore(); }
});

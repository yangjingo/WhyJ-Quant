import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedStockMinutes, archiveDailyTradingLimits, loadDatedStockMinuteArchive, saveSettings,
  type StoredDatedStockMinuteBatch } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { replayTspIntradayMonitorAlerts, type IntradayMonitorAlertReplayRequest } from "../data/intraday-monitor-alert-replay.ts";
import { collectDatedTickFlowStockMinutes, replayTspTickFlowStockMinutes,
  type TickFlowStockMinuteInterpretation } from "../data/tickflow-stock-minute-replay.ts";

const symbol = "600001.SH", first = "2024-04-08", second = "2024-04-09", observedAt = "2024-04-10T01:00:00Z";
const stamp = (date: string, time: string) => Date.parse(`${date}T${time}+08:00`);
const interpretation: TickFlowStockMinuteInterpretation = {
  timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
};

function batch(tradeDate: string, marks: readonly (readonly [string, number])[], code = symbol): StoredDatedStockMinuteBatch {
  return { source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: code, assetType: "stock", tradeDate, observedAt,
    coverage: "unknown", interval: "1m", adjustment: "none", priceUnit: "provider-native", volumeUnit: "provider-native",
    amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native", finality: "unknown",
    rows: marks.map(([time, close]) => ({ sourceTimestamp: stamp(tradeDate, time), open: close, high: close,
      low: close, close, volume: 1, amount: close / 10 })),
  };
}

let root: string;
let prior: string | undefined;
beforeEach(() => {
  prior = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-tickflow-stock-replay-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

test("collects native TickFlow minute bars and archives a valid empty response with the same scope", async () => {
  const count = { calls: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/klines");
    expect(url.searchParams.get("symbol")).toBe(symbol);
    expect(url.searchParams.get("adjust")).toBe("none");
    expect(request.headers.get("x-api-key")).toBe("stock-minute-fixture");
    return Response.json({ data: count.calls++ === 0 ? { symbol, timestamp: [stamp(first, "09:31:00")],
      open: [10], high: [11], low: [9], close: [10], volume: [0], amount: [0] }
      : { symbol, timestamp: [], open: [], high: [], low: [], close: [], volume: [] } });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "stock-minute-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const collected = await collectDatedTickFlowStockMinutes({ symbol, tradeDate: first });
    const empty = await collectDatedTickFlowStockMinutes({ symbol, tradeDate: second });
    expect(count.calls).toBe(2);
    expect(collected).toMatchObject({ symbol, tradeDate: first, status: "archived", rowCount: 1, ref: { kind: "dated-stock-minute" } });
    expect(empty).toMatchObject({ symbol, tradeDate: second, status: "empty", rowCount: 0, ref: { kind: "dated-stock-minute" } });
    expect(await loadDatedStockMinuteArchive(collected.ref)).toMatchObject({
      volumeUnit: "provider-native", finality: "unknown", rows: [{ sourceTimestamp: stamp(first, "09:31:00"), volume: 0, amount: 0 }],
    });
    expect(await loadDatedStockMinuteArchive(empty.ref)).toMatchObject({ symbol, tradeDate: second, rows: [] });
    expect(await replayTspTickFlowStockMinutes({ refs: [empty.ref], interpretation })).toMatchObject({ rows: [], excluded: [] });
    await expect(collectDatedTickFlowStockMinutes({ symbol, tradeDate: first }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(count.calls).toBe(2);
  } finally { await server.stop(true); }
});

test("reconstructs aligned TickFlow features and alerts with their native epochs and explicit price and unit basis", async () => {
  const raw = batch(first, [["09:30:00", 99], ["09:30:59.123", 88], ["09:31:00", 9], ["09:32:00", 11], ["13:00:00", 80], ["15:00:00", 12]]);
  const ref = await archiveDatedStockMinutes(raw);
  const next = await archiveDatedStockMinutes(batch(second, [["09:31:00", 10], ["09:32:00", 11]]));
  const previousRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
    priceUnit: "CNY", coverage: "unknown", requested: { startDate: first, endDate: second },
    rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
  const previousClose = { ref: previousRef, priceBasis: "caller-confirmed-same-basis" } as const;
  const history = { refs: [ref, next], interpretation, previousClose };
  const preview = await replayTspTickFlowStockMinutes(history);
  expect(preview).toMatchObject({ producer: "whyj", input: { symbol, source: "tickflow", interpretation,
    archives: [{ ref, rowCount: 6 }, { ref: next, rowCount: 2 }],
    previousClose: { archiveRef: previousRef, source: "tushare", rows: [{ tradeDate: first, price: 10 }, { tradeDate: second, price: null }] },
  } });
  expect(preview.rows.map(row => [row.tradingDate, row.minute])).toEqual([
    [first, "09:30"], [first, "09:31"], [first, "14:59"], [second, "09:30"], [second, "09:31"],
  ]);
  expect(preview.excluded).toEqual([
    { tradeDate: first, sourceTimestamp: stamp(first, "09:30:00"), reason: "opening-boundary" },
    { tradeDate: first, sourceTimestamp: stamp(first, "09:30:59.123"), reason: "unaligned" },
    { tradeDate: first, sourceTimestamp: stamp(first, "13:00:00"), reason: "outside-session" },
  ]);
  expect(preview.rows[1]).toMatchObject({ sourceTimestamp: stamp(first, "09:32:00"), values: { price: 11, vwap: 10 },
    signals: { signal_intraday_zero_cross_up: true, signal_intraday_avg_cross_up: true } });
  expect(preview.rows[4]?.values.pct_vs_prev_close).toBeNull();
  expect(await loadDatedStockMinuteArchive(ref)).toEqual(raw);

  const rule: IntradayMonitorAlertReplayRequest["rule"] = { id: "tickflow_cross", revision: "v1", type: "signal", assetType: "stock",
    scope: { kind: "all" }, logic: "and", cooldownMs: 0, severity: "warn", conditions: [
      { field: "signal_intraday_zero_cross_up", op: "truth" }, { field: "csgi_cross_ten", op: "truth" },
      { field: "volume", op: ">=", unit: "share", value: 100 },
    ] };
  const request: IntradayMonitorAlertReplayRequest = { rule, histories: [{ symbol, ...history }], roster: [symbol],
    slots: ["09:30", "09:31", "09:32"].map(minute => ({ tradeDate: first, minute })),
    customSignals: [{ id: "cross_ten", conditions: [{ left: "price", op: "cross_up", right: 10 }] }] };
  const report = await replayTspIntradayMonitorAlerts(request);
  expect(report.evaluations.map(row => row.events.length)).toEqual([0, 1, 0]);
  const event = report.evaluations[1]?.events[0];
  expect(event).toMatchObject({ symbol, sourceTimestamp: stamp(first, "09:32:00"),
    operands: { volume: 100, signal_intraday_zero_cross_up: true, csgi_cross_ten: true },
    eventId: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(await replayTspIntradayMonitorAlerts(request)).toEqual(report);
  const leftEdge = await replayTspIntradayMonitorAlerts({ ...request,
    histories: [{ symbol, ...history, interpretation: { ...interpretation, timestampLabel: "minute-start" } }] });
  expect(leftEdge.evaluations.map(row => row.events.length)).toEqual([0, 0, 1]);
  expect(leftEdge.evaluations[2]?.events[0]?.eventId).not.toBe(event?.eventId);

  const unknown = { timestampLabel: "minute-end", priceBasis: interpretation.priceBasis } as const;
  expect((await replayTspTickFlowStockMinutes({ ...history, interpretation: unknown })).rows[1]?.values)
    .toMatchObject({ price: 11, vwap: null, vol_ratio_1m_today: null });
  expect((await replayTspIntradayMonitorAlerts({ ...request, histories: [{ symbol, ...history, interpretation: unknown }] }))
    .evaluations[1]?.events).toEqual([]);
  await expect(replayTspTickFlowStockMinutes({ ...history, refs: [next, ref] })).rejects.toThrow("strictly increasing dates");
  const foreign = await archiveDatedStockMinutes(batch(second, [], "600002.SH"));
  await expect(replayTspTickFlowStockMinutes({ ...history, refs: [ref, foreign] })).rejects.toThrow("one stock");
  await expect(replayTspTickFlowStockMinutes({ ...history, refs: [ref, ref] })).rejects.toThrow("references or interpretation");
  await expect(replayTspTickFlowStockMinutes(history, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

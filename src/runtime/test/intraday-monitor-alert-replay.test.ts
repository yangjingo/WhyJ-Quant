import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveHistoricalMinuteObservations, type StoredHistoricalMinuteBatch } from "../../storage/index.ts";
import { replayTspIntradayMonitorAlerts, type IntradayMonitorAlertReplayRequest } from "../data/intraday-monitor-alert-replay.ts";

const tradeDate = "2024-03-04", a = "600001.SH", b = "000001.SZ";
const observedAt = "2024-03-06T00:00:00Z";
const requested = { startDate: tradeDate, endDate: tradeDate };
const prices: readonly (readonly [string, number])[] = [
  ["09:30", 99], ["09:31", 9], ["09:32", 11], ["09:33", 9], ["09:34", 12], ["09:36", 13],
];
const barBatch: StoredHistoricalMinuteBatch = {
  symbol: a, market: "A", source: "tushare", endpoint: "stk_mins", timeZone: "Asia/Shanghai", interval: "1m",
  volumeUnit: "share", amountUnit: "CNY", coverage: "unknown", finality: "unknown", adjustment: "unknown", observedAt, requested,
  rows: prices.map(([end, close], index) => ({ tradeTime: `${tradeDate} ${end}:00`, openingBoundary: index === 0,
    open: close, high: close, low: close, close, volume: 100, amount: close * 100 })),
};

test("rebuilds fixed intraday alerts with exact completed slots, native and custom signals, and original timestamps", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-intraday-monitor-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  try {
    const ref = await archiveHistoricalMinuteObservations(barBatch);
    const closeRef = await archiveDailyTradingLimits({ symbol: a, market: "A", source: "tushare", endpoint: "stk_limit",
      observedAt, requested, coverage: "unknown", priceUnit: "CNY",
      rows: [{ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const history = { symbol: a, ref, previousClose: { ref: closeRef, priceBasis: "caller-confirmed-same-basis" as const } };
    const customRule = { id: "cross_ten", conditions: [{ left: "price", op: "cross_up", right: 10 }] } as const;
    const request: IntradayMonitorAlertReplayRequest = {
      roster: [a, b], histories: [history], customSignals: [customRule],
      slots: ["09:30", "09:31", "09:32", "09:33", "09:34", "09:35", "14:59"].map(minute => ({ tradeDate, minute })),
      rule: { id: "cross_monitor", revision: "monitor-v1", assetType: "stock", type: "signal", logic: "or", severity: "warn", cooldownMs: 180_000,
        scope: { kind: "watchlist_group", symbols: [a, b], membershipRevision: "team-v1" }, conditions: [
          { field: "signal_intraday_zero_cross_up", op: "truth" }, { field: "csgi_cross_ten", op: "truth" },
        ] },
    };
    const report = await replayTspIntradayMonitorAlerts(request);
    expect(report).toMatchObject({ producer: "whyj", basis: "historical-reconstruction", granularity: "1m", membershipRevision: "team-v1",
      customSignalFormula: { id: "tsp_intraday_custom_signal", version: 1 }, histories: [{ ref, openingBoundaryCount: 1, selectedMinuteCount: 5,
        source: "tushare", observedAt, adjustment: "unknown", previousClose: { archiveRef: closeRef }, featureFormula: { id: "tsp_intraday" } }],
    });
    expect(report.evaluations.map(slot => [slot.minute, slot.missingSymbols, slot.suppressedCount, slot.events.length])).toEqual([
      ["09:30", [b], 0, 0], ["09:31", [b], 0, 1], ["09:32", [b], 0, 0], ["09:33", [b], 1, 0], ["09:34", [a, b], 0, 0],
      ["09:35", [b], 0, 0], ["14:59", [a, b], 0, 0],
    ]);
    expect(report.evaluations[1]).toMatchObject({ evaluatedAt: Date.parse(`${tradeDate}T09:32:00+08:00`), events: [{ symbol: a,
      originalTradeTime: `${tradeDate} 09:32:00`, priceCny: 11, eventId: expect.any(String),
      operands: { signal_intraday_zero_cross_up: true, csgi_cross_ten: true }, matchedConditions: [0, 1] }],
    });
    expect(report.evaluations[1]?.events[0]?.changeFraction).toBeCloseTo(0.1);
    expect(report.evaluations.at(-1)?.evaluatedAt).toBe(Date.parse(`${tradeDate}T15:00:00+08:00`));
    expect(await replayTspIntradayMonitorAlerts(request)).toEqual(report);
    const revision = await replayTspIntradayMonitorAlerts({ ...request,
      customSignals: [{ ...customRule, conditions: [{ ...customRule.conditions[0], right: 10.5 }] }] });
    expect(revision.evaluations[1]?.events[0]?.eventId).not.toBe(report.evaluations[1]?.events[0]?.eventId);

    const priceRule: IntradayMonitorAlertReplayRequest["rule"] = { ...request.rule, type: "price", logic: "and", cooldownMs: 0, conditions: [
      { field: "volume", op: ">=", value: 100, unit: "share" }, { field: "pct_vs_prev_close", op: ">", value: 0.05, unit: "fraction" },
    ] };
    const numeric = await replayTspIntradayMonitorAlerts({ ...request, rule: priceRule });
    expect(numeric.evaluations.map(slot => slot.events.length)).toEqual([0, 1, 0, 1, 0, 1, 0]);
    expect(numeric.evaluations[1]?.events[0]?.operands.volume).toBe(100);
    const withoutClose = await replayTspIntradayMonitorAlerts({ ...request, rule: priceRule, histories: [{ symbol: a, ref }] });
    expect(withoutClose.evaluations.every(slot => slot.events.length === 0)).toBe(true);
    expect(withoutClose.evaluations[1]?.unavailableCount).toBe(2);

    await expect(replayTspIntradayMonitorAlerts({ ...request, slots: [{ tradeDate, minute: "12:00" }] })).rejects.toThrow("trading-minute start");
    await expect(replayTspIntradayMonitorAlerts({ ...request, slots: [...request.slots].reverse() })).rejects.toThrow("ordered and unique");
    await expect(replayTspIntradayMonitorAlerts({ ...request, histories: [history, history] })).rejects.toThrow("duplicate");
    await expect(replayTspIntradayMonitorAlerts({ ...request, histories: [{ ...history, symbol: "600003.SH" }] })).rejects.toThrow("Foreign");
    await expect(replayTspIntradayMonitorAlerts({ ...request, histories: [{ ...history, symbol: b }] })).rejects.toThrow("mismatched symbol");
    await expect(replayTspIntradayMonitorAlerts({ ...request, customSignals: [] })).rejects.toThrow("Unsupported intraday monitor field");
    await expect(replayTspIntradayMonitorAlerts({ ...request, rule: { ...priceRule,
      conditions: [{ field: "volume", op: ">", value: 1, unit: "hand" }] } })).rejects.toThrow("Incompatible intraday monitor unit");
    await expect(replayTspIntradayMonitorAlerts(request, AbortSignal.abort(new Error("Cancelled minute monitor")))).rejects.toThrow("Cancelled minute monitor");
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

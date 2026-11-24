import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveTradingDateObservations, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspDailyMonitorAlerts, type DailyMonitorAlertReplayRequest } from "../data/daily-monitor-alert-replay.ts";

const a = "600001.SH", b = "000001.SZ", c = "300001.SZ";
const dates = ["2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08"] as const;
const observedAt = "2024-03-10T00:00:00Z";
const afterClose = (day: string) => Date.parse(day + "T15:10:00+08:00");

function history(symbol: string, entries: readonly (readonly [string, number])[], source: "tickflow" | "tushare" = "tickflow",
  adjustment: "none" | "forward" = "none") {
  return archiveTradingDateObservations(entries.map(([tradeDate, close]): StoredTradingDateBarObservation => ({
    schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, interval: "1d", assetType: "stock", market: "A",
    calendarTimeZone: "Asia/Shanghai", source, endpoint: source === "tushare" ? "daily" : "/v1/klines", adjustment, observedAt,
    sourceTimestamp: source === "tushare" ? null : Date.parse(tradeDate + "T15:00:00+08:00"),
    requested: { startDate: dates[0], endDate: entries.at(-1)![0] },
    volumeUnit: source === "tushare" ? "hand" : "unknown", amountUnit: source === "tushare" ? "CNY-thousand" : "unknown",
    coverage: "unknown", values: { open: close, high: close, low: close, close, volume: 50, amount: 20 },
  })));
}

test("replays native monitor alerts with exact dates, exchange evidence, units and deterministic IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-daily-monitor-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  try {
    const [ar, br, tradingLimitArchiveRef] = await Promise.all([
      history(a, [[dates[0], 10], [dates[1], 11], [dates[3], 12]]),
      history(b, [[dates[1], 7], [dates[2], 7], [dates[3], 7]], "tushare"),
      archiveDailyTradingLimits({
        symbol: a, market: "A", source: "tushare", endpoint: "stk_limit", observedAt, priceUnit: "CNY", coverage: "unknown",
        requested: { startDate: dates[1], endDate: dates[3] },
        rows: [{ tradeDate: dates[1], previousClose: 10, limitUp: 11, limitDown: 9 },
          { tradeDate: dates[3], previousClose: 11, limitUp: 12, limitDown: 9.9 }],
      }),
    ]);
    const request: DailyMonitorAlertReplayRequest = {
      adjustment: "none", roster: [a, b, c], sessions: dates.slice(1, 4).map(tradeDate => ({ tradeDate, evaluatedAt: afterClose(tradeDate) })),
      histories: [{ symbol: a, ref: ar, exchange: { tradingLimitArchiveRef } }, { symbol: b, ref: br }],
      rule: { id: "limit_or_amount", revision: "user-rule-v1", type: "market", assetType: "stock",
        scope: { kind: "watchlist_group", membershipRevision: "group-2024-03-05", symbols: [a, b, c] },
        logic: "or", cooldownMs: 172_800_000, severity: "warn", conditions: [
          { field: "signal_limit_up", op: "truth" }, { field: "amount", op: ">", value: 19_000, unit: "CNY" },
        ] },
    };
    const report = await replayTspDailyMonitorAlerts(request);
    expect(report).toMatchObject({ producer: "whyj", basis: "historical-reconstruction", ruleRevision: "user-rule-v1",
      membershipRevision: "group-2024-03-05", units: { amount: "CNY" }, histories: [
        { symbol: b, ref: br, amountUnit: "CNY-thousand" },
        { symbol: a, ref: ar, amountUnit: "unknown", exchange: { limits: { ref: tradingLimitArchiveRef } } },
      ] });
    expect(report.evaluations.map(row => [row.tradeDate, row.missingSymbols, row.suppressedCount, row.events.map(event => event.symbol)])).toEqual([
      [dates[1], [c], 0, [a, b]], [dates[2], [a, c], 1, []], [dates[3], [c], 0, [a, b]],
    ]);
    expect(report.evaluations[1]?.unavailableCount).toBe(2);
    expect(report.evaluations[0]?.events).toMatchObject([
      { symbol: a, closeCny: 11, matchedConditions: [0], signals: ["signal_limit_up"], operands: { signal_limit_up: true, amount: null } },
      { symbol: b, closeCny: 7, matchedConditions: [1], operands: { signal_limit_up: null, amount: 20_000 } },
    ]);
    const id = report.evaluations[0]?.events[0]?.eventId;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await replayTspDailyMonitorAlerts({ ...request, histories: [...request.histories].reverse() })).toEqual(report);
    const changed = await history(a, [[dates[0], 10.1], [dates[1], 11], [dates[3], 12]]);
    const newReport = await replayTspDailyMonitorAlerts({ ...request, histories: [{ ...request.histories[0]!, ref: changed }, request.histories[1]!] });
    expect(newReport.evaluations[0]?.events[0]?.eventId).not.toBe(id);

    const fraction = { ...request, rule: { ...request.rule, conditions: [{ field: "change_pct", op: ">=" as const, value: 0.09, unit: "fraction" }] } };
    expect((await replayTspDailyMonitorAlerts(fraction)).evaluations[0]?.events[0]?.operands.change_pct).toBeCloseTo(0.1);
    await expect(replayTspDailyMonitorAlerts({ ...fraction, rule: { ...fraction.rule,
      conditions: [{ ...fraction.rule.conditions[0]!, unit: "percent" }] } })).rejects.toThrow("Incompatible daily monitor unit");
    await expect(replayTspDailyMonitorAlerts({ ...request, adjustment: "forward" })).rejects.toThrow("mismatched symbol, basis");
    await expect(replayTspDailyMonitorAlerts({ ...request, sessions: request.sessions.slice(0, 2) })).rejects.toThrow("future date");
    await expect(replayTspDailyMonitorAlerts({ ...request, histories: [{ symbol: c, ref: ar }] })).rejects.toThrow("mismatched symbol");
    await expect(replayTspDailyMonitorAlerts({ ...request, histories: [{ symbol: "600009.SH", ref: ar }] })).rejects.toThrow("Foreign");
    await expect(replayTspDailyMonitorAlerts({ ...request, histories: [request.histories[0]!, request.histories[0]!] })).rejects.toThrow("duplicate");
    await expect(replayTspDailyMonitorAlerts({ ...request, sessions: [{ tradeDate: dates[1], evaluatedAt: afterClose(dates[1]) - 3_600_000 }] }))
      .rejects.toThrow("Shanghai after-close times");
    const controller = new AbortController();
    controller.abort(new Error("Cancelled alert replay"));
    await expect(replayTspDailyMonitorAlerts(request, controller.signal)).rejects.toThrow("Cancelled alert replay");
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

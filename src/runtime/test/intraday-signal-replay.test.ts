import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveHistoricalMinuteObservations, loadHistoricalMinuteArchive,
  type StoredHistoricalMinuteBatch } from "../../storage/index.ts";
import { replayTspIntradaySignal } from "../data/intraday-signal-replay.ts";

test("replays a custom rule with source time, stable event identities and compatible previous close", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-minute-signal-replay-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const date = "2024-01-02", next = "2024-01-03", observedAt = "2024-01-04T03:00:00Z", symbol = "600000.SH";
  const row = (tradingDate: string, time: string, close: number) => ({
    tradeTime: `${tradingDate} ${time}:00`, openingBoundary: time === "09:30",
    open: close, high: close, low: close, close, volume: 100, amount: close * 100,
  });
  const batch: StoredHistoricalMinuteBatch = {
    symbol, market: "A", source: "tushare", endpoint: "stk_mins", timeZone: "Asia/Shanghai",
    interval: "1m", volumeUnit: "share", amountUnit: "CNY", coverage: "unknown", finality: "unknown", adjustment: "unknown",
    observedAt, requested: { startDate: date, endDate: next },
    rows: [row(date, "09:30", 11), row(date, "09:31", 9.8), row(date, "09:32", 10.2), row(next, "09:31", 10.3)],
  };
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline replay must not call a provider"));
  try {
    const minuteRef = await archiveHistoricalMinuteObservations(batch);
    const closeRef = await archiveDailyTradingLimits({
      symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
      coverage: "unknown", priceUnit: "CNY", requested: batch.requested,
      rows: [{ tradeDate: date, previousClose: 10, limitUp: 11, limitDown: 9 },
        { tradeDate: next, previousClose: 10, limitUp: 11, limitDown: 9 }],
    });
    const options = { previousClose: { ref: closeRef, priceBasis: "caller-confirmed-same-basis" } } as const;
    const rule = { id: "recover", conditions: [{ left: "pct_vs_prev_close", op: "cross_up", right: 0 }] } as const;
    const output = await replayTspIntradaySignal(minuteRef, rule, options);
    expect(output).toMatchObject({
      archiveRef: minuteRef, producer: "whyj", formula: { id: "tsp_intraday_custom_signal", version: 1 },
      input: { source: "tushare", endpoint: "stk_mins", previousClose: { archiveRef: closeRef } },
      coverage: { completedBars: 3, tradingDays: 2, openingBoundaries: 1 },
      events: [{ symbol, tradingDate: date, minute: "09:31", originalTradeTime: "2024-01-02 09:32:00" }],
    });
    expect(output.events[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(await replayTspIntradaySignal(minuteRef, rule, options)).toEqual(output);
    expect((await replayTspIntradaySignal(minuteRef, rule)).events).toEqual([]);

    const extended = await archiveHistoricalMinuteObservations({ ...batch, rows: [...batch.rows, row(next, "09:32", 10.4)] });
    const replay = await replayTspIntradaySignal(extended, { ...rule, minBars: 0 }, options);
    expect(replay.archiveRef).not.toEqual(minuteRef);
    expect(replay.events).toEqual(output.events);
    expect(replay.ruleRevision).toBe(output.ruleRevision);
    const changed = await replayTspIntradaySignal(minuteRef, { ...rule, minBars: 2 }, options);
    expect(changed.events[0]?.eventId).not.toBe(output.events[0]?.eventId);
    await expect(replayTspIntradaySignal({ ...minuteRef, revision: "f".repeat(64) }, rule, options)).rejects.toThrow();
    expect(await loadHistoricalMinuteArchive(minuteRef)).toEqual(batch);
    expect(http).not.toHaveBeenCalled();
  } finally {
    http.mockRestore();
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

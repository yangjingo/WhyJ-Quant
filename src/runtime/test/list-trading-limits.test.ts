import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspListRows, type TspListRowsRequest } from "../data/list-rows.ts";

const symbol = "600000.SH";
const days = ["2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07"] as const;
const observedAt = "2025-03-08T00:00:00Z";
const requested = { startDate: days[0], endDate: days[4] };

function market(tradeDate: string) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({
    market: "A", source: "tushare", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "Example stock", listedOn: null, industry: null }] },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

function prices(sessions: readonly string[], adjustment: "none" | "forward") {
  return archiveTradingDateObservations(sessions.map((tradeDate): StoredTradingDateBarObservation => {
    const rawClose = tradeDate === days[3] ? 10 : 11;
    const close = adjustment === "none" ? rawClose : rawClose / 2;
    return {
      schemaVersion: 2, kind: "trading_date_daily_bar", tradeDate, symbol, market: "A", assetType: "stock",
      observedAt, interval: "1d", calendarTimeZone: "Asia/Shanghai", requested,
      ...(adjustment === "none" ?
        { source: "tushare", endpoint: "daily", volumeUnit: "hand", amountUnit: "CNY-thousand", sourceTimestamp: null } :
        { source: "tickflow", endpoint: "/v1/klines", volumeUnit: "unknown", amountUnit: "unknown",
          sourceTimestamp: Date.parse(tradeDate + "T15:00:00+08:00") }),
      adjustment, coverage: "unknown",
      values: { open: close, high: close, low: close, close, volume: 100, amount: null },
    };
  }));
}

function limits(sessions: readonly string[], code = symbol) {
  return archiveDailyTradingLimits({
    market: "A", symbol: code, source: "tushare", endpoint: "stk_limit", observedAt, coverage: "unknown", priceUnit: "CNY", requested,
    rows: sessions.map(tradeDate => ({ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 })),
  });
}

test("projects native threshold prices and reconstructs counts only from exact exchange sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-limit-runtime-"));
  const previous = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline fixture"));
  try {
    const coveredDays = days.filter(day => day !== days[1]);
    const marketRef = await market(days[4]);
    const tradingLimitArchiveRef = await limits(coveredDays);
    const history = { ref: await prices(coveredDays, "forward"), exchange: {
      rawArchiveRef: await prices(coveredDays, "none"), tradingLimitArchiveRef,
    } };
    const request: TspListRowsRequest = {
      marketRef, adjustment: "forward", stocks: [{ symbol, history }],
      limitCalendar: { revision: "fixture-exchange-calendar", sessions: days },
    };
    const result = await replayTspListRows(request);
    expect(result).toMatchObject({ limitCalendar: { ...request.limitCalendar, zone: "Asia/Shanghai" },
      rows: [{ observations: { tradingLimits: { ref: tradingLimitArchiveRef, symbol, source: "tushare", endpoint: "stk_limit",
        priceUnit: "CNY", observedAt, requested, row: { tradeDate: days[4], previousClose: 10, limitUp: 11, limitDown: 9 } } },
      metrics: { signals: { values: { signal_limit_up: true, signal_limit_down: false } },
        limitStreaks: { producer: "whyj", formula: { id: "tsp_limit_streaks", version: 1 }, consecutiveLimitUps: 1, consecutiveLimitDowns: 0 } } }] });
    expect(await replayTspListRows(request)).toEqual(result);

    const leadingDays = [days[0], days[2]];
    const leading = await replayTspListRows({ ...request, marketRef: await market(days[2]),
      limitCalendar: { revision: "fixture-early-calendar", sessions: days.slice(0, 3) }, stocks: [{ symbol, history: {
        ref: await prices(leadingDays, "forward"), exchange: { tradingLimitArchiveRef, rawArchiveRef: await prices(leadingDays, "none") },
      } }] });
    expect(leading.rows[0]?.metrics.limitStreaks).toMatchObject({ consecutiveLimitUps: null, consecutiveLimitDowns: 0 });

    const sourceOnly = await replayTspListRows({ ...request, stocks: [{ symbol, tradingLimitsRef: tradingLimitArchiveRef }] });
    expect(sourceOnly.rows[0]?.observations.tradingLimits).toEqual(result.rows[0]?.observations.tradingLimits);
    expect(sourceOnly.rows[0]?.metrics.limitStreaks).toMatchObject({ consecutiveLimitUps: null, consecutiveLimitDowns: null });
    const missing = await replayTspListRows({ ...request, stocks: [{ symbol, tradingLimitsRef: await limits(days.slice(0, 1)) }] });
    expect(missing.rows[0]?.observations.tradingLimits?.row).toBeNull();

    await expect(replayTspListRows({ ...request, stocks: [{ symbol, history, tradingLimitsRef: tradingLimitArchiveRef }] }))
      .rejects.toThrow("competing");
    await expect(replayTspListRows({ ...request, stocks: [{ symbol, tradingLimitsRef: await limits(coveredDays, "600001.SH") }] }))
      .rejects.toThrow("do not match");
    for (const sessions of [days.toReversed(), [...days, days[4]], days.slice(0, -1)]) {
      await expect(replayTspListRows({ ...request, limitCalendar: { revision: "bad", sessions } })).rejects.toThrow("ordered sessions");
    }
    const legacy = await replayTspListRows({ marketRef, adjustment: "forward", stocks: [{ symbol }] });
    expect(legacy).not.toHaveProperty("limitCalendar");
    expect(legacy.rows[0]?.observations).not.toHaveProperty("tradingLimits");
    expect(legacy.rows[0]?.metrics).not.toHaveProperty("limitStreaks");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

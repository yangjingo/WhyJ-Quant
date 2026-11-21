import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspAbnormalSnapshot, type AbnormalSnapshotReplayRequest } from "../data/abnormal-snapshot-replay.ts";

test("assembles ranked abnormal evidence from a fixed market and exact per-stock histories", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-abnormal-snapshot-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const tradeDate = "2024-03-11", observedAt = "2024-03-13T00:00:00Z";
  const sessions = ["2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08", tradeDate];
  const symbols = ["600001.SH", "600002.SH", "600003.SH"];
  const metadata = { tradeDate, observedAt, coverage: "unknown" } as const;
  const market: StoredMarketCrossSection = {
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, listedOn: null, industry: null })) },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.slice(0, 2).map((symbol, index) => ({
        symbol, open: 10, high: 11, low: 9, close: 10, exRightsPreviousClose: null,
        volume: 100, amount: 100, changeCny: null, returnPct: index === 0 ? 5 : -15,
      })) },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
  const history = (symbol: string, dates: string[]) => archiveTradingDateObservations(dates.map((date): StoredTradingDateBarObservation => ({
    schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate: date, interval: "1d", assetType: "stock", market: "A",
    calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines", adjustment: "none", observedAt,
    sourceTimestamp: Date.parse(date + "T15:00:00+08:00"), requested: { startDate: sessions[0]!, endDate: dates.at(-1)! },
    volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
    values: { open: 10, high: 11, low: 9, close: 10, volume: date === tradeDate ? 300 : 100, amount: null },
  })));
  try {
    const marketRef = await archiveMarketCrossSection(market);
    const refs = await Promise.all([history(symbols[0]!, sessions), history(symbols[1]!, sessions), history(symbols[2]!, sessions.slice(0, -1))]);
    const tradingLimitArchiveRef = await archiveDailyTradingLimits({
      symbol: symbols[0]!, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
      priceUnit: "CNY", coverage: "unknown", requested: { startDate: sessions.at(-2)!, endDate: tradeDate },
      rows: [{ tradeDate: sessions.at(-2)!, previousClose: 10, limitUp: 11, limitDown: 9 },
        { tradeDate, previousClose: 9.09, limitUp: 10, limitDown: 8.18 }],
    });
    const request: AbnormalSnapshotReplayRequest = {
      marketRef, sessions, adjustment: "none", limit: 1,
      histories: symbols.map((symbol, index) => ({
        symbol, ref: refs[index]!, ...(index === 0 && { exchange: { tradingLimitArchiveRef } }),
      })),
    };
    const report = await replayTspAbnormalSnapshot(request);
    expect(report).toMatchObject({
      producer: "whyj", basis: "completed-session", market: { source: "tushare", ref: marketRef, tradeDate, rosterCount: 3 },
      matchedCount: 2, scopedCount: 3, counts: { limit_up: 1, volume_surge: 2 }, unknown: { limit_up: 2, volume_surge: 1 },
      rows: [{ symbol: symbols[0], signals: ["limit_up", "volume_surge"], changeFraction: 0.05,
        provider: { closeCny: 10, changePct: 5, turnoverPct: null },
        derived: { amplitudeFraction: 0.2, volumeRatio5d: 3, consecutiveLimitUps: 1 } }],
    });
    expect(report.histories[0]).toMatchObject({ daily: { ref: refs[0] }, exchange: { limits: { ref: tradingLimitArchiveRef } } });
    expect(await replayTspAbnormalSnapshot(request)).toEqual(report);
    await expect(replayTspAbnormalSnapshot({ ...request, sessions: sessions.slice(0, -1) })).rejects.toThrow("last exchange session");
    await expect(replayTspAbnormalSnapshot({ ...request, sessions: [sessions[0]!, tradeDate] })).rejects.toThrow("streak signal observations");
    await expect(replayTspAbnormalSnapshot({ ...request, adjustment: "forward" })).rejects.toThrow("basis");
    const future = await history(symbols[1]!, [...sessions, "2024-03-12"]);
    await expect(replayTspAbnormalSnapshot({ ...request, histories: [{ symbol: symbols[1]!, ref: future }] })).rejects.toThrow("future");
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

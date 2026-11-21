import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspScreener, replayTspScreenerUnion, type ScreenerReplayRequest } from "../data/screener-replay.ts";

const tradeDate = "2024-01-15";
const sessions = ["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", tradeDate];
const symbols = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH"];
const observedAt = "2024-01-17T02:00:00Z";
const meta = { tradeDate, observedAt, coverage: "unknown" } as const;

function history(symbol: string, lastVolume: number, dates = sessions, adjustment: "none" | "forward" = "forward") {
  return archiveTradingDateObservations(dates.map((date, index): StoredTradingDateBarObservation => ({
    schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate: date, interval: "1d", assetType: "stock",
    market: "A", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
    sourceTimestamp: Date.parse(date + "T15:00:00+08:00"), requested: { startDate: sessions[0]!, endDate: dates.at(-1)! },
    observedAt, adjustment, volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
    values: { open: 10, high: 10, low: 10, close: 10, volume: index === dates.length - 1 ? lastVolume : 100, amount: null },
  })));
}

test("scores only matched dated stocks and preserves raw-provider and missing evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-screener-replay-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const snapshot: StoredMarketCrossSection = {
    source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, listedOn: null, industry: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.map((symbol, i) => ({ symbol, open: 12, high: 12, low: 12, close: 12, exRightsPreviousClose: null,
        returnPct: null, changeCny: null, volume: 5, amount: i === 2 ? 100_000 : 100 + 50 * i })) },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
  try {
    const marketRef = await archiveMarketCrossSection(snapshot);
    const refs = await Promise.all([
      history(symbols[0]!, 250), history(symbols[1]!, 300), history(symbols[2]!, 100),
      history(symbols[3]!, 300, [tradeDate]), history(symbols[4]!, 300, sessions.slice(0, -1)),
    ]);
    const request: ScreenerReplayRequest = {
      marketRef, adjustment: "forward", histories: symbols.map((symbol, index) => ({ symbol, ref: refs[index]! })),
      strategy: { id: "daily-volume", revision: "a".repeat(64) },
      signalGate: { mode: "any", signals: ["signal_volume_surge", "signal_limit_up"] },
      weights: [{ field: "amount", weight: 1 }, { field: "vol_ratio_5d", weight: 1 }],
      displayLimit: 1,
    };
    const replay = await replayTspScreener(request);
    expect(replay).toMatchObject({
      market: { ref: marketRef, source: "tushare", tradeDate },
      coverage: { scoped: 5, matched: 2, notMatched: 0, unavailable: 3 },
      candidateSymbols: symbols.slice(0, 2),
      fieldSources: { amount: { producer: "tushare", nativeUnit: "CNY-thousand" },
        vol_ratio_5d: { producer: "whyj", formula: "tsp_daily_ohlcv" } },
      ranking: { candidateCount: 2, selected: [{ symbol: symbols[1], score: 100, position: 1 }],
        scoring: { fields: [
          { field: "amount", min: 100_000, max: 150_000, observedCount: 2 },
          { field: "vol_ratio_5d", min: 2.5, max: 3, observedCount: 2 },
        ] } },
    });
    expect(replay.ranking.candidateRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(await replayTspScreener(request)).toEqual(replay);
    const singleSignal = { ...request, signalGate: { mode: "all", signals: ["signal_volume_surge"] } } as const;
    expect((await replayTspScreener(singleSignal)).evaluated.map(row => row.status))
      .toEqual(["matched", "matched", "not-matched", "unavailable", "unavailable"]);
    const both = await replayTspScreener({ ...request, signalGate: { ...request.signalGate!, mode: "all" } });
    expect(both.evaluated.map(row => row.status))
      .toEqual(["unavailable", "unavailable", "not-matched", "unavailable", "unavailable"]);
    expect(both.ranking.selected).toEqual([]);
    expect(both.ranking.candidateRevision).not.toBe(replay.ranking.candidateRevision);

    const volume = {
      strategy: request.strategy,
      weights: [],
      signalGate: singleSignal.signalGate,
      orderBy: "vol_ratio_5d",
    };
    const value = {
      strategy: { id: "value", revision: "b".repeat(64) },
      weights: [{ field: "raw_close", weight: 1 }],
    };
    const unionRequest = { marketRef, adjustment: request.adjustment, histories: request.histories,
      strategies: [volume, value] };
    const union = await replayTspScreenerUnion(unionRequest);
    expect(union.market).toMatchObject({ ref: marketRef, tradeDate });
    expect(union.replays.map(item => item.ranking.strategy)).toEqual([volume.strategy, value.strategy]);
    expect(union.rows).toEqual([
      { symbol: symbols[2], score: 50, scoreStrategyId: "value", hits: [{ strategyId: "value", score: 50 }] },
      { symbol: symbols[3], score: 50, scoreStrategyId: "value", hits: [{ strategyId: "value", score: 50 }] },
      { symbol: symbols[1], score: null, scoreStrategyId: "daily-volume",
        hits: [{ strategyId: "daily-volume", score: null }, { strategyId: "value", score: 50 }] },
      { symbol: symbols[0], score: null, scoreStrategyId: "daily-volume",
        hits: [{ strategyId: "daily-volume", score: null }, { strategyId: "value", score: 50 }] },
    ]);
    expect(await replayTspScreenerUnion(unionRequest)).toEqual(union);
    const reversed = await replayTspScreenerUnion({ ...unionRequest, strategies: [value, volume] });
    expect(reversed.rows.map(row => [row.symbol, row.score, row.scoreStrategyId]))
      .toEqual(symbols.slice(0, 4).map(symbol => [symbol, 50, "value"]));
    await expect(replayTspScreenerUnion({ ...unionRequest, strategies: [volume, volume] })).rejects.toThrow("unique");
    await expect(replayTspScreenerUnion({ ...unionRequest, strategies: [] })).rejects.toThrow("at least one");
    await expect(replayTspScreenerUnion(unionRequest, AbortSignal.abort())).rejects.toThrow();

    const [rawArchiveRef, tradingLimitArchiveRef] = await Promise.all([
      history(symbols[2]!, 100, sessions, "none"),
      archiveDailyTradingLimits({
        symbol: symbols[2]!, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
        priceUnit: "CNY", coverage: "unknown", requested: { startDate: tradeDate, endDate: tradeDate },
        rows: [{ tradeDate, previousClose: 9.1, limitUp: 10, limitDown: 8.2 }],
      }),
    ]);
    const exchange = { rawArchiveRef, tradingLimitArchiveRef };
    const withLimits = await replayTspScreener({ ...request,
      histories: [{ ...request.histories[2]!, exchange }],
      signalGate: { mode: "all", signals: ["signal_limit_up"] },
    });
    expect(withLimits.evaluated[0]).toMatchObject({
      symbol: symbols[2], status: "matched", signals: [{ id: "signal_limit_up", value: true }],
      exchange: { raw: { ref: rawArchiveRef }, limits: { ref: tradingLimitArchiveRef } },
    });
    expect(withLimits.ranking.selected[0]).toMatchObject({ symbol: symbols[2], score: 50 });

    await expect(replayTspScreener({ ...request, histories: [request.histories[0]!, request.histories[0]!] }))
      .rejects.toThrow("duplicate");
    await expect(replayTspScreener({ ...request, adjustment: "none" })).rejects.toThrow("price basis");
    await expect(replayTspScreener({ ...request, histories: [{ symbol: symbols[0]!, ref: refs[1]! }] }))
      .rejects.toThrow("mismatched symbol");
    const future = await history(symbols[0]!, 400, [...sessions, "2024-01-16"]);
    await expect(replayTspScreener({ ...request, histories: [{ symbol: symbols[0]!, ref: future }] }))
      .rejects.toThrow("future trade date");
    await expect(replayTspScreenerUnion({ ...unionRequest, histories: [{ symbol: symbols[0]!, ref: future }] }))
      .rejects.toThrow("future trade date");
    await expect(replayTspScreener(request, AbortSignal.abort())).rejects.toThrow();
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

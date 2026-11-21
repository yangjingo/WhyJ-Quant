import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspListLiquidity } from "../data/list-liquidity.ts";
import { replayTspListRows } from "../data/list-rows.ts";

test("replays one dated stock with distinct Tushare and WhyJ evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-liquidity-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const symbol = "600519.SH", tradeDate = "2024-03-04";
  const metadata = { tradeDate, observedAt: "2024-03-05T03:00:00Z", coverage: "unknown" } as const;
  const snapshot: StoredMarketCrossSection = {
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [
      { symbol: "600000.SH", name: "no observations", industry: null, listedOn: null },
      { symbol, name: "fixture", industry: null, listedOn: null },
    ] },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
      amountUnit: "CNY-thousand", rows: [
        { symbol, open: 10, high: 11, low: 10, close: 10.5, exRightsPreviousClose: 10,
          changeCny: 0.5, returnPct: 5, volume: 750, amount: 125 },
      ] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [
        { symbol, close: 10.4, turnoverPct: 4, freeFloatTurnoverPct: 7, providerVolumeRatio: null,
          totalShares: 400, floatShares: 250, freeFloatShares: 100, pe: null, peTtm: 18, pb: 2,
          totalMarketValue: null, circulatingMarketValue: 2_600 },
      ] },
  };
  const priorDay = "2024-03-01";
  function history(dates: string[]) {
    return archiveTradingDateObservations(dates.map((day, index): StoredTradingDateBarObservation => {
      const close = 8 + index;
      return {
        schemaVersion: 2, kind: "trading_date_daily_bar", interval: "1d", symbol, tradeDate: day,
        market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
        sourceTimestamp: Date.parse(day + "T15:00:00+08:00"), requested: { startDate: dates[0]!, endDate: dates.at(-1)! },
        observedAt: metadata.observedAt, adjustment: "forward", volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
        values: { open: close, high: close, low: close, close, volume: 100, amount: null },
      };
    }));
  }
  try {
    const ref = await archiveMarketCrossSection(snapshot);
    expect(await replayTspListLiquidity(ref, symbol)).toMatchObject({
      archiveRef: ref, symbol, tradeDate, market: "A",
      observations: {
        producer: "tushare",
        daily: { endpoint: "daily", adjustment: "none", volumeUnit: "hand", row: { close: 10.5, volume: 750 } },
        dailyBasic: { endpoint: "daily_basic", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand",
          row: { close: 10.4, turnoverPct: 4, circulatingMarketValue: 2_600 } },
      },
      metrics: { producer: "whyj", formula: { id: "tsp_list_liquidity", version: 1 },
        floatValueCny: 26_250_000, turnoverPct: 3 },
    });
    expect(await replayTspListLiquidity(ref, "600000.SH")).toMatchObject({
      observations: { daily: { row: null }, dailyBasic: { row: null } },
      metrics: { floatValueCny: null, turnoverPct: null },
    });
    snapshot.bars.rows[0]!.volume = 0;
    const corrected = await archiveMarketCrossSection(snapshot);
    expect((await replayTspListLiquidity(corrected, symbol)).metrics.turnoverPct).toBe(0);
    expect((await replayTspListLiquidity(ref, symbol)).metrics.turnoverPct).toBe(3);
    await expect(replayTspListLiquidity(ref, "600001.SH")).rejects.toThrow("absent from the archived roster");
    await expect(replayTspListLiquidity({ ...ref, revision: "invalid" }, symbol)).rejects.toThrow();
    await expect(replayTspListLiquidity(ref, symbol, AbortSignal.abort())).rejects.toThrow();

    const [dailyRef, staleRef, futureRef] = await Promise.all([
      history([priorDay, tradeDate]), history([priorDay]), history([priorDay, tradeDate, "2024-03-05"]),
    ]);
    const listRequest = { marketRef: ref, adjustment: "forward" as const, stocks: [
      { symbol, history: { ref: dailyRef } }, { symbol: "600000.SH" },
    ] };
    const result = await replayTspListRows(listRequest);
    expect(result).toMatchObject({
      marketRef: ref, tradeDate, source: "tushare", adjustment: "forward",
      observations: { roster: { endpoint: "bak_basic" }, daily: { endpoint: "daily", volumeUnit: "hand", amountUnit: "CNY-thousand" },
        dailyBasic: { endpoint: "daily_basic", observedAt: metadata.observedAt } },
      rows: [{
        instrument: { symbol, name: "fixture" },
        observations: {
          bar: { close: 10.5, exRightsPreviousClose: 10, returnPct: 5, changeCny: 0.5 },
          basic: { peTtm: 18, pb: 2, turnoverPct: 4 },
          quantities: { volumeShares: 75_000, amountCny: 125_000 },
        },
        metrics: {
          liquidity: { producer: "whyj", turnoverPct: 3, floatValueCny: 26_250_000 },
          history: { ref: dailyRef, source: "tickflow", adjustment: "forward" },
          daily: { producer: "whyj", date: tradeDate, values: { prev_close: 8, change_pct: 0.125, change_amount: 1 } },
          signals: { producer: "whyj", date: tradeDate, exchangeInputs: null },
        },
      }, {
        instrument: { symbol: "600000.SH" },
        observations: { bar: null, basic: null, quantities: { volumeShares: null, amountCny: null } },
        metrics: { daily: null, signals: null, history: null },
      }],
    });
    expect(await replayTspListRows(listRequest)).toEqual(result);
    const stale = await replayTspListRows({ ...listRequest, stocks: [{ symbol, history: { ref: staleRef } }] });
    expect(stale.rows[0]).toMatchObject({ metrics: { daily: null, signals: null, history: { lastTradeDate: priorDay } } });
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol }, { symbol }] })).rejects.toThrow("Duplicate");
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol: "600001.SH" }] })).rejects.toThrow("absent");
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol: "600000.SH", history: { ref: dailyRef } }] }))
      .rejects.toThrow("mismatched symbol");
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol, history: { ref: futureRef } }] }))
      .rejects.toThrow("future trade date");
    await expect(replayTspListRows({ ...listRequest, adjustment: "none" })).rejects.toThrow("price basis");
    await expect(replayTspListRows(listRequest, AbortSignal.abort())).rejects.toThrow();
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

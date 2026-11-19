import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation,
} from "../../storage/index.ts";
import { deriveTspMarketBreadthArchive } from "../data/market-cross-section.ts";

const tradingDate = "2024-04-30";
const symbol = "600000.SH", other = "000001.SZ";
const fixtureSessions = Array.from({ length: 90 }, (_, offset) => new Date(Date.parse(tradingDate) - offset * 86_400_000))
  .filter(date => date.getUTCDay() % 6 !== 0).map(date => date.toISOString().slice(0, 10)).reverse();
const observedAt = "2024-05-02T00:00:00.000Z";

function crossSection(tradeDate: string, volume: number, otherVolume: number | null): StoredMarketCrossSection {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return {
    source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [
      { symbol: other, name: "Other", industry: null, listedOn: null },
      { symbol, name: "Matched", industry: null, listedOn: null },
    ] },
    bars: { ...meta, endpoint: "daily", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", adjustment: "none",
      rows: ([[other, 9, otherVolume], [symbol, 10, volume]] as const).map(([id, close, vol]) => ({
        symbol: id, open: close, high: close, low: close, close,
        exRightsPreviousClose: close, returnPct: 0, changeCny: 0, volume: vol, amount: null,
      })),
    },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
}

async function priceArchive(ticker: string, lastClose: number, dates = fixtureSessions.slice(-60)) {
  const records: StoredTradingDateBarObservation[] = dates.map((tradeDate, i) => {
    const close = lastClose - (dates.length - 1 - i) / 20;
    return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol: ticker, tradeDate, observedAt,
      sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00"), requested: { startDate: dates[0]!, endDate: dates.at(-1)! },
      source: "tickflow", endpoint: "/v1/klines", market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
      interval: "1d", adjustment: "forward", volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
      values: { open: close, high: close, low: close, close, volume: 777, amount: null },
    };
  });
  return archiveTradingDateObservations(records);
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-market-history-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("replays pinned trend and five prior volumes, independently of mismatches or gaps", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const archive = await archiveMarketCrossSection(crossSection(tradingDate, 20, 10));
    const compatible = await priceArchive(symbol, 10);
    const differentDayClose = await priceArchive(other, 9.01);
    const previousDates = fixtureSessions.slice(-6, -1);
    const volumes = await Promise.all(previousDates.map((date, index) =>
      archiveMarketCrossSection(crossSection(date, 10, index === 0 ? null : 10))));
    const args = { priceArchives: [compatible, differentDayClose], volumeArchives: volumes };
    const result = await deriveTspMarketBreadthArchive(archive, undefined, args);
    const { trend, activity, coverage } = result.metrics;
    expect(coverage.eligible).toBe(2);
    expect(trend.aboveMa5).toEqual({ count: 1, denominator: 1, fraction: 1 });
    expect(trend.aboveMa20).toEqual(trend.aboveMa5);
    expect(trend.aboveMa60).toEqual(trend.aboveMa5);
    expect(trend.newHigh).toEqual(trend.aboveMa5);
    expect(trend.newLow).toEqual({ count: 0, denominator: 1, fraction: 0 });
    expect(activity.volumeRatio).toEqual({ total: 2, average: 2, denominator: 1 });
    expect(activity.highVolume).toEqual({ count: 1, denominator: 1, fraction: 1 });
    const rolling = result.input.rollingInputs;
    if (rolling === "unavailable") throw new Error("Missing rolling history");
    expect(rolling.prices.map(row => [row.archiveRef, row.comparison])).toEqual([
      [compatible, "matched"], [differentDayClose, "different-current-close"],
    ]);
    expect(rolling.volumes.map(row => row.tradeDate)).toEqual(previousDates);
    expect(await deriveTspMarketBreadthArchive(archive, undefined, args)).toEqual(result);
    const without = await deriveTspMarketBreadthArchive(archive);
    expect(without.input.rollingInputs).toBe("unavailable");
    expect(without.metrics.trend.aboveMa5.fraction).toBeNull();
    expect(without.metrics.activity.volumeRatio.average).toBeNull();
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

test("rejects out-of-session evidence and leaves incomplete windows unavailable", async () => {
  const archive = await archiveMarketCrossSection(crossSection(tradingDate, 20, 10));
  const preceding = await archiveMarketCrossSection(crossSection(fixtureSessions.at(-2)!, 0, 0));
  const warmup = await priceArchive(symbol, 10, fixtureSessions.slice(-5));
  const partial = await deriveTspMarketBreadthArchive(archive, undefined, { priceArchives: [warmup], volumeArchives: [preceding] });
  expect(partial.metrics.trend.aboveMa5.denominator).toBe(1);
  expect(partial.metrics.trend.aboveMa20.fraction).toBeNull();
  expect(partial.metrics.trend.newHigh.fraction).toBeNull();
  expect(partial.metrics.activity.volumeRatio.average).toBeNull();
  await expect(deriveTspMarketBreadthArchive(archive, undefined, { volumeArchives: [archive] })).rejects.toThrow("volume archive");
  await expect(deriveTspMarketBreadthArchive(archive, undefined, { volumeArchives: [preceding, preceding] })).rejects.toThrow("volume archive");
  await expect(deriveTspMarketBreadthArchive(archive, undefined, { priceArchives: [warmup, warmup] })).rejects.toThrow("price archive");
  const foreign = await priceArchive("600001.SH", 10);
  await expect(deriveTspMarketBreadthArchive(archive, undefined, { priceArchives: [foreign] })).rejects.toThrow("price archive");
  const wrongDate = await priceArchive(symbol, 10, fixtureSessions.slice(-61, -1));
  await expect(deriveTspMarketBreadthArchive(archive, undefined, { priceArchives: [wrongDate] })).rejects.toThrow("price archive");
  await expect(deriveTspMarketBreadthArchive(archive, AbortSignal.abort(), { priceArchives: [warmup] })).rejects.toThrow();
});

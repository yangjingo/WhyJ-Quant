import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspPriceDeviation } from "../data/price-deviation-replay.ts";
import { replayTspListRows, replayTspListRowsWithLiveQuotes } from "../data/list-rows.ts";

const sessions = Array.from({ length: 52 }, (_, offset) => new Date(Date.UTC(2025, 2, 3 + offset)))
  .filter(date => date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
  .slice(0, 33).map(date => date.toISOString().slice(0, 10));
const start = sessions[0]!, end = sessions.at(-1)!;
const observedAt = "2025-06-01T00:00:00Z";
const mainBoard = "600001.SH";

function stock(symbol = mainBoard, omit?: string, adjustment: "forward" | "none" = "forward") {
  const rows = sessions.map<StoredTradingDateBarObservation>((tradeDate, index) => {
    const close = 10 * 1.02 ** index;
    return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, observedAt,
      sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00"), requested: { startDate: start, endDate: end },
      source: "tickflow", endpoint: "/v1/klines", market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
      interval: "1d", adjustment, volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
      values: { open: close, high: close, low: close, close, volume: 100, amount: null },
    };
  });
  return archiveTradingDateObservations(rows.filter(row => row.tradeDate !== omit).reverse());
}

function benchmark(symbol: string, omit?: string, closeAt = (index: number) => 1000 * 1.01 ** index) {
  return archiveBenchmarkIndexObservations({ symbol, source: "tushare", market: "A", endpoint: "index_daily",
    coverage: "unknown", priceUnit: "index-points", returnUnit: "percentage-points", requested: { start, end }, observedAt,
    rows: sessions.map((tradeDate, index) => ({
      tradeDate, closePoints: closeAt(index), previousClosePoints: null, changePoints: null, returnPct: null,
    })).filter(row => row.tradeDate !== omit),
  });
}

let root: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-price-deviation-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("replays all deviation windows from archived closes and preserves the chosen point series", async () => {
  const request = { symbol: mainBoard, sessions, stockRef: await stock(), benchmarkRef: await benchmark("000002.SH") };
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Replay must stay offline"));
  try {
    const result = await replayTspPriceDeviation(request);
    expect(result).toMatchObject({
      producer: "whyj", formula: { id: "tsp_price_deviation", version: 1 }, outputUnit: "fraction",
      calendar: { zone: "Asia/Shanghai", sessions }, symbol: mainBoard, board: "SH", benchmark: "000002.SH",
      benchmarkCandidates: ["000002.SH", "000001.SH"],
      input: { stock: { ref: request.stockRef, observedAt, adjustment: "forward", rowsUsed: 33 },
        benchmark: { ref: request.benchmarkRef, symbol: "000002.SH", priceUnit: "index-points", rowsUsed: 33 } },
    });
    const last = result.rows.at(-1)!;
    const proximity = result.proximity.rows.at(-1)!;
    expect(result.proximity).toMatchObject({
      producer: "whyj", basis: "completed-session", unit: "fraction", formula: { id: "tsp_deviation_proximity", version: 1 },
    });
    expect(proximity).toMatchObject({ date: last.date, dominantWindow: 30, tier: "below-watch" });
    for (const window of [3, 10, 30] as const) {
      expect(last.comparisonDates[window]).toBe(sessions[sessions.length - 1 - window]!);
      expect(last.values[`deviate_${window}d`]).toBeCloseTo(1.02 ** window - 1.01 ** window, 12);
      const evidence = proximity.windows.find(item => item.window === window)!;
      expect(evidence.threshold).toBe({ 3: 0.20, 10: 1, 30: 2 }[window]);
      expect(evidence.closeness).toBeCloseTo(last.values[`deviate_${window}d`]! / evidence.threshold!, 12);
    }
    const prefix = await replayTspPriceDeviation({ ...request, sessions: sessions.slice(0, -1) });
    expect(prefix.rows).toEqual(result.rows.slice(0, -1));
    expect(prefix.proximity.rows).toEqual(result.proximity.rows.slice(0, -1));
    expect(await replayTspPriceDeviation(request)).toEqual(result);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

test("keeps original endpoints and availability with missing records, no benchmark or an explicitly selected alternate", async () => {
  const missingStock = sessions.at(-4)!;
  const missingIndex = sessions.at(-11)!;
  const request = { symbol: mainBoard, sessions, stockRef: await stock(mainBoard, missingStock),
    benchmarkRef: await benchmark("000002.SH", missingIndex) };
  const day = (await replayTspPriceDeviation(request)).rows.at(-1)!;
  expect(day).toMatchObject({
    comparisonDates: { 3: missingStock, 10: missingIndex, 30: sessions.at(-31) },
    values: { deviate_3d: null, deviate_10d: null, deviate_30d: expect.any(Number) },
  });
  const noBenchmark = await replayTspPriceDeviation({ ...request, benchmarkRef: undefined });
  expect(noBenchmark).toMatchObject({
    benchmark: null, input: { benchmark: null },
  });
  expect(noBenchmark.proximity.rows.at(-1)).toMatchObject({ tier: "unavailable", dominantWindow: null, maxCloseness: null });
  const bseSymbol = "920001.BJ";
  const alternate = await replayTspPriceDeviation({
    ...request, symbol: bseSymbol, stockRef: await stock(bseSymbol), benchmarkRef: await benchmark("000001.SH"),
  });
  expect(alternate).toMatchObject({ board: "BJ", benchmark: "000001.SH", benchmarkCandidates: ["899050.BJ", "000001.SH"] });
  expect(alternate.rows.at(-1)?.values.deviate_30d).toBeCloseTo(1.02 ** 30 - 1.01 ** 30, 12);
});

test("rejects wrong archive identity, price basis and calendar while preserving cancellation", async () => {
  const request = { symbol: mainBoard, sessions, stockRef: await stock(), benchmarkRef: await benchmark("000002.SH") };
  await expect(replayTspPriceDeviation({ ...request, symbol: "600003.SH" }))
    .rejects.toThrow("Incompatible price deviation stock");
  await expect(replayTspPriceDeviation({ ...request, stockRef: await stock(mainBoard, undefined, "none") }))
    .rejects.toThrow("Incompatible price deviation stock");
  await expect(replayTspPriceDeviation({ ...request, benchmarkRef: await benchmark("399001.SZ") }))
    .rejects.toThrow("Incompatible price deviation benchmark");
  await expect(replayTspPriceDeviation({ ...request, sessions: [sessions[1]!, sessions[0]!] }))
    .rejects.toThrow("ordered unique exchange sessions");
  await expect(replayTspPriceDeviation({ ...request, sessions: [start, end] }))
    .rejects.toThrow("off-calendar observation");
  await expect(replayTspPriceDeviation(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("projects the exact dated deviation and proximity onto list rows without replacing provider fields", async () => {
  const other = "600002.SH";
  const meta = { tradeDate: end, observedAt, coverage: "unknown" } as const;
  const marketRef = await archiveMarketCrossSection({
    source: "tushare", market: "A", tradeDate: end,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [mainBoard, other].map(symbol => ({ symbol, name: symbol, listedOn: null, industry: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol: mainBoard, open: 12, high: 12, low: 12, close: 12, exRightsPreviousClose: null, returnPct: null,
        changeCny: null, volume: 100, amount: null }] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const [stockRef, benchmarkRef, zeroBenchmark, wrongBenchmark] = await Promise.all([
    stock(), benchmark("000002.SH"), benchmark("000002.SH", undefined, index => 10 * 1.02 ** index), benchmark("399001.SZ"),
  ]);
  const deviationCalendar = { revision: "fixture-exchange-calendar", sessions };
  const list = { marketRef, adjustment: "none" as const, deviationCalendar,
    stocks: [{ symbol: mainBoard, deviation: { stockRef, benchmarkRef } }, { symbol: other }] };
  const { rows, proximity: { rows: proximityRows, ...proximity }, calendar, ...report } =
    await replayTspPriceDeviation({ symbol: mainBoard, sessions, stockRef, benchmarkRef });
  const fixed = await replayTspListRows(list);
  expect(fixed.deviationCalendar).toEqual({ ...deviationCalendar, ...calendar });
  expect(fixed.rows[0]?.metrics.deviation).toEqual({ ...report, ...rows.at(-1)!, proximity: { ...proximity, ...proximityRows.at(-1)! } });
  expect(fixed.rows[0]?.observations.bar?.close).toBe(12);
  expect(fixed.rows[1]?.metrics).not.toHaveProperty("deviation");
  expect(await replayTspListRowsWithLiveQuotes(list)).toEqual({ fixed, quotes: { status: "outside-current-day" } });
  const withBenchmark = (benchmarkRef?: typeof zeroBenchmark) => replayTspListRows({ ...list,
    stocks: [{ symbol: mainBoard, deviation: { stockRef, benchmarkRef } }],
  });
  expect((await withBenchmark(zeroBenchmark)).rows[0]?.metrics.deviation?.values)
    .toEqual({ deviate_3d: 0, deviate_10d: 0, deviate_30d: 0 });
  expect((await withBenchmark(undefined)).rows[0]?.metrics.deviation).toMatchObject({
    input: { benchmark: null }, values: { deviate_3d: null, deviate_10d: null, deviate_30d: null },
    proximity: { tier: "unavailable" },
  });
  await expect(withBenchmark(wrongBenchmark)).rejects.toThrow("Incompatible price deviation benchmark");
  await expect(replayTspListRows({ ...list, stocks: [{ symbol: other, deviation: { stockRef, benchmarkRef } }] }))
    .rejects.toThrow("Incompatible price deviation stock");
  await expect(replayTspListRows({ ...list, deviationCalendar: undefined })).rejects.toThrow("calendar");
  await expect(replayTspListRows({ ...list, deviationCalendar: { ...deviationCalendar, sessions: sessions.slice(0, -1) } }))
    .rejects.toThrow("ending at the trade date");
  const legacy = await replayTspListRows({ marketRef, adjustment: "none", stocks: [{ symbol: mainBoard }] });
  expect(legacy).not.toHaveProperty("deviationCalendar");
  expect(legacy.rows[0]?.metrics).not.toHaveProperty("deviation");
});

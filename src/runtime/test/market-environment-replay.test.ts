import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBenchmarkIndexObservations, archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspMarketEnvironment } from "../data/market-environment-replay.ts";

const sessions = ["2024-08-27", "2024-08-28", "2024-08-29"] as const;
const target = sessions[1], observedAt = "2024-09-01T00:00:00Z";
const symbols = ["600000.SH", "600001.SH", "600002.SH", "600003.SH", "600004.SH"];
const window = Array.from({ length: 45 }, (_, offset) => new Date(Date.parse(target) - offset * 86_400_000))
  .filter(date => date.getUTCDay() % 6 !== 0).map(date => date.toISOString().slice(0, 10)).reverse().slice(-20);

function prices(symbol: string, lastClose: number, dates = window, adjustment: "none" | "forward" = "forward") {
  return archiveTradingDateObservations(dates.map<StoredTradingDateBarObservation>((tradeDate, index) => {
    const close = index === dates.length - 1 ? lastClose : 100;
    return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, observedAt,
      sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00"), requested: { startDate: dates[0]!, endDate: dates.at(-1)! },
      source: "tickflow", endpoint: "/v1/klines", market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
      interval: "1d", adjustment, volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
      values: { open: close, high: close, low: close, close, volume: 100, amount: null },
    };
  }));
}

function benchmark(symbol = "000001.SH", returnPct: number | null = -1.5) {
  return archiveBenchmarkIndexObservations({ symbol, source: "tushare", market: "A", endpoint: "index_daily", observedAt,
    coverage: "unknown", priceUnit: "index-points", returnUnit: "percentage-points", requested: { start: sessions[0], end: sessions[2] },
    rows: [{ tradeDate: target, closePoints: 2955, previousClosePoints: 3000, changePoints: -45, returnPct }],
  });
}

async function fixture() {
  const meta = { tradeDate: target, observedAt, coverage: "unknown" } as const;
  const marketRef = await archiveMarketCrossSection({ source: "tushare", market: "A", tradeDate: target,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, industry: null, listedOn: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [...symbols, "600005.SH"].map(symbol => ({ symbol, open: 9, high: 9, low: 9, close: 9,
        exRightsPreviousClose: 9, changeCny: 0, returnPct: 0, volume: 100, amount: 1 })) },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const limitRefs = await Promise.all(symbols.map(symbol => archiveDailyTradingLimits({ symbol, market: "A", source: "tushare",
    endpoint: "stk_limit", observedAt, coverage: "unknown", priceUnit: "CNY", requested: { startDate: target, endDate: target },
    rows: [{ tradeDate: target, previousClose: 9, limitUp: 10, limitDown: 8 }],
  })));
  const refs = await Promise.all([prices(symbols[0]!, 103), prices(symbols[1]!, 97), prices(symbols[2]!, 100),
    prices(symbols[3]!, 110, window.slice(-2))]);
  return { sessions, marketRefs: [marketRef], limitRefs, priceHistory: [{ tradeDate: target, refs }],
    benchmark: { symbol: "000001.SH", refs: [await benchmark()] } };
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-market-environment-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("uses adjusted returns, numeric median and strict MA20 against archived index and exchange evidence", async () => {
  const request = await fixture();
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  try {
    const result = await replayTspMarketEnvironment(request);
    const [gap, day] = result.rows;
    expect(gap?.regime).toBeNull();
    expect(gap?.phase.futureFields).toEqual([]);
    expect(day?.inputs.prices).toMatchObject({ rowCount: 5, missingBars: 0, returnCount: 4, ma20Count: 3, aboveMa20: 1 });
    expect(day?.inputs.benchmark).toEqual({ ref: request.benchmark.refs[0], returnPct: -1.5 });
    const evidence = day?.regime?.input.evidence;
    expect(evidence?.upFraction?.observed).toBe(2 / 5);
    expect(evidence?.averageFraction?.observed).toBeCloseTo(0.025);
    expect(evidence?.medianFraction?.observed).toBeCloseTo(0.015);
    expect(evidence?.strongDownFraction?.observed).toBe(1 / 5);
    expect(evidence?.strongDifferenceFraction?.observed).toBe(1 / 5);
    expect(evidence?.aboveMa20Fraction?.observed).toBe(1 / 3);
    expect(evidence?.indexChangeFraction?.observed).toBe(-0.015);
    expect(evidence?.limitUpCount?.observed).toBe(0);
    expect(evidence?.sealFraction?.observed).toBe(0.5);
    expect(day?.phase.phase).toBeNull();
    expect(day?.phase.smoothed.promotionFraction.basis).toBe("unavailable");
    const retrospective = await replayTspMarketEnvironment({ ...request, phaseMode: "retrospective-tsp" });
    expect(retrospective.rows[0]?.phase.smoothed.height).toMatchObject({ sourceDate: target, basis: "later-observation" });
    expect(retrospective.rows[1]?.phase.phase).toBe("ice");
    expect(await replayTspMarketEnvironment(request)).toEqual(result);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

test("keeps missing histories explicit and rejects incompatible or duplicate references", async () => {
  const request = await fixture();
  const partial = await replayTspMarketEnvironment({ ...request, limitRefs: [], priceHistory: [],
    benchmark: { ...request.benchmark, refs: [await benchmark("000001.SH", null)] } });
  const row = partial.rows[1]!;
  expect(row.inputs.prices?.returnCount).toBe(0);
  expect(row.inputs.benchmark?.returnPct).toBeNull();
  expect(row.regime?.input).toMatchObject({ availability: "unavailable", observed: 0 });
  expect(row.ladder?.seal.basis).toBe("partial-events");
  expect(row.regime?.score).toBeNull();

  const incompatible = [
    await prices(symbols[0]!, 103, window, "none"),
    await prices(symbols[0]!, 103, [...window, sessions[2]]),
    await prices("600005.SH", 103),
  ];
  for (const ref of incompatible) {
    await expect(replayTspMarketEnvironment({ ...request, priceHistory: [{ tradeDate: target, refs: [ref] }] }))
      .rejects.toThrow("Incompatible market environment price archive");
  }
  await expect(replayTspMarketEnvironment({ ...request, benchmark: { ...request.benchmark, refs: [await benchmark("399001.SZ")] } }))
    .rejects.toThrow("unrelated market environment benchmark archive");
  await expect(replayTspMarketEnvironment({ ...request,
    benchmark: { ...request.benchmark, refs: [...request.benchmark.refs, await benchmark("000001.SH", 0)] } }))
    .rejects.toThrow("Duplicate market environment benchmark observation date");
  await expect(replayTspMarketEnvironment(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

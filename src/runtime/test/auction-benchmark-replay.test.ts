import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, type StoredMarketCrossSection } from "../../storage/index.ts";
import { collectAuctionBenchmark, replayTspAuctionBenchmark } from "../data/auction-benchmark.ts";

const tradeDate = "2026-08-14";
const calendar = { revision: "fixture-calendar", previousTradeDate: "2026-08-13", tradeDate, nextTradeDate: "2026-08-17" };
const symbol = "600519.SH";
const item = [{ thscode: symbol, ticker: "600519", name: "示例", auction_pct: 5, tags: ["高开"] }];
const response = (rows = item) => Response.json({
  code: 0, data: { date: tradeDate, date_ms: Date.parse(`${tradeDate}T00:00:00+08:00`),
    timestamp: Date.parse(`${tradeDate}T09:26:00+08:00`), item: rows },
});

function market(date: string, open: number, close: number): StoredMarketCrossSection {
  const base = { tradeDate: date, coverage: "unknown", observedAt: "2026-08-18T00:00:00Z" } as const;
  return {
    source: "tushare", market: "A", tradeDate: date,
    universe: { ...base, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "示例", industry: null, listedOn: null }] },
    bars: { ...base, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open, close, high: Math.max(open, close), low: Math.min(open, close),
        exRightsPreviousClose: null, changeCny: null, returnPct: null, volume: null, amount: null }] },
    basics: { ...base, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
}

let root: string;
let previousRoot: string | undefined;
let previousKey: string | undefined;
let previousBase: string | undefined;
beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  previousKey = process.env.WHYJ_QUANT_FUYAO_API_KEY;
  previousBase = process.env.FUYAO_BASE_URL;
  root = mkdtempSync(join(tmpdir(), "whyj-auction-replay-"));
  process.env.OHQUANT_DIR = root;
  process.env.WHYJ_QUANT_FUYAO_API_KEY = "fixture";
  process.env.FUYAO_BASE_URL = "http://127.0.0.1";
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  if (previousKey === undefined) delete process.env.WHYJ_QUANT_FUYAO_API_KEY;
  else process.env.WHYJ_QUANT_FUYAO_API_KEY = previousKey;
  if (previousBase === undefined) delete process.env.FUYAO_BASE_URL;
  else process.env.FUYAO_BASE_URL = previousBase;
  rmSync(root, { recursive: true, force: true });
});

test("collects the exact date and replays the fixed watchlist and price evidence offline", async () => {
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockRejectedValue(new Error("Provider closed"));
  try {
    const receipt = await collectAuctionBenchmark(tradeDate);
    expect(receipt).toMatchObject({ status: "archived", rowCount: 1, tradeDate, source: "fuyao" });
    expect(provider.mock.calls[0]?.[0]).toBe(`http://127.0.0.1/api/a-share/auction/short-term-benchmark?date=${tradeDate}`);
    const [before, current, next] = await Promise.all([
      archiveMarketCrossSection(market(calendar.previousTradeDate, 100, 100)),
      archiveMarketCrossSection(market(tradeDate, 105, 110)),
      archiveMarketCrossSection(market(calendar.nextTradeDate, 120, 121)),
    ]);
    delete process.env.WHYJ_QUANT_FUYAO_API_KEY;
    const replay = await replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar, marketRefs: [next, current, before] });
    expect(replay.input.auction).toMatchObject({ ref: receipt.ref, source: "fuyao", rows: [{ symbol, auctionReturnPct: 5, tags: ["高开"] }] });
    expect(replay.input.prices.map(entry => entry.ref)).toEqual([before, current, next]);
    expect(replay.metrics.producer).toBe("whyj");
    expect(replay.metrics.rows[0]).toMatchObject({ symbol, highOpenFlag: true });
    const row = replay.metrics.rows[0]!;
    expect(row.openToClose).toBeCloseTo(110 / 105 - 1, 12);
    expect(row.previousCloseToClose).toBeCloseTo(0.1, 12);
    expect(row.closeToNextClose).toBeCloseTo(0.1, 12);

    const missing = await replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar, marketRefs: [current] });
    expect(missing.metrics.rows[0]).toMatchObject({ previousCloseToClose: null, closeToNextClose: null, highOpenFlag: true });
    await expect(replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar, marketRefs: [current, current] }))
      .rejects.toThrow("Unexpected or duplicate auction price session");
    await expect(replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar: { ...calendar, nextTradeDate: "2026-08-18" }, marketRefs: [next] }))
      .rejects.toThrow("Unexpected or duplicate auction price session");
    await expect(replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar: { ...calendar, tradeDate: "2026-08-17" }, marketRefs: [] }))
      .rejects.toThrow("Auction observation date does not match replay calendar");
    writeFileSync(join(root, "data", "auction-benchmark-archives-v1", receipt.ref.revision + ".json"), "{}");
    await expect(replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar, marketRefs: [] }))
      .rejects.toThrow("Observation archive is damaged");
    expect(provider).toHaveBeenCalledTimes(1);
  } finally { provider.mockRestore(); }
});

test("keeps an observed empty list and gives no receipt for denial or cancellation", async () => {
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(response([]));
  try {
    await expect(collectAuctionBenchmark(tradeDate, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    await expect(collectAuctionBenchmark(tradeDate)).rejects.toMatchObject({ code: "provider-failure" });
    expect(existsSync(join(root, "data", "auction-benchmark-archives-v1"))).toBe(false);
    const receipt = await collectAuctionBenchmark(tradeDate);
    expect(receipt).toMatchObject({ status: "empty", rowCount: 0, ref: { kind: "auction-benchmark" } });
    expect((await replayTspAuctionBenchmark({ auctionRef: receipt.ref, calendar, marketRefs: [] })).metrics.rows).toEqual([]);
    expect(provider).toHaveBeenCalledTimes(2);
  } finally { provider.mockRestore(); }
});

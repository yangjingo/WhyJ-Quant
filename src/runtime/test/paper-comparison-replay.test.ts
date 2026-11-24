import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedEtfDailyBars, archiveValuationQuotePollCapture } from "../../storage/index.ts";
import { replayTspPaperComparison, type PaperComparisonReplayRequest } from "../data/paper-valuation-replay.ts";

test("compares two accounts offline from an exact ETF close and a fixed mixed quote archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-paper-comparison-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const noProvider = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  process.env.OHQUANT_DIR = root;
  try {
    const tradeDate = "2025-06-18", previous = "2025-06-17", currency = "CNY", etf = "510330.SH", stock = "600001.SH";
    const startedAt = tradeDate + "T02:00:00Z", receivedAt = tradeDate + "T02:00:02Z";
    const sourceTimestamp = Date.parse(startedAt);
    const daily = await archiveDatedEtfDailyBars({
      market: "A", assetType: "etf", symbol: etf, source: "tushare", endpoint: "fund_daily",
      requested: { start: previous, end: tradeDate }, observedAt: "2025-06-19T01:00:00Z",
      coverage: "unknown", adjustment: "none", interval: "1d", timeZone: "Asia/Shanghai",
      priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ tradeDate, sourceTimestamp: null, open: 4, high: 4.5, low: 3.9, close: 4.1, volume: 1, amount: null }],
    });
    const mixed = await archiveValuationQuotePollCapture({
      tradeDate, startedAt, observedAt: receivedAt, source: "tickflow", endpoint: "/v1/quotes", market: "A",
      coverage: "unknown", units: "unknown", requestedSymbols: [etf, stock],
      rows: [{ symbol: etf, timestamp: sourceTimestamp, receivedAt, lastPrice: 4.5, previousClose: 4, volume: 100, amount: null }],
    });
    const active = { accountId: "active", status: "active", cash: 300, initialCash: 800,
      positions: [
        { symbol: etf, assetType: "etf", quantity: 100, availableQuantity: 100, averageCost: 4, currency },
        { symbol: stock, assetType: "stock", quantity: 10, availableQuantity: 10, averageCost: 10, currency },
      ],
      fills: [], finalizedNav: [{ tradeDate: previous, currency, nav: 800 }, { tradeDate, currency, nav: 810 }],
      dailyRefs: [], etfDailyRefs: [daily], snapshotRef: mixed,
    } as const;
    const frozen = { accountId: "frozen", status: "frozen", cash: 800, initialCash: 800,
      positions: [], fills: [], finalizedNav: [], dailyRefs: [],
    } as const;
    const request = { tradeDate, currency, priceBasisConfirmation: "caller-confirmed-unadjusted-CNY",
      accounts: [active, frozen],
    } satisfies PaperComparisonReplayRequest;
    const report = await replayTspPaperComparison(request);
    expect(report).toMatchObject({
      producer: "whyj", formulaVersion: "tsp-paper-comparison-v1", accounts: [
        { accountId: "active",
          finalized: { equity: 810, coverage: { marketMarks: 1, costFallbackSymbols: [stock] } },
          snapshot: { equity: 850, coverage: { marketMarks: 1, costFallbackSymbols: [stock] } },
          nav: [{ tradeDate: previous, normalizedNav: 1 }, { tradeDate, normalizedNav: 1.0125 }],
        },
        { accountId: "frozen", finalized: { equity: 800 }, snapshot: null, nav: [] },
      ],
      inputs: [
        { accountId: "active", finalized: { etfDaily: [{ ref: daily, price: 4.1, source: "tushare" }] },
          snapshot: { quotePoll: { ref: mixed, source: "tickflow", quotes: [
            { symbol: etf, price: 4.5, sourceTimestamp, receivedAt },
            { symbol: stock, price: null, requested: true, sourceTimestamp: null, receivedAt: null },
          ] } },
        },
        { accountId: "frozen", snapshot: null },
      ],
    });
    expect(await replayTspPaperComparison(request)).toEqual(report);
    await expect(replayTspPaperComparison({ ...request, tradeDate: previous })).rejects.toThrow("Mismatched paper valuation quote-poll date");
    await expect(replayTspPaperComparison({ ...request, accounts: [active, active] })).rejects.toThrow("Invalid paper comparison account");
    await expect(replayTspPaperComparison(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(noProvider).not.toHaveBeenCalled();
  } finally {
    noProvider.mockRestore();
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

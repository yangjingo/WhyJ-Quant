import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveQuotePollCapture, archiveTradingDateObservations,
  type StoredQuotePollCapture, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspPaperValuation, type PaperValuationReplayRequest } from "../data/paper-valuation-replay.ts";

const tradeDate = "2026-01-07", previous = "2026-01-06";
const first = "600001.SH", second = "000001.SZ", etf = "510300.SH", unrequested = "600002.SH";
const scope = {
  accountId: "paper-fixture", currency: "CNY", tradeDate, cash: 1000, initialCash: 3000,
  priceBasisConfirmation: "caller-confirmed-unadjusted-CNY",
  positions: [
    { symbol: first, assetType: "stock", currency: "CNY", quantity: 100, averageCost: 10, availableQuantity: 40 },
    { symbol: second, assetType: "stock", currency: "CNY", quantity: 50, averageCost: 10, availableQuantity: 50 },
    { symbol: etf, assetType: "etf", currency: "CNY", quantity: 50, averageCost: 10, availableQuantity: 50 },
  ],
} satisfies Omit<PaperValuationReplayRequest, "basis" | "dailyRefs" | "quoteRef">;
let archiveRoot: string;
let previousRoot: string | undefined;
beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  archiveRoot = mkdtempSync(join(tmpdir(), "whyj-paper-valuation-replay-"));
  process.env.OHQUANT_DIR = archiveRoot;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(archiveRoot, { recursive: true, force: true });
});

function daily(symbol: string, date: string, price: number, forward = false) {
  return archiveTradingDateObservations([{
    schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate: date,
    sourceTimestamp: forward ? Date.parse(date + "T07:00:00Z") : null,
    requested: { startDate: previous, endDate: tradeDate }, market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
    source: forward ? "tickflow" : "tushare", endpoint: forward ? "/v1/klines" : "daily", observedAt: "2026-01-07T08:00:00Z",
    interval: "1d", adjustment: forward ? "forward" : "none", volumeUnit: forward ? "unknown" : "hand",
    amountUnit: forward ? "unknown" : "CNY-thousand", coverage: "unknown",
    values: { open: price, high: price, low: price, close: price, volume: 100, amount: null },
  } satisfies StoredTradingDateBarObservation]);
}

function quote(date: string) {
  const startedAt = date + "T02:00:00Z", observedAt = date + "T02:00:02Z";
  return archiveQuotePollCapture({
    tradeDate: date, startedAt, observedAt, source: "tickflow", endpoint: "/v1/quotes",
    market: "A", coverage: "unknown", units: "unknown", requestedSymbols: [second, first],
    rows: [second, first].map(symbol => ({ symbol, timestamp: Date.parse(startedAt), receivedAt: observedAt,
      lastPrice: symbol === first ? 13 : 0, previousClose: 10, volume: 100, amount: null })),
  } satisfies StoredQuotePollCapture);
}

test("finalized replay uses only exact-date raw stock closes and records missing or unreferenced marks", async () => {
  const [current, missing] = await Promise.all([daily(first, tradeDate, 12), daily(second, previous, 999)]);
  const input = { ...scope, basis: "finalized", dailyRefs: [current, missing] } satisfies PaperValuationReplayRequest;
  const noProvider = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider access"));
  try {
    const report = await replayTspPaperValuation(input);
    expect(report).toMatchObject({
      producer: "whyj", basis: "finalized", marketValue: 2200, equity: 3200, totalPnl: 200,
      coverage: { marketMarks: 1, costFallbackSymbols: [second, etf] },
      inputs: { priceBasisConfirmation: input.priceBasisConfirmation, daily: [
        { symbol: first, ref: current, source: "tushare", endpoint: "daily", observedAt: "2026-01-07T08:00:00Z", price: 12 },
        { symbol: second, ref: missing, source: "tushare", endpoint: "daily", price: null },
      ] },
    });
    expect(await replayTspPaperValuation(input)).toEqual(report);
    expect(await replayTspPaperValuation({ ...input, dailyRefs: [current] }))
      .toMatchObject({ inputs: { noDailyReferenceSymbols: [second] } });
    expect(noProvider).not.toHaveBeenCalled();
  } finally { noProvider.mockRestore(); }
});

test("snapshot replay preserves a zero quote, an unrequested stock and exact source timestamp", async () => {
  const ref = await quote(tradeDate);
  const result = await replayTspPaperValuation({
    ...scope, positions: [...scope.positions, { ...scope.positions[0]!, symbol: unrequested, quantity: 50 }],
    basis: "snapshot", quoteRef: ref,
  });
  expect(result).toMatchObject({
    basis: "snapshot", marketValue: 2800, totalPnl: 800,
    coverage: { marketMarks: 1, costFallbackSymbols: [second, etf, unrequested] },
    inputs: { quotePoll: { ref, source: "tickflow", endpoint: "/v1/quotes", quotes: [
      { symbol: second, requested: true, price: 0, sourceTimestamp: Date.parse(tradeDate + "T02:00:00Z") },
      { symbol: first, requested: true, price: 13, receivedAt: tradeDate + "T02:00:02Z" },
      { symbol: unrequested, requested: false, price: null, receivedAt: null },
    ] } },
  });
});

test("rejects mismatched price basis, ambiguous revisions, wrong date and cancellation", async () => {
  const [ref, adjusted, oldQuote] = await Promise.all([daily(first, tradeDate, 12), daily(first, tradeDate, 12, true), quote(previous)]);
  await expect(replayTspPaperValuation({ ...scope, basis: "finalized", dailyRefs: [adjusted] })).rejects.toThrow("daily archive");
  await expect(replayTspPaperValuation({ ...scope, basis: "finalized", dailyRefs: [ref, ref] })).rejects.toThrow("daily archive");
  await expect(replayTspPaperValuation({ ...scope, basis: "snapshot", quoteRef: oldQuote })).rejects.toThrow("quote-poll date");
  await expect(replayTspPaperValuation({ ...scope, currency: "USD", basis: "finalized", dailyRefs: [ref] })).rejects.toThrow("CNY");
  await expect(replayTspPaperValuation({ ...scope, basis: "finalized", dailyRefs: [ref] }, AbortSignal.abort()))
    .rejects.toMatchObject({ name: "AbortError" });
});

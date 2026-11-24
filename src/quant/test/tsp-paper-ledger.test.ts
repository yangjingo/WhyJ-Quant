import { expect, test } from "bun:test";
import { computeTspPaperValuation, replayTspPaperLedger, TSP_INDICATOR_REVISION,
  type TspPaperLedgerEntry, type TspPaperLedgerInput } from "../index.ts";

const buy = { kind: "fill", entryId: "a", tradeDate: "2026-01-05", symbol: "600001.SH", assetType: "stock",
  currency: "CNY", side: "buy", quantity: 10, price: 10, fee: 0.5 } as const satisfies TspPaperLedgerEntry;

const base: TspPaperLedgerInput = {
  accountId: "paper", currency: "CNY", initialCash: 500, asOf: "2026-01-06",
  entries: [
    buy,
    { ...buy, entryId: "b", tradeDate: "2026-01-06", quantity: 5, price: 12, fee: 0.5 },
    { kind: "corp_action", entryId: "c", tradeDate: "2026-01-06", symbol: buy.symbol, factor: 1.25 },
    { ...buy, entryId: "d", tradeDate: "2026-01-06", side: "sell", quantity: 7, price: 9, fee: 0.25 },
    { ...buy, entryId: "etf", tradeDate: "2026-01-06", symbol: "510300.SH", assetType: "etf", quantity: 2, price: 5, fee: 0 },
  ],
};

test("replays cash and fee-inclusive average cost across adjustments, lots and partial sales", () => {
  const report = replayTspPaperLedger(base);
  expect(report).toEqual({
    producer: "whyj", formulaVersion: "tsp-paper-ledger-v1", referenceRevision: TSP_INDICATOR_REVISION,
    accountId: "paper", currency: "CNY", asOf: "2026-01-06", initialCash: 500, cash: 391.75, entryCount: 5,
    positions: [
      { symbol: "510300.SH", assetType: "etf", currency: "CNY", quantity: 2, averageCost: 5, availableQuantity: 0 },
      { symbol: "600001.SH", assetType: "stock", currency: "CNY", quantity: 11.75, averageCost: 8.586666, availableQuantity: 5 },
    ],
    lots: [
      { symbol: "510300.SH", entries: [{ tradeDate: "2026-01-06", quantity: 2 }] },
      { symbol: "600001.SH", entries: [{ tradeDate: "2026-01-05", quantity: 5.5 }, { tradeDate: "2026-01-06", quantity: 6.25 }] },
    ],
  });
  const nextDay = replayTspPaperLedger({ ...base, asOf: "2026-01-07" });
  expect(nextDay.positions.map(position => position.availableQuantity)).toEqual([2, 11]);
  expect(computeTspPaperValuation({ accountId: report.accountId, tradeDate: report.asOf, currency: report.currency,
    cash: report.cash, initialCash: report.initialCash, positions: report.positions, basis: "finalized", marks: [] }))
    .toMatchObject({ coverage: { holdings: 2, marketMarks: 0 }, cash: 391.75 });
});

test("keeps zero and closed positions out of the valuation inputs and accepts an empty account", () => {
  const close = { ...buy, entryId: "close", tradeDate: "2026-01-06", side: "sell" } as const;
  expect(replayTspPaperLedger({ ...base, entries: [buy, close] })).toMatchObject({ cash: 499, positions: [], lots: [] });
  expect(replayTspPaperLedger({ ...base, initialCash: 0, entries: [] }))
    .toMatchObject({ cash: 0, entryCount: 0, positions: [], lots: [] });
});

test("keeps whole sellable shares within total holdings after independent split rounding", () => {
  const entries: TspPaperLedgerEntry[] = [
    { ...buy, entryId: "one", quantity: 1 }, { ...buy, entryId: "two", quantity: 1 }, { ...buy, entryId: "three", quantity: 1 },
    { kind: "corp_action", entryId: "split", tradeDate: base.asOf, symbol: buy.symbol, factor: 0.9999998 },
  ];
  const report = replayTspPaperLedger({ ...base, entries });
  expect(report.positions[0]).toMatchObject({ quantity: 2.999999, availableQuantity: 2 });
  expect(report.lots[0]?.entries.map(lot => lot.quantity)).toEqual([1, 1, 1]);
});

test("rejects unordered, unbound, duplicate and unmatched evidence", () => {
  for (const entries of [
    [buy, buy], [buy, { ...buy, entryId: "future", tradeDate: "2026-01-07" }],
    [buy, { ...buy, entryId: "old", tradeDate: "2026-01-04" }],
    [buy, { ...buy, entryId: "sell", side: "sell", quantity: 11 }],
    [{ ...buy, side: "sell" }], [{ ...buy, currency: "USD" }], [{ ...buy, quantity: 1.5 }],
    [buy, { kind: "corp_action", entryId: "split", tradeDate: buy.tradeDate, symbol: buy.symbol, factor: 0 }],
  ]) expect(() => replayTspPaperLedger({ ...base, entries: entries as TspPaperLedgerEntry[] })).toThrow();
});

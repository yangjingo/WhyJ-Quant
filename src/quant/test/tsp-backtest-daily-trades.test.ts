import { expect, test } from "bun:test";
import { computeTspBacktestDailyTrades, type TspBacktestDailyTradesInput } from "../index.ts";

const first = "2025-01-06", second = "2025-01-07", third = "2025-01-08";
const stock = "600000.SH", other = "000001.SZ";
const input: TspBacktestDailyTradesInput = { currency: "CNY", trades: [
  { symbol: stock, entryDate: first, exitDate: third, entryValue: 1200, exitValue: 1310, pnlAmount: 100 },
  { symbol: other, entryDate: second, exitDate: second, entryValue: 900, exitValue: 880, pnlAmount: -20 },
  { symbol: other, entryDate: first, exitDate: third, entryValue: 100, exitValue: 100, pnlAmount: 0 },
] };

test("replays TSP daily transaction amounts and retains input identities", () => {
  const report = computeTspBacktestDailyTrades(input);
  expect(report).toMatchObject({ producer: "whyj", formulaVersion: "tsp-backtest-daily-trades-v1", currency: "CNY", tradeCount: 3 });
  expect(report.rows).toEqual([
    { date: third, buys: [], buyCount: 0, sells: [{ symbol: stock, tradeIndex: 0 }, { symbol: other, tradeIndex: 2 }], sellCount: 2,
      buyValue: 0, sellValue: 1410, realizedPnl: 100, cumulativePnl: 80,
      observedBuyValues: 0, observedSellValues: 2, observedRealizedPnl: 2 },
    { date: second, buys: [{ symbol: other, tradeIndex: 1 }], buyCount: 1, sells: [{ symbol: other, tradeIndex: 1 }], sellCount: 1,
      buyValue: 900, sellValue: 880, realizedPnl: -20, cumulativePnl: -20,
      observedBuyValues: 1, observedSellValues: 1, observedRealizedPnl: 1 },
    { date: first, buys: [{ symbol: stock, tradeIndex: 0 }, { symbol: other, tradeIndex: 2 }], buyCount: 2, sells: [], sellCount: 0,
      buyValue: 1300, sellValue: 0, realizedPnl: 0, cumulativePnl: 0,
      observedBuyValues: 2, observedSellValues: 0, observedRealizedPnl: 0 },
  ]);
});

test("preserves independent money coverage and cannot invent an unknown cumulative PnL", () => {
  const result = computeTspBacktestDailyTrades({ ...input, trades: [
    { ...input.trades[0]!, entryValue: null },
    { ...input.trades[1]!, pnlAmount: null },
    { ...input.trades[2]!, exitValue: null },
  ] });
  expect(result.rows).toMatchObject([
    { date: third, buyValue: 0, sellValue: null, observedSellValues: 1, realizedPnl: 100, observedRealizedPnl: 2, cumulativePnl: null },
    { date: second, buyValue: 900, sellValue: 880, realizedPnl: null, observedRealizedPnl: 0, cumulativePnl: null },
    { date: first, buyValue: null, observedBuyValues: 1, sellValue: 0, realizedPnl: 0, cumulativePnl: 0 },
  ]);
});

test("accepts no trades and rejects invalid temporal, symbol and money evidence", () => {
  expect(computeTspBacktestDailyTrades({ ...input, trades: [] })).toMatchObject({ tradeCount: 0, rows: [] });
  for (const change of [{ exitDate: "2025-01-05" }, { entryDate: "2025-02-30" }, { symbol: "600000" },
    { entryValue: -1 }, { exitValue: Infinity }, { pnlAmount: NaN }]) {
    expect(() => computeTspBacktestDailyTrades({ ...input, trades: [{ ...input.trades[0]!, ...change }] }))
      .toThrow("Invalid daily backtest trade evidence");
  }
  const huge = { ...input.trades[0]!, entryValue: Number.MAX_VALUE };
  expect(() => computeTspBacktestDailyTrades({ ...input, trades: [huge, huge] })).toThrow("finite numeric range");
});

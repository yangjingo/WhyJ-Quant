import { describe, expect, it } from "bun:test";
import { computeTspPaperComparison, type TspPaperComparisonAccount, type TspPaperPriceMark } from "../index.ts";

const tradeDate = "2025-01-07", currency = "CNY", symbol = "510330.SH";
const finalizedMark: TspPaperPriceMark = {
  tradeDate, currency, symbol, basis: "finalized", adjustment: "none", source: "tickflow", revision: "daily-fixture", price: 4.5,
};
const snapshotMark: TspPaperPriceMark = { ...finalizedMark, basis: "snapshot", revision: "poll-fixture", price: 4.7 };
const active: TspPaperComparisonAccount = {
  accountId: "active", name: "Active account", status: "active", cash: 1_000, initialCash: 1_400,
  positions: [{ symbol, assetType: "etf", currency, quantity: 100, availableQuantity: 100, averageCost: 4 }],
  fills: [
    { fillId: "1", tradeDate: "2025-01-02", currency, symbol, side: "buy", quantity: 200, price: 4, fee: 2 },
    { fillId: "2", tradeDate: "2025-01-03", currency, symbol, side: "sell", quantity: 100, price: 5, fee: 1 },
  ],
  finalizedNav: [
    { tradeDate: "2025-01-02", currency, nav: 1_400 },
    { tradeDate: "2025-01-03", currency, nav: 1_500 },
    { tradeDate, currency, nav: 1_450 },
  ],
  finalizedMarks: [finalizedMark], snapshotMarks: [snapshotMark],
};
const frozen: TspPaperComparisonAccount = {
  accountId: "frozen", status: "frozen", cash: 2_000, initialCash: 2_000, positions: [], fills: [], finalizedMarks: [],
  finalizedNav: [{ tradeDate: "2025-01-06", currency, nav: 2_000 }],
};

describe("TSP simulated-account comparison", () => {
  it("compares dated valuations, completed trades and finalized series from each account's own anchor", () => {
    const result = computeTspPaperComparison({ tradeDate, currency, accounts: [active, frozen] });
    expect(result).toMatchObject({ producer: "whyj", formulaVersion: "tsp-paper-comparison-v1", tradeDate, currency, accounts: [
      {
        accountId: "active", name: "Active account", status: "active",
        finalized: { basis: "finalized", equity: 1_450, holdings: [{ mark: { source: "tickflow", revision: "daily-fixture" } }],
          finalizedNavReturn: { startDate: "2025-01-03", endDate: tradeDate, returnFraction: -0.0333 } },
        snapshot: { basis: "snapshot", equity: 1_470, holdings: [{ mark: { source: "tickflow", revision: "poll-fixture" } }] },
        statistics: { roundTripCount: 1, winRateFraction: 1, realizedPnl: 98, maxDrawdownFraction: 0.0333 },
        navAnchor: { tradeDate: "2025-01-02", nav: 1_400, divisor: 1_400 },
        nav: [
          { tradeDate: "2025-01-02", nav: 1_400, normalizedNav: 1 },
          { tradeDate: "2025-01-03", nav: 1_500, normalizedNav: 1.0714 },
          { tradeDate, nav: 1_450, normalizedNav: 1.0357 },
        ],
      },
      {
        accountId: "frozen", name: "frozen", status: "frozen", snapshot: null,
        finalized: { equity: 2_000, finalizedNavReturn: null },
        nav: [{ tradeDate: "2025-01-06", nav: 2_000, normalizedNav: 1 }],
      },
    ] });
  });

  it("keeps empty and zero-anchor histories distinguishable", () => {
    const empty = { ...frozen, accountId: "empty", finalizedNav: [] };
    const zero = { ...frozen, accountId: "zero", finalizedNav: [
      { tradeDate: "2025-01-06", currency, nav: 0 }, { tradeDate, currency, nav: 2_000 },
    ] };
    const result = computeTspPaperComparison({ tradeDate, currency, accounts: [empty, zero] });
    expect(result.accounts).toMatchObject([
      { navAnchor: null, nav: [], finalized: { latestFinalizedNavDate: null }, statistics: { maxDrawdownFraction: null } },
      { navAnchor: { tradeDate: "2025-01-06", nav: 0, divisor: 1 }, nav: [{ normalizedNav: 0 }, { normalizedNav: 2_000 }],
        finalized: { finalizedNavReturn: null } },
    ]);
  });

  it("rejects duplicate identities, future evidence, and incompatible valuation scope", () => {
    const compare = (...accounts: TspPaperComparisonAccount[]) => computeTspPaperComparison({ tradeDate, currency, accounts });
    expect(() => compare(active, active)).toThrow("Invalid paper comparison account");
    expect(() => compare({ ...frozen, snapshotMarks: [snapshotMark] })).toThrow("Invalid paper comparison account");
    expect(() => compare({ ...active, fills: [{ ...active.fills[0]!, tradeDate: "2025-01-08" }] })).toThrow("Invalid paper comparison account");
    expect(() => compare({ ...active, finalizedNav: [{ tradeDate: "2025-01-08", currency, nav: 10 }] })).toThrow("Invalid finalized");
    expect(() => compare({ ...active, finalizedMarks: [snapshotMark] })).toThrow("Invalid paper valuation price mark");
    expect(() => compare({ ...active, snapshotMarks: [{ ...snapshotMark, currency: "USD" }] })).toThrow("Invalid paper valuation price mark");
  });
});

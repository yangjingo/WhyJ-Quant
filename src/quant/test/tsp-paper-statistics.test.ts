import { expect, test } from "bun:test";
import { computeTspPaperStatistics, type TspPaperStatisticsInput } from "../index.ts";

const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12"];
const equity = "600001.SH", fund = "510300.SH";
const fixture: TspPaperStatisticsInput = {
  accountId: "local-paper",
  currency: "CNY",
  fills: ([
    ["buy-1", dates[0], equity, "buy", 100, 10, 5],
    ["buy-2", dates[1], equity, "buy", 200, 12, 5],
    ["sell-1", dates[4], equity, "sell", 150, 11, 6],
    ["sell-2", dates[5], equity, "sell", 150, 15, 8],
    ["buy-3", dates[5], fund, "buy", 20, 10, 0],
    ["sell-3", dates[5], fund, "sell", 20, 10, 0],
  ] as const).map(([fillId, tradeDate, symbol, side, quantity, price, fee]) => ({
    fillId, tradeDate: tradeDate!, symbol, side, quantity, price, fee, currency: "CNY",
  })),
  finalizedNav: [10000, 12500, -10, 10000, 11000].map((nav, index) => ({
    tradeDate: dates[index]!, nav, currency: "CNY",
  })),
};

test("matches the pinned TSP partial FIFO, fee allocation and finalized NAV statistics", () => {
  const result = computeTspPaperStatistics(fixture);
  expect(result).toMatchObject({
    producer: "whyj", formulaVersion: "tsp-paper-statistics-v1", accountId: "local-paper", currency: "CNY",
    summary: {
      roundTripCount: 4, winningRoundTrips: 2, winRateFraction: 0.5, profitLossRatio: 9.94,
      averageHoldingDays: 3.2, realizedPnl: 476, maxDrawdownFraction: 0.2,
      fillCount: 6, navRows: 5, positiveNavRows: 4,
    },
  });
  expect(result.roundTrips.map(({ buyFillId, sellFillId, quantity, pnl, holdingDays }) =>
    [buyFillId, sellFillId, quantity, pnl, holdingDays])).toEqual([
    ["buy-1", "sell-1", 100, 91, 4], ["buy-2", "sell-1", 50, -53.25, 3],
    ["buy-2", "sell-2", 150, 438.25, 6], ["buy-3", "sell-3", 20, 0, 0],
  ]);
  expect(result.roundTrips.map(row => row.pnlFraction)).toEqual([0.0905, -0.0886, 0.243, 0]);
  expect(computeTspPaperStatistics(fixture)).toEqual(result);
});

test("distinguishes no positive NAV from no measured drawdown and no matched trips", () => {
  const empty = computeTspPaperStatistics({ ...fixture, fills: [], finalizedNav: [] });
  expect(empty.summary).toMatchObject({
    fillCount: 0, navRows: 0, positiveNavRows: 0, roundTripCount: 0, winRateFraction: 0,
    averageHoldingDays: 0, profitLossRatio: null, realizedPnl: 0, maxDrawdownFraction: null,
  });
  const positive = (nav: readonly number[]) => computeTspPaperStatistics({
    ...fixture, fills: fixture.fills.slice(0, 1), finalizedNav: nav.map((value, index) => ({
      tradeDate: dates[index]!, nav: value, currency: "CNY",
    })),
  }).summary;
  expect(positive([0, -100])).toMatchObject({ roundTripCount: 0, positiveNavRows: 0, maxDrawdownFraction: null });
  expect(positive([0, 100])).toMatchObject({ positiveNavRows: 1, maxDrawdownFraction: 0 });
  expect(positive([100, 110])).toMatchObject({ positiveNavRows: 2, maxDrawdownFraction: 0 });
});

test("rejects duplicate fills, unmatched sales, mismatched currencies and ambiguous order", () => {
  const [first, second, third] = fixture.fills;
  expect(() => computeTspPaperStatistics({ ...fixture, fills: [first!, first!] })).toThrow("Invalid or out-of-order");
  expect(() => computeTspPaperStatistics({ ...fixture, fills: [first!, third!] })).toThrow("no matching earlier buy quantity");
  expect(() => computeTspPaperStatistics({ ...fixture, fills: [second!, first!] })).toThrow("out-of-order");
  expect(() => computeTspPaperStatistics({ ...fixture, fills: [{ ...first!, currency: "USD" }] })).toThrow("paper fill");
  expect(() => computeTspPaperStatistics({ ...fixture, fills: [{ ...first!, quantity: 0.5 }] })).toThrow("paper fill");
  expect(() => computeTspPaperStatistics({ ...fixture, finalizedNav: fixture.finalizedNav.toReversed() })).toThrow("finalized paper NAV");
  expect(() => computeTspPaperStatistics({ ...fixture, finalizedNav: [
    fixture.finalizedNav[0]!, { ...fixture.finalizedNav[0]!, nav: 1 },
  ] })).toThrow("finalized paper NAV");
  expect(() => computeTspPaperStatistics({ ...fixture, finalizedNav: [{ ...fixture.finalizedNav[0]!, currency: "USD" }] }))
    .toThrow("finalized paper NAV");
});

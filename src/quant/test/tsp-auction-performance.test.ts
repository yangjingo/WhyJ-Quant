import { expect, test } from "bun:test";
import { computeTspAuctionPerformance, TSP_INDICATOR_REVISION, type TspAuctionPerformanceInput } from "../index.ts";

const calendar = { revision: "fixture-calendar", previousTradeDate: "2026-08-26", tradeDate: "2026-08-27", nextTradeDate: "2026-08-28" };
const first = "600519.SH";
const second = "000858.SZ";
const price = (symbol: string, tradeDate: string, open: number | null, close: number | null) => ({ symbol, tradeDate, open, close });
// The pinned TSP auction benchmark regression fixture uses these close and open inputs.
const fixture: TspAuctionPerformanceInput = {
  calendar,
  priceBasis: "none",
  watchlist: [{ symbol: first, auctionReturnPct: 5 }, { symbol: second, auctionReturnPct: -2.5 }],
  prices: [
    price(second, calendar.tradeDate, 132, 130),
    price(first, calendar.previousTradeDate, null, 1700),
    price(first, calendar.nextTradeDate, null, 1768.68),
    price(first, calendar.tradeDate, 1717, 1734),
    price(second, calendar.nextTradeDate, null, 133),
  ],
};

test("calculates the pinned session price changes and inclusive five-point marker in watchlist order", () => {
  const result = computeTspAuctionPerformance(fixture);
  expect(result).toMatchObject({
    producer: "whyj", priceBasis: "none", returnUnit: "fraction", calendar, highOpenThresholdPct: 5,
    formula: { id: "tsp_auction_performance", version: 1, revision: TSP_INDICATOR_REVISION },
  });
  expect(result.rows.map(row => row.symbol)).toEqual([first, second]);
  expect(result.rows[0]!.openToClose).toBeCloseTo(1734 / 1717 - 1, 12);
  expect(result.rows[0]!.previousCloseToClose).toBeCloseTo(1734 / 1700 - 1, 12);
  expect(result.rows[0]!.closeToNextClose).toBeCloseTo(1768.68 / 1734 - 1, 12);
  expect(result.rows[0]!.highOpenFlag).toBe(true);
  expect(result.rows[1]!.openToClose).toBeCloseTo(130 / 132 - 1, 12);
  expect(result.rows[1]!.previousCloseToClose).toBeNull();
  expect(result.rows[1]!.closeToNextClose).toBeCloseTo(133 / 130 - 1, 12);
  expect(result.rows[1]!.highOpenFlag).toBe(false);
});

test("keeps individual missing inputs and valid zero changes explicit", () => {
  const result = computeTspAuctionPerformance({
    ...fixture, calendar: { ...calendar, nextTradeDate: null },
    watchlist: [{ symbol: first, auctionReturnPct: null }, { symbol: second, auctionReturnPct: 4.999 }],
    prices: [price(first, calendar.previousTradeDate, null, 12), price(first, calendar.tradeDate, null, 12)],
  });
  expect(result.rows).toEqual([
    { symbol: first, openToClose: null, previousCloseToClose: 0, closeToNextClose: null, highOpenFlag: null },
    { symbol: second, openToClose: null, previousCloseToClose: null, closeToNextClose: null, highOpenFlag: false },
  ]);
  expect(computeTspAuctionPerformance({ ...fixture, prices: [], watchlist: [] }).rows).toEqual([]);
});

test("rejects duplicate identities, unsupported basis and non-neighbor prices", () => {
  expect(() => computeTspAuctionPerformance({ ...fixture, watchlist: [fixture.watchlist[0]!, fixture.watchlist[0]!] }))
    .toThrow("Invalid or duplicate auction watchlist row");
  expect(() => computeTspAuctionPerformance({ ...fixture, prices: [...fixture.prices, fixture.prices[0]!] }))
    .toThrow("Invalid or duplicate auction price evidence");
  expect(() => computeTspAuctionPerformance({ ...fixture, prices: [price(first, "2026-08-31", 1, 1)] }))
    .toThrow("Invalid or duplicate auction price evidence");
  expect(() => computeTspAuctionPerformance({ ...fixture, prices: [price(first, calendar.tradeDate, 0, 10)] }))
    .toThrow("Invalid or duplicate auction price evidence");
  expect(() => computeTspAuctionPerformance({ ...fixture, priceBasis: "forward" as "none" })).toThrow("requires unadjusted prices");
  expect(() => computeTspAuctionPerformance({ ...fixture, calendar: { ...calendar, nextTradeDate: calendar.tradeDate } }))
    .toThrow("Invalid auction session calendar");
});

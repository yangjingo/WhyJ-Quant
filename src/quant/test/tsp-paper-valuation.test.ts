import { expect, test } from "bun:test";
import { computeTspPaperValuation, type TspPaperValuationInput } from "../index.ts";

const fixture: TspPaperValuationInput = {
  accountId: "paper-fixture", tradeDate: "2026-01-06", currency: "CNY", cash: 800, initialCash: 3000, basis: "snapshot",
  positions: [
    { symbol: "600001.SH", assetType: "stock", currency: "CNY", quantity: 100, averageCost: 10, availableQuantity: 40 },
    { symbol: "510300.SH", assetType: "etf", currency: "CNY", quantity: 50, averageCost: 20, availableQuantity: 25 },
    { symbol: "600002.SH", assetType: "stock", currency: "CNY", quantity: 0, averageCost: 0, availableQuantity: 0 },
  ],
  marks: [{ symbol: "600001.SH", currency: "CNY", tradeDate: "2026-01-06", basis: "snapshot", adjustment: "none",
    source: "tickflow", revision: "snapshot-rev", price: 11.23456 }],
  finalizedNav: [
    { tradeDate: "2025-12-31", currency: "CNY", nav: 1050 },
    { tradeDate: "2026-01-02", currency: "CNY", nav: 1000 },
    { tradeDate: "2026-01-05", currency: "CNY", nav: 1250 },
  ],
};

test("matches the pinned marked and fallback holdings and dates the independent NAV return", () => {
  const result = computeTspPaperValuation(fixture);
  expect(result).toMatchObject({
    producer: "whyj", formulaVersion: "tsp-paper-valuation-v1", accountId: "paper-fixture", basis: "snapshot",
    cash: 800, marketValue: 2123.46, equity: 2923.46, totalPnl: -76.54, totalPnlFraction: -0.0255,
    holdings: [
      { symbol: "510300.SH", availableQuantity: 25, lastPrice: 20, marketValue: 1000, unrealizedPnl: 0,
        unrealizedPnlFraction: 0, priceBasis: "average-cost", mark: null },
      { symbol: "600001.SH", availableQuantity: 40, lastPrice: 11.2346, marketValue: 1123.46, unrealizedPnl: 123.46,
        unrealizedPnlFraction: 0.1235, priceBasis: "market-mark", mark: {
          source: "tickflow", revision: "snapshot-rev", tradeDate: "2026-01-06", currency: "CNY", adjustment: "none",
          price: 11.23456, basis: "snapshot",
        } },
    ],
    coverage: { holdings: 2, marketMarks: 1, costFallbackSymbols: ["510300.SH"] },
    finalizedNavRows: 3, latestFinalizedNavDate: "2026-01-05",
    finalizedNavReturn: { startDate: "2026-01-02", endDate: "2026-01-05", returnFraction: 0.25 },
  });
  expect(computeTspPaperValuation({ ...fixture, positions: fixture.positions.toReversed() })).toEqual(result);
});

test("keeps explicit finalized coverage and absence of an eligible return denominator", () => {
  const baseline = computeTspPaperValuation({
    ...fixture, initialCash: 0, basis: "finalized", marks: [{ ...fixture.marks[0]!, basis: "finalized" }],
    finalizedNav: [{ tradeDate: "2026-01-06", currency: "CNY", nav: 800 }],
  });
  expect(baseline).toMatchObject({
    basis: "finalized", totalPnlFraction: null, finalizedNavRows: 1, finalizedNavReturn: null,
    latestFinalizedNavDate: "2026-01-06",
  });
  expect(computeTspPaperValuation({ ...fixture, marks: [],
    finalizedNav: [{ tradeDate: "2026-01-05", currency: "CNY", nav: 0 }, { tradeDate: "2026-01-06", currency: "CNY", nav: 800 }],
  })).toMatchObject({ coverage: { marketMarks: 0, costFallbackSymbols: ["510300.SH", "600001.SH"] }, finalizedNavReturn: null });
});

test("rejects ambiguous holdings and wrong-date, duplicate or mixed price and NAV evidence", () => {
  const mark = fixture.marks[0]!;
  expect(() => computeTspPaperValuation({ ...fixture, marks: [mark, mark] })).toThrow("price mark");
  expect(() => computeTspPaperValuation({ ...fixture, marks: [{ ...mark, tradeDate: "2026-01-05" }] })).toThrow("price mark");
  expect(() => computeTspPaperValuation({ ...fixture, marks: [{ ...mark, basis: "finalized" }] })).toThrow("price mark");
  expect(() => computeTspPaperValuation({ ...fixture, marks: [{ ...mark, currency: "USD" }] })).toThrow("price mark");
  expect(() => computeTspPaperValuation({ ...fixture, marks: [{ ...mark, revision: "" }] })).toThrow("price mark");
  expect(() => computeTspPaperValuation({ ...fixture, positions: [...fixture.positions, fixture.positions[0]!] })).toThrow("position");
  expect(() => computeTspPaperValuation({ ...fixture, positions: [{ ...fixture.positions[0]!, availableQuantity: 101 }] })).toThrow("position");
  expect(() => computeTspPaperValuation({ ...fixture, finalizedNav: [{ tradeDate: "2026-01-07", nav: 1000, currency: "CNY" }] }))
    .toThrow("NAV");
});

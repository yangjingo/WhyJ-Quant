import { expect, test } from "bun:test";
import { computeTspBacktestFactorAttribution, type TspBacktestFactorAttributionInput } from "../index.ts";

const signal = "2025-01-06", fill = "2025-01-07";
const stock = "000001.SZ", other = "600000.SH";
const input: TspBacktestFactorAttributionInput = {
  factors: ["rs", "volume", "missing"],
  snapshots: [
    { symbol: stock, tradeDate: signal, values: { rs: 0.12345656, volume: 0, missing: null } },
    { symbol: stock, tradeDate: fill, values: { rs: 1, volume: 9 } },
    { symbol: other, tradeDate: signal, values: { rs: 0.5, volume: null } },
    { symbol: other, tradeDate: fill, values: { rs: 1.5 } },
  ],
  trades: [
    { symbol: stock, entrySignalDate: signal, entryDate: fill, pnlFraction: 0.1 },
    { symbol: stock, entrySignalDate: signal, entryDate: fill, pnlFraction: 0.05 },
    { symbol: other, entrySignalDate: signal, entryDate: fill, pnlFraction: 0.01 },
    { symbol: stock, entryDate: fill, pnlFraction: 0 },
    { symbol: other, entrySignalDate: null, entryDate: fill, pnlFraction: -0.02 },
    { symbol: other, entryDate: "2025-01-08", pnlFraction: -0.1 },
    { symbol: other, entryDate: null, pnlFraction: 0.2 },
  ],
};

test("groups exact entry signal dates by realized outcome and preserves coverage", () => {
  const result = computeTspBacktestFactorAttribution(input);
  expect(result).toMatchObject({ producer: "whyj", formulaVersion: "tsp-backtest-entry-factor-attribution-v1", status: "available",
    coverage: { trades: 7, matchedTrades: 5, undatedTrades: 1, winTrades: 3, nonWinTrades: 3 },
    factors: [
      { factor: "rs", winMean: 0.248971, nonWinMean: 1.25, winSamples: 3, nonWinSamples: 2 },
      { factor: "volume", winMean: 0, nonWinMean: 9, winSamples: 2, nonWinSamples: 1, difference: -9 },
    ],
  });
  expect(result.factors[0]?.difference).toBeCloseTo(-1.001029, 12);
});

test("keeps missing trade-factor pairings and one-sided evidence explicit", () => {
  expect(computeTspBacktestFactorAttribution({ ...input, snapshots: [] })).toMatchObject({
    status: "unavailable", coverage: { matchedTrades: 0, winTrades: 3, nonWinTrades: 3 }, factors: [],
  });
  expect(computeTspBacktestFactorAttribution({ ...input, trades: [], snapshots: [] })).toMatchObject({
    status: "unavailable", coverage: { trades: 0, matchedTrades: 0, undatedTrades: 0, winTrades: 0, nonWinTrades: 0 },
  });
  expect(computeTspBacktestFactorAttribution({ ...input, snapshots: [input.snapshots[1]!], trades: [
    { symbol: stock, entryDate: fill, entrySignalDate: signal, pnlFraction: 0.01 },
    { symbol: stock, entryDate: fill, pnlFraction: 0 },
  ] })).toMatchObject({ status: "available", coverage: { matchedTrades: 1 }, factors: [
    { factor: "rs", winMean: null, nonWinMean: 1, winSamples: 0, nonWinSamples: 1, difference: null },
    { factor: "volume", winMean: null, nonWinMean: 9, winSamples: 0, nonWinSamples: 1, difference: null },
  ] });
});

test("rejects duplicate snapshots, unknown factors and malformed trade evidence", () => {
  expect(() => computeTspBacktestFactorAttribution({ ...input, snapshots: [...input.snapshots, input.snapshots[0]!] }))
    .toThrow("Duplicate signal-day factor snapshot");
  expect(() => computeTspBacktestFactorAttribution({ ...input, factors: ["rs", "rs"] }))
    .toThrow("Duplicate backtest attribution factor");
  const invalidValues: Readonly<Record<string, number | null>>[] = [{ unknown: 1 }, { rs: Infinity }];
  for (const values of invalidValues) {
    expect(() => computeTspBacktestFactorAttribution({ ...input, snapshots: [{ symbol: stock, tradeDate: signal, values }] }))
      .toThrow("Invalid signal-day factor snapshot");
  }
  for (const replacement of [
    { symbol: "000001" }, { entrySignalDate: fill, entryDate: signal }, { entrySignalDate: "2025-02-30" },
    { pnlFraction: NaN }, { pnlFraction: -1.1 },
  ]) expect(() => computeTspBacktestFactorAttribution({ ...input, trades: [{ ...input.trades[0]!, ...replacement }] }))
    .toThrow("Invalid backtest attribution trade");
});

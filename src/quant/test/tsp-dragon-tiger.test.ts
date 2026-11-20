import { expect, test } from "bun:test";
import { computeTspDragonTiger, TSP_INDICATOR_REVISION, type TspDragonTigerInput } from "../index.ts";

const sameStock = { symbol: "002407.SZ", ticker: "002407", name: "Fixture" };
const stock = (netValueCny: number | null, rangeDays: 1 | 3 | null = 1) => ({
  ...sameStock, rangeDays, netValueCny, changeFraction: 0.02,
});
const institution = (institutionalNetValueCny: number | null) => ({ ...sameStock, rangeDays: 1 as const, institutionalNetValueCny });
const input: TspDragonTigerInput = {
  tradeDate: "2026-07-01",
  all: [stock(20), stock(30, 3), stock(20, 3), stock(-40), stock(-45, 3), stock(0), stock(null, null),
    stock(19), stock(18), stock(17), stock(16)],
  institutions: [institution(null), institution(-10), institution(0), institution(20)],
  hotMoney: [{ name: "Missing", netValueCny: null }, { name: "First", netValueCny: 12 }, { name: "Second", netValueCny: 12 },
    { name: "Flat", netValueCny: 0 }, { name: null, netValueCny: -3 }],
};

test("reproduces the four recap rankings while keeping distinct provider records", () => {
  const result = computeTspDragonTiger(input);
  expect(result).toMatchObject({
    producer: "whyj", amountUnit: "CNY", tradeDate: input.tradeDate,
    formula: { id: "tsp_dragon_tiger", version: 1, revision: TSP_INDICATOR_REVISION },
  });
  const all = result.all!;
  expect(all.comparableCount).toBe(10);
  expect(all.leadingNetBuys.map(({ sourceRow, symbol, rangeDays, netValueCny }) => [sourceRow, symbol, rangeDays, netValueCny]))
    .toEqual([[1, sameStock.symbol, 3, 30], [0, sameStock.symbol, 1, 20], [2, sameStock.symbol, 3, 20],
      [7, sameStock.symbol, 1, 19], [8, sameStock.symbol, 1, 18]]);
  expect(all.leadingNetBuys[0]?.changeFraction).toBe(0.02);
  expect(all.leadingNetSells.map(({ sourceRow, netValueCny }) => [sourceRow, netValueCny])).toEqual([[4, -45], [3, -40]]);
  expect(result.institutions?.leaders.map(({ sourceRow, netValueCny }) => [sourceRow, netValueCny])).toEqual([[3, 20], [2, 0], [1, -10]]);
  expect(result.hotMoney?.leaders.map(({ name, netValueCny }) => [name, netValueCny])).toEqual([["First", 12], ["Second", 12], ["Flat", 0], [null, -3]]);
});

test("distinguishes unavailable boards from observed empty or numerically missing boards", () => {
  expect(computeTspDragonTiger({ ...input, all: null, institutions: [], hotMoney: [{ name: null, netValueCny: null }] }))
    .toMatchObject({ all: null, institutions: { comparableCount: 0, leaders: [] }, hotMoney: { comparableCount: 0, leaders: [] } });
  expect(computeTspDragonTiger({ ...input, all: [] }).all).toEqual({ comparableCount: 0, leadingNetBuys: [], leadingNetSells: [] });
});

test("rejects impossible dates and nonfinite net amounts", () => {
  expect(() => computeTspDragonTiger({ ...input, tradeDate: "2026-02-30" })).toThrow("Invalid dragon-tiger trade date");
  expect(() => computeTspDragonTiger({ ...input, all: [stock(NaN)] })).toThrow("Invalid dragon-tiger net amount");
  expect(() => computeTspDragonTiger({ ...input, institutions: [institution(Infinity)] })).toThrow("Invalid dragon-tiger net amount");
});

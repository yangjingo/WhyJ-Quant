import { expect, test } from "bun:test";
import { computeTspListLiquidity, TSP_LIST_LIQUIDITY_FORMULA_VERSION } from "../index.ts";

const input = { rawCloseCny: 10.5, volumeShares: 75_000, circulatingShares: 2_500_000 };

test("calculates list float value in CNY and turnover in percentage points", () => {
  expect(TSP_LIST_LIQUIDITY_FORMULA_VERSION).toBe(1);
  expect(computeTspListLiquidity(input)).toEqual({ floatValueCny: 26_250_000, turnoverPct: 3 });
  expect(computeTspListLiquidity({ ...input, volumeShares: 0 })).toEqual({ floatValueCny: 26_250_000, turnoverPct: 0 });
});

test("preserves the independent availability of price, volume and circulating shares", () => {
  expect(computeTspListLiquidity({ ...input, volumeShares: null })).toEqual({ floatValueCny: 26_250_000, turnoverPct: null });
  expect(computeTspListLiquidity({ ...input, rawCloseCny: null })).toEqual({ floatValueCny: null, turnoverPct: 3 });
  for (const circulatingShares of [null, 0]) {
    expect(computeTspListLiquidity({ ...input, circulatingShares })).toEqual({ floatValueCny: null, turnoverPct: null });
  }
});

test("rejects invalid observations and arithmetic overflow", () => {
  for (const bad of [{ rawCloseCny: 0 }, { rawCloseCny: NaN }, { volumeShares: -1 }, { circulatingShares: Infinity }]) {
    expect(() => computeTspListLiquidity({ ...input, ...bad })).toThrow("Invalid TSP list liquidity inputs");
  }
  expect(() => computeTspListLiquidity({ ...input, rawCloseCny: Number.MAX_VALUE })).toThrow("result overflow");
});

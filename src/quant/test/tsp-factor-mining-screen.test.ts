import { expect, test } from "bun:test";
import { computeTspFactorMiningScreen, TSP_INDICATOR_REVISION, type TspFactorMiningScreenInput } from "../index.ts";

const factorIds = ["base", "mirror", "sparse", "constant", "never"];
const frames = [
  { base: [1, 2, 3, 4, 5], sparse: [null, 4, 2, null, 3], outcomes: [0.01, 0.02, 0.03, 0.04, 0.05] },
  { base: [5, 4, 3, 2, 1], sparse: [null, null, null, null, null], outcomes: [0.01, 0.03, 0.02, 0.04, 0.05] },
  { base: [1, 2, 3, 4, 5], sparse: [1, 1, 0, 2, 3], outcomes: [0.01, 0.02, null, 0.04, 0.05] },
];
const input: TspFactorMiningScreenInput = { factorIds, correlationThreshold: 1,
  rows: frames.flatMap(({ base, sparse, outcomes }, day) => base.map((value, i) => ({
    tradeDate: `2025-01-0${day + 2}`, symbol: `60000${i + 1}.SH`,
    values: [value, -value, sparse[i]!, 5, null], forwardReturnFraction: outcomes[i]!,
  }))),
};

test("matches the pinned training metric and daily pairwise correlation including missing pairs", () => {
  const result = computeTspFactorMiningScreen(input);
  // Golden outputs from mining.py and mining_runtime.py f9cb383c with Polars 1.44.1.
  expect(result).toMatchObject({ producer: "whyj", formula: {
    id: "tsp_factor_mining_screen", version: 1, revision: TSP_INDICATOR_REVISION,
  }, sessions: ["2025-01-02", "2025-01-03", "2025-01-04"], inputRows: 15, factorIds });
  expect(result.metrics).toMatchObject([
    { factorId: "base", compositeScore: 0.20468881, ir: 0.40937761, coverage: 1, turnover: 1, rankIc: 0.36666667,
      observedFactorRows: 15, eligibleRows: 14, observedIcDays: 3 },
    { factorId: "mirror", compositeScore: 0.20468881, ir: 0.40937761, coverage: 1, turnover: 1, rankIc: -0.36666667 },
    { factorId: "sparse", compositeScore: 0.08259147, ir: 0.309718, coverage: 0.53333333, turnover: 1, rankIc: 0.22434165,
      observedFactorRows: 8, eligibleRows: 7, observedIcDays: 2 },
    { factorId: "constant", compositeScore: 0, ir: 0, coverage: 1, turnover: 0, rankIc: 0, observedIcDays: 0 },
    { factorId: "never", compositeScore: 0, ir: 0, coverage: 0, turnover: 1, rankIc: 0, observedIcDays: 0 },
  ]);
  const { matrix, pairCounts } = result.correlation;
  expect(matrix[0]?.[1]).toBe(-1);
  expect(matrix[0]?.[2]).toBeCloseTo(0.08344296442767513, 13);
  expect(matrix[1]?.[2]).toBeCloseTo(-0.08344296442767513, 13);
  expect(matrix[3]).toEqual([null, null, null, 1, null]);
  expect(matrix[4]).toEqual([null, null, null, null, null]);
  expect(pairCounts).toEqual([[3, 3, 2, 0, 0], [3, 3, 2, 0, 0], [2, 2, 2, 0, 0], [0, 0, 0, 3, 0], [0, 0, 0, 0, 0]]);
  expect(result.selected).toEqual(["base", "sparse", "constant", "never"]);
  expect(result.excluded).toEqual([{ factorId: "mirror", reason: "correlation_threshold", representative: "base", rho: -1 }]);
  expect(computeTspFactorMiningScreen({ ...input, rows: input.rows.toReversed() })).toEqual(result);
});

test("retains an observed zero average correlation separately from unavailable pairs", () => {
  const rows = ["2025-01-02", "2025-01-03"].flatMap((tradeDate, date) => [1, 2].map((value, i) => ({
    tradeDate, symbol: `60000${i + 1}.SH`, values: [value, date ? -value : value, null], forwardReturnFraction: null,
  })));
  const result = computeTspFactorMiningScreen({ factorIds: ["a", "b", "c"], rows, correlationThreshold: 0.9 });
  expect(result.correlation.matrix).toEqual([[1, 0, null], [0, 1, null], [null, null, null]]);
  expect(result.correlation.pairCounts).toEqual([[2, 2, 0], [2, 2, 0], [0, 0, 0]]);
  expect(result.excluded).toEqual([]);
});

test("rejects duplicate identities, malformed evidence and invalid thresholds", () => {
  const first = input.rows[0]!;
  expect(() => computeTspFactorMiningScreen({ ...input, rows: [...input.rows, first] })).toThrow("Duplicate");
  expect(() => computeTspFactorMiningScreen({ ...input, factorIds: ["one", "one"] })).toThrow("scope");
  expect(() => computeTspFactorMiningScreen({ ...input, correlationThreshold: 0 })).toThrow("scope");
  expect(() => computeTspFactorMiningScreen({ ...input, correlationThreshold: Infinity })).toThrow("scope");
  for (const row of [
    { ...first, tradeDate: "2025-02-30" },
    { ...first, values: [1] },
    { ...first, values: [1, 2, NaN, 3, null] },
    { ...first, forwardReturnFraction: -1.1 },
  ]) expect(() => computeTspFactorMiningScreen({ ...input, rows: [row] })).toThrow("panel row");
});

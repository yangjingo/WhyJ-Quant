import { expect, test } from "bun:test";
import { computeTspCompositeFactor, TSP_COMPOSITE_FACTOR_FORMULA_VERSION, TSP_INDICATOR_REVISION,
  type TspCompositeFactorInput } from "../index.ts";

const firstDate = "2026-05-27";
const secondDate = "2026-05-28";
const members = [{ factorId: "x", weight: 2 }, { factorId: "y", weight: -0.5 }];
const rows = [
  { symbol: "A", tradeDate: firstDate, values: { x: 0, y: 1 } },
  { symbol: "B", tradeDate: firstDate, values: { x: 2, y: null } },
  { symbol: "C", tradeDate: firstDate, values: { x: 2, y: 5 } },
  { symbol: "D", tradeDate: firstDate, values: { x: 4, y: 9 } },
  { symbol: "A", tradeDate: secondDate, values: { x: 8, y: 3 } },
  { symbol: "B", tradeDate: secondDate, values: { x: 8, y: 6 } },
];
const input: TspCompositeFactorInput = { members, rows };

test("matches the pinned materialized composite with signed weights and per-member sample statistics", () => {
  const result = computeTspCompositeFactor({ members, rows: rows.toReversed() });
  expect(result).toMatchObject({
    producer: "whyj", formulaVersion: TSP_COMPOSITE_FACTOR_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION, members,
  });
  expect(result.rows.map(({ tradeDate, symbol }) => ({ tradeDate, symbol })))
    .toEqual(rows.map(({ tradeDate, symbol }) => ({ tradeDate, symbol })));
  expect(result.rows[0]!.score).toBeCloseTo(-Math.sqrt(6) + 0.5, 14);
  expect(result.rows[2]!.score).toBe(0);
  expect(result.rows[3]!.score).toBeCloseTo(Math.sqrt(6) - 0.5, 14);
  expect([result.rows[1]!.score, result.rows[4]!.score, result.rows[5]!.score]).toEqual([null, null, null]);
  expect(computeTspCompositeFactor({ ...input, rows: rows.slice(0, 1) }).rows).toEqual([
    { tradeDate: firstDate, symbol: "A", score: null },
  ]);
  expect(computeTspCompositeFactor({ ...input, rows: [] }).rows).toEqual([]);
});

test("rejects incompatible dimensions, duplicate identities and nonfinite inputs", () => {
  const row = rows[0]!;
  for (const invalid of [[members[0]!], [members[0]!, members[0]!],
    [members[0]!, { factorId: "y", weight: 0 }],
    [members[0]!, { factorId: "y", weight: Infinity }],
    [members[0]!, { factorId: "not an id", weight: 1 }]]) {
    expect(() => computeTspCompositeFactor({ ...input, members: invalid })).toThrow();
  }
  for (const invalid of [[row, row], [{ ...row, tradeDate: "2026-02-30" }],
    [{ ...row, values: { x: 1 } }], [{ ...row, values: { x: 1, y: 2, z: 3 } }],
    [{ ...row, values: { x: Number.NaN, y: 2 } }]]) {
    expect(() => computeTspCompositeFactor({ ...input, rows: invalid })).toThrow();
  }
});

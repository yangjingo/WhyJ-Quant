import { expect, test } from "bun:test";
import { planTspMiningValidation, TSP_INDICATOR_REVISION, type TspMiningValidationInput } from "../index.ts";

const dates = Array.from({ length: 1180 }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i * 2)).toISOString().slice(0, 10));
const input = { assetType: "stock", availableDates: dates, profile: "balanced" } as const satisfies TspMiningValidationInput;

test("matches the three pinned availability boundaries for the requested range", () => {
  for (const [profile, requiredBars, requiredOuterFolds] of [
    ["exploratory", 219, 1], ["balanced", 786, 3], ["strict", 1164, 3],
  ] as const) {
    const below = planTspMiningValidation({ ...input, profile, start: dates[1], end: dates[requiredBars - 1] });
    expect(below.availability).toEqual({ tradingBars: requiredBars - 1, requiredBars, requiredOuterFolds,
      outerFolds: requiredOuterFolds - 1, eligible: false,
      availableStart: dates[0], availableEnd: dates.at(-1),
      effectiveStart: dates[1], effectiveEnd: dates[requiredBars - 1], suggestedStart: dates[0] });
    const exact = planTspMiningValidation({ ...input, profile, end: dates[requiredBars - 1] });
    expect(exact).toMatchObject({ producer: "whyj", formulaVersion: "tsp-mining-validation-v1", referenceRevision: TSP_INDICATOR_REVISION,
      availability: { tradingBars: requiredBars, eligible: true, outerFolds: requiredOuterFolds } });
    expect(exact.folds.at(-1)!.outer.embargo).toEqual([]);
  }
});

test("preserves exact sparse labels for rolling outer and bounded inner windows", () => {
  const report = planTspMiningValidation({ ...input, assetType: "etf", end: dates[727] });
  expect(report).toMatchObject({ assetType: "etf", availability: { tradingBars: 728, outerFolds: 2, eligible: false } });
  const [first, second] = report.folds;
  expect(first!.outer).toEqual({
    outerIndex: 0, train: dates.slice(0, 504), purge: dates.slice(504, 534), test: dates.slice(534, 660), embargo: dates.slice(660, 665),
  });
  expect(second!.outer).toEqual({
    outerIndex: 1, train: dates.slice(63, 567), purge: dates.slice(567, 597), test: dates.slice(597, 723), embargo: dates.slice(723, 728),
  });
  expect(first!.inner).toHaveLength(3);
  expect(first!.inner[2]).toEqual({
    outerIndex: 0, innerIndex: 2, train: dates.slice(126, 378), purge: dates.slice(378, 408),
    test: dates.slice(408, 471), embargo: dates.slice(471, 476),
  });
  for (const fold of report.folds) {
    for (const inner of fold.inner) {
      expect([...inner.train, ...inner.purge, ...inner.test, ...inner.embargo].every(date => fold.outer.train.includes(date))).toBe(true);
    }
  }
  const trimmed = planTspMiningValidation({ ...input, end: dates[724] });
  expect(trimmed.folds[1]!.outer.embargo).toEqual(dates.slice(723, 725));
});

test("reports empty evidence and rejects malformed, repeated or out-of-order dates", () => {
  const empty = planTspMiningValidation({ ...input, availableDates: [] });
  expect(empty.folds).toEqual([]);
  expect(empty.availability).toMatchObject({ tradingBars: 0, eligible: false, availableStart: null, effectiveEnd: null, suggestedStart: null });
  for (const changed of [
    { availableDates: ["2026-02-30"] }, { availableDates: [dates[0], dates[0]] },
    { availableDates: dates.slice(0, 2).toReversed() }, { start: dates[1], end: dates[0] },
  ]) expect(() => planTspMiningValidation({ ...input, ...changed } as TspMiningValidationInput)).toThrow();
});

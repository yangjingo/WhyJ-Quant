import { expect, test } from "bun:test";
import { computeTspMarketPhaseSeries, TSP_INDICATOR_REVISION, type TspMarketPhaseInput } from "../index.ts";
import fixture from "./fixtures/tsp-market-phase.json";

test("six market phases reproduce the pinned classifier for a complete sequence", () => {
  const input = fixture.complete.input as TspMarketPhaseInput[];
  expect(fixture.revision).toBe(TSP_INDICATOR_REVISION);
  const result = computeTspMarketPhaseSeries(input.toReversed(), "retrospective-tsp");
  expect(result.producer).toBe("whyj");
  expect(result.formula).toEqual({ id: "tsp_market_phase", version: 1, revision: TSP_INDICATOR_REVISION });
  expect<(string | null)[]>(result.rows.map(row => row.phase)).toEqual(fixture.complete.phases);
  expect(computeTspMarketPhaseSeries(input).rows).toEqual(result.rows);
  expect(result.rows[0]!.candidate).toBe("ice");
  expect(result.rows.some(row => row.candidate !== row.phase)).toBe(true);
  const vetoed = result.rows.filter(row => row.vetoed && row.state === "weak");
  expect(vetoed).toHaveLength(2);
  expect(vetoed[0]).toMatchObject({ state: "weak", candidate: "repair", phase: "rally" });
  expect(vetoed[1]).toMatchObject({ state: "weak", candidate: "repair", phase: "repair" });
});

test("causal prefixes remain fixed and retrospective labels expose later observations", () => {
  const input = fixture.leading.input as TspMarketPhaseInput[];
  const retrospective = computeTspMarketPhaseSeries(input, "retrospective-tsp");
  expect<(string | null)[]>(retrospective.rows.map(row => row.phase)).toEqual(fixture.leading.phases);
  expect(retrospective.rows[0]).toMatchObject({ phase: "rally", futureFields: ["promotionFraction"], smoothed: {
    promotionFraction: { value: 0.3, basis: "later-observation", sourceDate: input[2]!.tradingDate },
  } });
  const causal = computeTspMarketPhaseSeries(input);
  expect(causal.rows.map(row => row.phase)).toEqual([null, null, "rally", "rally"]);
  expect(causal.rows[3]!.smoothed.promotionFraction).toEqual({ value: 0.3, basis: "carry-forward", sourceDate: input[2]!.tradingDate });
  expect(causal.rows.every(row => row.futureFields.length === 0)).toBe(true);
  for (let length = 1; length < input.length; length++) {
    expect(computeTspMarketPhaseSeries(input.slice(0, length)).rows).toEqual(causal.rows.slice(0, length));
  }
});

test("observed zero differs from absent ladder evidence and invalid inputs fail visibly", () => {
  const noData: TspMarketPhaseInput = { tradingDate: "2025-01-02", height: null, firstBoardCount: null, twoOrMoreCount: null,
    promotionFraction: null, sealFraction: null };
  expect(computeTspMarketPhaseSeries([noData]).rows[0]).toMatchObject({ phase: null, smoothed: { height: { value: null, basis: "unavailable" } } });
  expect(computeTspMarketPhaseSeries([noData], "retrospective-tsp").rows[0]).toMatchObject({ phase: null,
    smoothed: { height: { value: 0, basis: "zero-default", sourceDate: null } } });
  const zero = { ...noData, height: 0, firstBoardCount: 0, twoOrMoreCount: 0, promotionFraction: 0, sealFraction: 0 };
  expect(computeTspMarketPhaseSeries([zero]).rows[0]).toMatchObject({ phase: "ice", smoothed: { height: { value: 0, basis: "observed" } } });
  expect(() => computeTspMarketPhaseSeries([zero, noData])).toThrow("Invalid or duplicate market phase session");
  expect(() => computeTspMarketPhaseSeries([{ ...zero, sealFraction: 2 }])).toThrow("Invalid market phase fraction");
  expect(() => computeTspMarketPhaseSeries([{ ...zero, height: 2.5 }])).toThrow("Invalid market phase count");
  expect(() => computeTspMarketPhaseSeries([{ ...zero, state: "unknown" as TspMarketPhaseInput["state"] }])).toThrow("Invalid or duplicate market phase session");
});

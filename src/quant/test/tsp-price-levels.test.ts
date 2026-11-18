import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computeTspPriceLevels, TSP_INDICATOR_REVISION, TSP_PRICE_LEVEL_FORMULA_VERSION,
  type TspPriceLevelBar } from "../index.ts";

type Levels = ReturnType<typeof computeTspPriceLevels>["levels"];
const fixture = JSON.parse(readFileSync(new URL("./fixtures/tsp-price-levels.json", import.meta.url), "utf8")) as {
  revision: string; polars: string; bars: TspPriceLevelBar[];
  history: { count: number; expected: Levels }[];
  noTurnover: Levels; partialTurnover: Levels;
  single: { bar: TspPriceLevelBar; expected: Levels }[];
};

test("matches all 11 pinned TSP price level groups at warm-up and gap boundaries", () => {
  expect(fixture.revision).toBe(TSP_INDICATOR_REVISION);
  expect(TSP_PRICE_LEVEL_FORMULA_VERSION).toBe(1);
  const observed = new Set<string>();
  for (const { count, expected } of fixture.history) {
    const bars = fixture.bars.slice(0, count);
    const result = computeTspPriceLevels(bars);
    expect(result.asOf).toBe(bars.at(-1)?.date ?? null);
    expect(result.levels, `history length ${count}`).toEqual(expected);
    for (const [group, points] of Object.entries(expected)) if (points.length) observed.add(group);
  }
  expect(observed.size).toBe(11);
  for (const { bar, expected } of fixture.single) {
    expect(computeTspPriceLevels([bar]).levels, `price ${bar.close}`).toEqual(expected);
  }
});

test("reports the profile's turnover basis and rejects invalid observations", () => {
  const onlyVolume = fixture.bars.map(({ turnoverPct: _turnover, ...bar }) => bar);
  expect(computeTspPriceLevels(onlyVolume)).toMatchObject({ volumeProfileBasis: "volume-only", levels: fixture.noTurnover });
  const partial = fixture.bars.map((bar, i) => i % 3 === 0 ? { ...bar, turnoverPct: null } : bar);
  expect(computeTspPriceLevels(partial)).toMatchObject({ volumeProfileBasis: "partial-turnover", levels: fixture.partialTurnover });
  expect(computeTspPriceLevels(fixture.bars).volumeProfileBasis).toBe("turnover-decay");
  expect(() => computeTspPriceLevels([{ ...fixture.bars[0]!, turnoverPct: -1 }])).toThrow("turnover observation");
});

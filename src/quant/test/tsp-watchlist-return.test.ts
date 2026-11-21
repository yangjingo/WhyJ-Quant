import { expect, test } from "bun:test";
import { computeTspWatchlistReturn, type TspWatchlistReturnInput } from "../index.ts";

const base = { assetType: "stock", adjustment: "forward" } as const;
const bar = (tradeDate: string, close: number) => ({ tradeDate, close });

test("reproduces the pinned TSP same-day baseline and fractional result", () => {
  const result = computeTspWatchlistReturn({ ...base, addedAt: "2026-09-10T03:21:07", asOf: "2026-09-18",
    closes: [bar("2026-09-09", 9), bar("2026-09-10", 10), bar("2026-09-11", 10.5), bar("2026-09-18", 11)] });
  expect(result).toMatchObject({ producer: "whyj", formulaVersion: "tsp-watchlist-return-v1", status: "available",
    addedAt: "2026-09-10T03:21:07", addedDate: "2026-09-10", returnUnit: "fraction", baseline: bar("2026-09-10", 10), latest: bar("2026-09-18", 11) });
  expect(result.pctSinceAdded).toBeCloseTo(0.1, 12);
});

test("maps UTC to Shanghai dates and preserves weekend baseline, original dates and zero", () => {
  const closes = [bar("2026-09-17", 10), bar("2026-09-18", 12), bar("2026-09-21", 13.2), bar("2026-09-22", 17)];
  for (const addedAt of ["2026-09-18T20:30:00", "2026-09-19T04:30:00+08:00", "2026-09-19"]) {
    const result = computeTspWatchlistReturn({ ...base, addedAt, asOf: "2026-09-21", closes });
    expect(result).toMatchObject({ addedAt, addedDate: "2026-09-19", baseline: bar("2026-09-18", 12), latest: bar("2026-09-21", 13.2) });
    expect(result.pctSinceAdded).toBeCloseTo(0.1, 12);
  }
  expect(computeTspWatchlistReturn({ ...base, addedAt: "2026-09-19", asOf: "2026-09-19", closes }))
    .toMatchObject({ status: "available", pctSinceAdded: 0, latest: bar("2026-09-18", 12) });
});

test("keeps unavailable reasons and rejects corrupt or incompatible price evidence", () => {
  const input: TspWatchlistReturnInput = { ...base, addedAt: "2024-03-03", asOf: "2024-03-04", closes: [bar("2024-03-04", 10)] };
  expect(computeTspWatchlistReturn(input)).toMatchObject({ status: "missing-baseline", baseline: null, latest: bar("2024-03-04", 10), pctSinceAdded: null });
  for (const addedAt of [null, "", "2024-02-30T12:00:00Z", "2024-02-28T24:00:00Z"]) {
    expect(computeTspWatchlistReturn({ ...input, addedAt })).toMatchObject({ status: "missing-added-date", pctSinceAdded: null });
  }
  expect(computeTspWatchlistReturn({ ...input, addedAt: "2024-03-05" })).toMatchObject({ status: "added-after-cutoff", pctSinceAdded: null });
  for (const assetType of ["etf", "index"] as const) {
    expect(computeTspWatchlistReturn({ ...input, assetType })).toMatchObject({ status: "unsupported-asset", pctSinceAdded: null });
  }
  expect(() => computeTspWatchlistReturn({ ...input, adjustment: "none" })).toThrow("forward-adjusted");
  expect(() => computeTspWatchlistReturn({ ...input, closes: [bar("2024-03-04", 10), bar("2024-03-04", 11)] })).toThrow("ordered unique");
  expect(() => computeTspWatchlistReturn({ ...input, closes: [bar("2024-03-01", Infinity)] })).toThrow("positive closes");
});
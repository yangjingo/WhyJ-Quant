import { expect, test } from "bun:test";
import { computeTspDepthSeal, TSP_INDICATOR_REVISION, type TspDepthLimitCandidate, type TspDepthSealInput } from "../index.ts";

const tradingDate = "2025-01-03";
const asOf = Date.parse(tradingDate + "T15:01:00+08:00");
const maxAgeMs = 60_000;
const symbols = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH", "600006.SH", "600007.SH", "600008.SH", "600009.SH"] as const;
const candidates: TspDepthLimitCandidate[] = symbols.map((symbol, index) => ({ symbol, side: index < 5 ? "up" : "down" }));
const quote = (index: number, bestBidVolume: number | null, bestAskVolume: number | null, timestamp = asOf - 1000) => ({
  symbol: symbols[index]!, timestamp, bestBidVolume, bestAskVolume,
});

test("derives both sides from observed opposing quotes and identifies partial correction evidence", () => {
  const result = computeTspDepthSeal({
    tradingDate, asOf, maxAgeMs, candidates,
    quotes: [
      quote(0, 1000, 0), quote(1, 0, 1200), quote(2, 1000, null),
      quote(3, 0, 0, asOf - maxAgeMs - 1), quote(4, 0, 0, asOf + 1),
      quote(5, 0, 1000, asOf - maxAgeMs), quote(6, 1200, 0),
      quote(7, 0, 0, Date.parse("2025-01-02T15:00:00+08:00")),
    ],
  });
  expect(result).toMatchObject({
    producer: "whyj", formula: { id: "tsp_depth_seal", version: 1, revision: TSP_INDICATOR_REVISION }, coverage: "partial",
    up: { priceLimitCount: 5, observedSealed: 1, observedUnsealed: 1, missing: 3, correctedCount: 4 },
    down: { priceLimitCount: 4, observedSealed: 1, observedUnsealed: 1, missing: 2, correctedCount: 3 },
  });
  expect(result.rows.map(row => [row.sealed, row.availability])).toEqual([
    [true, "observed"], [false, "observed"], [null, "missing-level"], [null, "stale"], [null, "after-cutoff"],
    [true, "observed"], [false, "observed"], [null, "off-date"], [null, "missing-book"],
  ]);
  expect(result.rows[0]?.opposingVolume).toBe(0);
  expect(result.rows[6]?.opposingVolume).toBe(1200);
});

test("distinguishes missing evidence and an empty candidate set, and rejects malformed scope and identities", () => {
  const input: TspDepthSealInput = { tradingDate, asOf, maxAgeMs, candidates, quotes: [] };
  expect(computeTspDepthSeal(input)).toMatchObject({ coverage: "unavailable", up: { correctedCount: 5 }, down: { correctedCount: 4 } });
  expect(computeTspDepthSeal({ ...input, candidates: [] })).toMatchObject({ coverage: "complete", up: { correctedCount: 0 }, rows: [] });
  expect(() => computeTspDepthSeal({ ...input, tradingDate: "2025-01-02" })).toThrow("Invalid depth seal scope");
  expect(() => computeTspDepthSeal({ ...input, maxAgeMs: -1 })).toThrow("Invalid depth seal scope");
  expect(() => computeTspDepthSeal({ ...input, candidates: [...candidates, candidates[0]!] })).toThrow("depth seal candidate");
  expect(() => computeTspDepthSeal({ ...input, quotes: [quote(0, 0, 0), quote(0, 0, 0)] })).toThrow("depth seal quote");
  expect(() => computeTspDepthSeal({ ...input, quotes: [{ ...quote(0, 0, 0), symbol: "600010.SH" }] })).toThrow("depth seal quote");
  expect(() => computeTspDepthSeal({ ...input, quotes: [quote(0, 0, -1)] })).toThrow("depth seal quote");
});

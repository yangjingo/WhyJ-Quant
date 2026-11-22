import { expect, test } from "bun:test";
import { computeTspDepthQueue, computeTspDepthSeal, TSP_INDICATOR_REVISION, type TspDepthLimitCandidate,
  type TspDepthQueueInput, type TspDepthSealInput } from "../index.ts";

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

test("uses the best own-side queue, converts hands to shares and compares positive values inclusively", () => {
  const input: TspDepthQueueInput = {
    tradingDate, asOf, maxAgeMs, candidates: candidates.map(candidate => ({ ...candidate, closeCny: 12.5 })),
    quotes: [
      quote(0, 2, 50), quote(1, 0, 2), quote(2, null, 0),
      quote(3, 1, 0, asOf - maxAgeMs - 1), quote(4, 1, 0, asOf + 1),
      quote(5, null, 1, asOf - maxAgeMs), quote(6, 0, 3),
      quote(7, 0, 1, Date.parse("2025-01-02T15:00:00+08:00")),
    ],
    volumeUnit: "hand",
    rule: { metric: "sealed_amount", threshold: 2500 },
  };
  const result = computeTspDepthQueue(input);
  expect(result).toMatchObject({ producer: "whyj", formula: { id: "tsp_depth_queue", version: 1, revision: TSP_INDICATOR_REVISION },
    volumeUnit: "hand", observedCandidates: 4 });
  expect(result.rows.map(row => [row.nativeVolume, row.queueHands, row.queueAmountCny, row.triggered, row.availability])).toEqual([
    [2, 2, 2500, true, "observed"], [0, 0, 0, false, "observed"], [null, null, null, null, "missing-level"],
    [1, null, null, null, "stale"], [1, null, null, null, "after-cutoff"],
    [1, 1, 1250, true, "observed"], [3, 3, 3750, false, "observed"],
    [1, null, null, null, "off-date"], [null, null, null, null, "missing-book"],
  ]);
  expect(result.rows[0]?.queueShares).toBe(200);
  const exactShare = computeTspDepthQueue({ ...input, volumeUnit: "share", rule: { metric: "sealed_vol", threshold: 0.02 } });
  expect(exactShare.rows[0]).toMatchObject({ queueShares: 2, queueHands: 0.02, queueAmountCny: 25, triggered: true });
  expect(exactShare.rows[6]?.triggered).toBe(false);
});

test("keeps provider-native volumes with unknown units and declines amount without a close", () => {
  const input: TspDepthQueueInput = {
    tradingDate, asOf, maxAgeMs, candidates: [{ ...candidates[0]!, closeCny: null }], quotes: [quote(0, 200, null)],
    volumeUnit: "unknown", rule: { metric: "sealed_vol", threshold: 10 },
  };
  expect(computeTspDepthQueue(input).rows[0]).toMatchObject({
    availability: "observed", nativeVolume: 200, queueShares: null, queueHands: null, queueAmountCny: null, triggered: null,
  });
  expect(computeTspDepthQueue({ ...input, volumeUnit: "share" }).rows[0]).toMatchObject({
    queueShares: 200, queueHands: 2, queueAmountCny: null, triggered: true,
  });
  expect(computeTspDepthQueue({ ...input, volumeUnit: "share", rule: { metric: "sealed_amount", threshold: 100 } }).rows[0])
    .toMatchObject({ queueAmountCny: null, triggered: null });
  expect(() => computeTspDepthQueue({ ...input, rule: { metric: "sealed_vol", threshold: -1 } })).toThrow("depth queue rule");
  expect(() => computeTspDepthQueue({ ...input, candidates: [{ ...input.candidates[0]!, closeCny: Infinity }] })).toThrow("depth queue close");
});

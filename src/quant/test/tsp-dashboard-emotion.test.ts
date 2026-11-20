import { expect, test } from "bun:test";
import { computeTspDashboardEmotion, TSP_INDICATOR_REVISION, type TspDashboardEmotionInput } from "../index.ts";

const tradingDate = "2025-01-03";
const symbols = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH"] as const;
const [first, second, third, fourth, suspended] = symbols;
const universe = { id: "a-share", revision: "roster-1", tradingDate, symbols };
const observedAt = "2025-01-04T01:00:00Z";
const stock = (symbol: string, changeFraction: number | null, volumeRatio5d: number | null) => ({
  tradingDate, symbol, name: null, close: 12, changeFraction, volumeShares: 100, volumeRatio5d, amountCny: 1200,
  limitUp: false, brokenLimitUp: false, upStreak: 0,
});
const stocks = [
  { ...stock(first, 0.04, 1.5), upStreak: 2, limitUp: true },
  { ...stock(second, -0.035, 0.5), brokenLimitUp: true },
  stock(third, null, null),
  stock(fourth, 0, null),
  { ...stock(suspended, 0, 99), volumeShares: 0 },
];
const membership = {
  basis: "provider-dated-snapshot" as const, source: "fixture", revision: "sector-r1", taxonomy: "test",
  tradeDate: tradingDate, observedAt,
};
const group = (id: string, name: string, members: readonly string[]) => ({
  id, name, revision: `group-${id}`, observedAt, symbols: members,
});
const input: TspDashboardEmotionInput = {
  universe, stocks,
  indices: [
    { tradingDate, symbol: "000001.SH", returnPct: 1.4 },
    { tradingDate, symbol: "399001.SZ", returnPct: -0.4 },
    { tradingDate, symbol: "399006.SZ", returnPct: null },
  ],
  sectors: {
    concept: {
      ...membership, kind: "concept",
      groups: [
        group("leader", "Leader", [first, third]), group("weak", "Weak", [second]),
        group("flat", "Flat", [fourth]), group("next", "Next", [first, second]),
        group("unknown", "Unknown", [third]), group("suspended", "Suspended", [suspended]),
      ],
    },
    industry: {
      ...membership, kind: "industry",
      groups: [group("i1", "I-Shared-X", [first, third]), group("i2", "J-Shared-Y", [second, third])],
    },
  },
};

test("assembles all six dashboard dimensions using dated observations and eligible-row denominators", () => {
  const result = computeTspDashboardEmotion(input);
  expect(result).toMatchObject({
    producer: "whyj", tradingDate,
    universe: { id: "a-share", revision: "roster-1" },
    formula: { id: "tsp_dashboard_emotion", version: 1, scoreVersion: 1, revision: TSP_INDICATOR_REVISION },
    metrics: {
      up_pct: 25, down_pct: 25, median_pct: 0, strong_diff_pct: 0, strong_down_pct: 25,
      avg_vol_ratio: 1, high_vol_pct: 25, limit_up: 1, seal_rate: 50, max_boards: 2, tier2_count: 1,
      mainline_avg: 0.04, mainline_cover_pct: 75,
    },
    evidence: {
      stocks: { eligible: 4, excludedBySuspensionRule: 1 },
      returnsKnown: 3, volumeRatiosKnown: 2, exchange: { depthCorrection: "unavailable" },
    },
    emotion: { observedDimensions: 6 },
  });
  expect(result.metrics.avg_pct).toBeCloseTo(0.005 / 3, 12);
  expect(result.metrics.avg_index_pct).toBeCloseTo(0.5, 12);
  expect(result.evidence.indexEvidence).toEqual([
    { symbol: "000001.SH", returnPct: 1.4, present: true },
    { symbol: "399001.SZ", returnPct: -0.4, present: true },
    { symbol: "399006.SZ", returnPct: null, present: true },
    { symbol: "000680.SH", returnPct: null, present: false },
  ]);
  expect(result.evidence.leaders.map(row => row.name)).toEqual(["Leader", "Next", "Flat", "Shared"]);
  expect(result.evidence.leaders[3]).toMatchObject({ kind: "industry", groupIds: ["i1", "i2"], observedCount: 3 });
  expect(result.evidence.sectorMembership[1]).toMatchObject({
    ...membership,
    groups: [{ id: "i1", revision: "group-i1" }, { id: "i2", revision: "group-i2" }],
  });
  const withEvenReturns = stocks.map(row => row.symbol === third ? { ...row, changeFraction: 0.02 } : row);
  expect(computeTspDashboardEmotion({ ...input, stocks: withEvenReturns }).metrics.median_pct).toBe(0.02);
});

test("distinguishes an observed zero from missing inputs or an empty snapshot", () => {
  const empty = computeTspDashboardEmotion({ universe, stocks: [], indices: [] });
  expect(empty.metrics).toMatchObject({ avg_index_pct: null, up_pct: null, avg_vol_ratio: null, limit_up: null, seal_rate: null });
  expect(empty.emotion).toMatchObject({ score: null, observedDimensions: 0 });
  expect(empty.metrics).not.toHaveProperty("mainline_avg");
  const base = { universe, stocks: [stock(first, null, null)], indices: [] };
  expect(computeTspDashboardEmotion(base).metrics).toMatchObject({
    avg_pct: null, up_pct: null, high_vol_pct: null, limit_up: 0, seal_rate: 0, max_boards: 0, tier2_count: 0,
  });
  expect(computeTspDashboardEmotion({
    ...base, stocks: [{ ...stock(first, null, null), upStreak: null, limitUp: null, brokenLimitUp: null }],
  }).metrics).toMatchObject({ limit_up: null, seal_rate: null, max_boards: null, tier2_count: null });
});

test("rejects wrong dates, identities, duplicate rows and nonfinite evidence", () => {
  const row = input.indices[0]!;
  for (const indices of [[row, row], [{ ...row, tradingDate: "2025-01-06" }], [{ ...row, returnPct: Infinity }]]) {
    expect(() => computeTspDashboardEmotion({ ...input, indices })).toThrow("Invalid or duplicate dashboard core index");
  }
  expect(() => computeTspDashboardEmotion({
    ...input, stocks: [...stocks, stock("600009.SH", 0, null)],
  })).toThrow();
  expect(() => computeTspDashboardEmotion({
    ...input, sectors: { concept: { ...input.sectors!.concept!, tradeDate: "2025-01-06" } },
  })).toThrow("Invalid sector snapshot date");
});

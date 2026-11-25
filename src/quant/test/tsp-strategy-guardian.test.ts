import { expect, test } from "bun:test";
import {
  evaluateTspStrategyGuardian, planTspStrategyGuardianCheck, summarizeTspStrategyGuardianHistory,
  TSP_INDICATOR_REVISION, type TspStrategyGuardianCheckInput, type TspStrategyGuardianHistoryInput,
} from "../index.ts";

test("reports the trailing successful watch count and the pinned two-check alert", () => {
  const strategyId = "volume-momentum";
  const watch = { verdict: "watch" } as const;
  const calculate = (checks: TspStrategyGuardianHistoryInput["checks"]) => summarizeTspStrategyGuardianHistory({ strategyId, checks });
  expect(calculate([])).toEqual({
    producer: "whyj", formulaVersion: "tsp-strategy-guardian-history-v1", referenceRevision: TSP_INDICATOR_REVISION,
    strategyId, checkCount: 0, consecutiveWatch: 0, alert: false,
  });
  expect(calculate([watch])).toMatchObject({ checkCount: 1, consecutiveWatch: 1, alert: false });
  expect(calculate([{ verdict: "watch", error: "" }, { verdict: "watch", error: null }]))
    .toMatchObject({ checkCount: 2, consecutiveWatch: 2, alert: true });
  expect(calculate([watch, watch, watch])).toMatchObject({ checkCount: 3, consecutiveWatch: 3, alert: true });
  for (const interruption of [{ verdict: "healthy" }, { verdict: "retired" }, { verdict: null },
    { verdict: null, error: "no score" }, { verdict: "watch", error: "incomplete evidence" }] as const) {
    expect(calculate([watch, watch, interruption])).toMatchObject({ checkCount: 3, consecutiveWatch: 0, alert: false });
    expect(calculate([watch, interruption, watch, watch])).toMatchObject({ checkCount: 4, consecutiveWatch: 2, alert: true });
  }
});

test("rejects invalid history scope or malformed checks even before the trailing watches", () => {
  expect(() => summarizeTspStrategyGuardianHistory({ strategyId: " ", checks: [] })).toThrow();
  for (const check of [null, {}, { verdict: "unknown" }, { verdict: "watch", error: false }]) {
    expect(() => summarizeTspStrategyGuardianHistory({
      strategyId: "x", checks: [check as TspStrategyGuardianHistoryInput["checks"][number], { verdict: "watch" }],
    })).toThrow();
  }
});

const sessions = ["2026-01-02", ...Array.from({ length: 61 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 5 + i))).filter(date => date.getUTCDay() % 6 !== 0)
  .map(date => date.toISOString().slice(0, 10))];
const scope = { dataAsOf: sessions[0]!, sessions };
const windows = [
  { start: "2026-01-05", end: "2026-01-20" },
  { start: "2026-01-21", end: "2026-02-04" },
  { start: "2026-02-05", end: "2026-02-19" },
  { start: "2026-02-20", end: "2026-03-06" },
];

function check(score: number | null, trades: number | null = 20, drawdown: number | null = -0.1): TspStrategyGuardianCheckInput {
  return { ...scope, strategyId: "volume-momentum", objective: "sharpe", baselineScore: 2, baselineTradeCount: 120,
    segments: windows.map(window => ({ ...window, objective: score, tradeCount: trades, maxDrawdownFraction: drawdown })) };
}

test("plans only post-baseline dates using the largest admissible pinned split", () => {
  expect(planTspStrategyGuardianCheck(scope)).toMatchObject({ status: "ready", newTradingDays: 45, windows });
  expect(planTspStrategyGuardianCheck({ ...scope, thresholds: { maxSegments: 2 } })).toMatchObject({
    status: "ready", windows: [{ start: "2026-01-05", end: "2026-02-04" }, { start: "2026-02-05", end: "2026-03-06" }],
  });
  expect(evaluateTspStrategyGuardian({ ...check(0), sessions: sessions.slice(0, 3), segments: [] })).toMatchObject({
    status: "skipped", reason: "insufficient-new-data",
  });
  expect(planTspStrategyGuardianCheck({ ...scope, sessions: sessions.slice(0, 3), thresholds: { minNewTradingDays: 2 } }))
    .toMatchObject({ status: "skipped", reason: "window-too-short" });
});

test("uses the pinned watch and retirement thresholds and signed drawdown", () => {
  expect(evaluateTspStrategyGuardian(check(2))).toMatchObject({ status: "healthy", degradationFraction: 0, reasons: [] });
  expect(evaluateTspStrategyGuardian(check(1))).toMatchObject({
    status: "watch", degradationFraction: 0.5, reasons: ["watch-degradation"], hardTradeFloor: 12, softTradeFloor: 40,
  });
  expect(evaluateTspStrategyGuardian(check(0.5))).toMatchObject({
    status: "retired", degradationFraction: 0.75, reasons: ["retirement-degradation"],
  });
  expect(evaluateTspStrategyGuardian(check(2, 0, -0.5))).toMatchObject({
    status: "retired", evidence: { tradeCount: 0, tradeCountSegments: 4 }, reasons: ["hard-trade-drought"],
  });
  expect(evaluateTspStrategyGuardian({ ...check(-0.4, 20, -0.4), objective: "max_drawdown", baselineScore: -0.1,
    thresholds: { maxSoftDrawdownFraction: -0.45 } })).toMatchObject({
    status: "watch", degradationFraction: null, objectiveSoftFloor: -0.3, reasons: ["objective-soft-floor"],
  });
  expect(evaluateTspStrategyGuardian(check(2, 9, -0.4))).toMatchObject({
    status: "watch", reasons: ["drawdown-soft-floor", "soft-trade-drought"],
  });
});

test("incomplete segment scores prevent retirement and entirely missing scores yield no verdict", () => {
  const complete = check(0.5, 0);
  const incomplete = evaluateTspStrategyGuardian({ ...complete, segments: [
    { ...complete.segments[0]!, objective: null, tradeCount: null, maxDrawdownFraction: null }, ...complete.segments.slice(1),
  ] });
  expect(incomplete).toMatchObject({
    status: "watch", evidence: { missingScoreSegments: 1, tradeCountSegments: 3, incompleteData: true },
    reasons: ["incomplete-segments", "retirement-degradation", "hard-trade-drought"],
  });
  expect(evaluateTspStrategyGuardian(check(null, null, null))).toMatchObject({
    status: "unavailable", reason: "all-segment-scores-missing", evidence: {
      currentScore: null, tradeCount: 0, tradeCountSegments: 0, worstDrawdownFraction: null, missingScoreSegments: 4,
    },
  });
});

test("rejects invalid baseline, unordered dates, thresholds and misbound segment evidence", () => {
  expect(() => evaluateTspStrategyGuardian({ ...check(2), baselineScore: NaN })).toThrow("baseline");
  expect(() => planTspStrategyGuardianCheck({ ...scope, sessions: sessions.toReversed() })).toThrow("calendar");
  expect(() => planTspStrategyGuardianCheck({ ...scope, thresholds: { watchFraction: 0.5, retireFraction: 0.5 } })).toThrow("thresholds");
  expect(() => evaluateTspStrategyGuardian({ ...check(2), segments: check(2).segments.toReversed() })).toThrow("segment evidence");
  expect(() => evaluateTspStrategyGuardian({ ...check(2), segments: check(2).segments.slice(1) })).toThrow("planned window");
});

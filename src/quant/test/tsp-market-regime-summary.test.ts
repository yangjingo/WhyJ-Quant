import { expect, test } from "bun:test";
import { summarizeTspMarketRegime, type TspRegimeMainlineRank, type TspRegimeSummarySession } from "../index.ts";

function session(day: number, overrides: Partial<TspRegimeSummarySession> = {}): TspRegimeSummarySession {
  return {
    tradingDate: `2024-03-${String(day).padStart(2, "0")}`,
    state: null, phase: null, score: null,
    height: null, firstBoardCount: null, twoOrMoreCount: null,
    promotionFraction: null, sealFraction: null, ladderCompletenessFraction: null,
    ...overrides,
  };
}

function concept(name: string, rank: number, score: number, maxBoards: number, leaderSymbol = "600000.SH"): TspRegimeMainlineRank {
  return { name, rank, score, maxBoards, leaderSymbol };
}

test("summarizes fixed state runs, phase segments, coverage and concept ranking", () => {
  const data = [
    session(1, { state: "weak", score: 20, phase: "rally", height: 5, firstBoardCount: 12, twoOrMoreCount: 7,
      sealFraction: 0.8, promotionFraction: 0.0625, conceptRanks: [
        concept("repeat", 2, 40.125, 6), concept("one high", 1, 100, 8), concept("rank six", 6, 100, 8),
      ] }),
    session(4, { state: "weak", score: 25, phase: "rally", firstBoardCount: 3, conceptRanks: [
      concept("repeat", 4, 50, 9, "000001.SZ"), concept("one low", 5, 20, 2),
    ] }),
    session(5),
    session(6, { state: "range", score: 50, phase: "repair", height: 2, conceptRanks: [] }),
    session(7, { state: "lean_strong", score: 60, phase: "repair", height: 2 }),
    session(8, { state: "lean_strong", score: 65, phase: "rally", height: 7 }),
  ];
  const result = summarizeTspMarketRegime(data);
  expect(result).toMatchObject({
    producer: "whyj", formula: { id: "tsp_market_regime_summary", version: 1 },
    window: { start: "2024-03-01", end: "2024-03-08", sessions: 6, observedStates: 5 },
    stateSwitches: { count: 1, observedPairs: 3, fraction: 1 / 3 },
    momentum: { state: "lean_strong", streak: 2, scoreSlope: 10, sessionsSinceLastObservedWeak: 4 },
    currentPhase: { phase: "rally", streak: 1, segments: 2, averageDays: 2, maxDays: 2,
      successors: [{ phase: null, transitions: 1, pct: 100 }] },
    distribution: [
      { state: "weak", days: 2, pct: 33.3 }, { state: "lean_strong", days: 2, pct: 33.3 },
      { state: null, days: 1, pct: 16.7 }, { state: "range", days: 1, pct: 16.7 },
    ],
  });
  expect(result.segments.map(row => row.phase)).toEqual(["rally", null, "repair", "rally"]);
  expect(result.segments[0]).toMatchObject({
    start: "2024-03-01", end: "2024-03-04", days: 2, conceptDays: 2,
    means: {
      height: { value: 2.5, observed: 1, denominator: 2 },
      firstBoardCount: { value: 7.5, observed: 2, denominator: 2 },
      twoOrMoreCount: { value: 3.5, observed: 1, denominator: 2 },
      promotionFraction: { value: 0.062, observed: 1, denominator: 1 },
      sealFraction: { value: 0.4, observed: 1, denominator: 2 },
    },
    topConcepts: [
      { name: "repeat", topFiveDays: 2, scoreSum: 90.1, maxBoards: 9, leaderSymbol: "600000.SH" },
      { name: "one high", topFiveDays: 1, scoreSum: 100 },
      { name: "one low", topFiveDays: 1, scoreSum: 20 },
    ],
  });
  expect(result.segments[1]).toMatchObject({ phase: null, conceptDays: 0,
    means: { height: { value: 0, observed: 0, denominator: 1 }, promotionFraction: { value: null, observed: 0, denominator: 0 } } });
  expect(result.segments[2]).toMatchObject({ conceptDays: 1, topConcepts: [] });
});

test("applies the twenty-observation cutoff and keeps empty and unknown windows explicit", () => {
  const days = Array.from({ length: 20 }, (_, i) => session(i + 1, { height: i < 10 ? 4 : i === 19 ? 5 : 6,
    promotionFraction: i === 0 ? null : 0.5 }));
  const latest = summarizeTspMarketRegime(days);
  expect(latest.latestPercentiles.find(row => row.field === "height"))
    .toEqual({ field: "height", value: 5, observed: 20, percentilePct: 55 });
  expect(latest.latestPercentiles.find(row => row.field === "promotionFraction"))
    .toEqual({ field: "promotionFraction", value: 0.5, observed: 19, percentilePct: null });
  expect(latest).toMatchObject({ currentPhase: null, momentum: { streak: null, scoreSlope: null, sessionsSinceLastObservedWeak: null },
    stateSwitches: { observedPairs: 0, fraction: null } });
  expect(summarizeTspMarketRegime([])).toMatchObject({
    window: { start: null, end: null, sessions: 0, observedStates: 0 }, distribution: [], segments: [], momentum: null, currentPhase: null,
  });
});

test("breaks equal appearance and score ties by concept name across locales", () => {
  const result = summarizeTspMarketRegime([session(1, { conceptRanks: [
    concept("银行", 1, 50, 1), concept("a", 2, 50, 1), concept("Z", 3, 50, 1), concept("A", 4, 50, 1),
  ] })]);
  expect(result.segments[0]?.topConcepts.map(row => row.name)).toEqual(["A", "Z", "a"]);
});

test("rejects unusable session evidence and duplicate daily group ranks", () => {
  expect(() => summarizeTspMarketRegime([session(3), session(2)])).toThrow("unordered");
  expect(() => summarizeTspMarketRegime([session(3), session(3)])).toThrow("unordered");
  expect(() => summarizeTspMarketRegime([session(1, { height: -1 })])).toThrow("Invalid");
  expect(() => summarizeTspMarketRegime([session(1, { sealFraction: 2 })])).toThrow("Invalid");
  expect(() => summarizeTspMarketRegime([session(1, { conceptRanks: [concept("a", 1, 10, 3), concept("a", 2, 8, 2)] })]))
    .toThrow("duplicate");
  expect(() => summarizeTspMarketRegime([session(1, { conceptRanks: [concept("a", 1, 10, 3), concept("b", 1, 8, 2)] })]))
    .toThrow("duplicate");
});

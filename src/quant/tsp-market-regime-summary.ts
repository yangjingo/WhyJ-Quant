import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspMarketPhase, TspMarketPhaseInput } from "./tsp-market-phase.ts";
import type { TspMarketState } from "./tsp-market-regime.ts";

export const TSP_MARKET_REGIME_SUMMARY_FORMULA_VERSION = 1;

export interface TspRegimeMainlineRank {
  name: string;
  rank: number;
  score: number;
  maxBoards: number;
  leaderSymbol: string | null;
}

export interface TspRegimeSummarySession extends TspMarketPhaseInput {
  state: TspMarketState | null;
  score: number | null;
  phase: TspMarketPhase | null;
  ladderCompletenessFraction: number | null;
  conceptRanks?: readonly TspRegimeMainlineRank[] | null;
}

const states: readonly TspMarketState[] = ["strong", "lean_strong", "range", "lean_weak", "weak"];
const phases: readonly TspMarketPhase[] = ["ice", "ignite", "rally", "climax", "ebb", "repair"];
const countFields = ["height", "firstBoardCount", "twoOrMoreCount"] as const;
const fractionFields = ["promotionFraction", "sealFraction", "ladderCompletenessFraction"] as const;
const percentileFields = [...countFields, "promotionFraction", "ladderCompletenessFraction"] as const;

const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const inRange = (value: number, max: number) => Number.isFinite(value) && value >= 0 && value <= max;

function validate(rows: readonly TspRegimeSummarySession[]) {
  let prior = "";
  for (const row of rows) {
    const { tradingDate, state, phase, score, conceptRanks } = row;
    if (typeof tradingDate !== "string" || !isDailyDate(tradingDate) || tradingDate <= prior ||
      (state !== null && !states.includes(state)) || (phase !== null && !phases.includes(phase)) ||
      (score !== null && !inRange(score, 100)) ||
      countFields.some(field => row[field] !== null && !count(row[field]!)) ||
      fractionFields.some(field => row[field] !== null && !inRange(row[field]!, 1))) {
      throw new Error("Invalid or unordered market summary session");
    }
    if (conceptRanks != null && (!Array.isArray(conceptRanks) ||
      new Set(conceptRanks.map(item => item.name)).size !== conceptRanks.length ||
      new Set(conceptRanks.map(item => item.rank)).size !== conceptRanks.length ||
      conceptRanks.some(item => typeof item.name !== "string" || !item.name.trim() ||
        !count(item.rank) || item.rank < 1 || !inRange(item.score, 100) || !count(item.maxBoards) ||
        (item.leaderSymbol !== null && (typeof item.leaderSymbol !== "string" || !item.leaderSymbol.trim()))))) {
      throw new Error("Invalid or duplicate market summary concept ranking");
    }
    prior = tradingDate;
  }
}

function round(value: number, digits: number) {
  const scale = 10 ** digits, scaled = value * scale, lower = Math.floor(scaled);
  // Python rounds exact binary ties to even. toFixed handles non-ties in the original binary double.
  if (scaled - lower === 0.5 && Number.isInteger(value * 2 ** (digits + 1))) return (lower + lower % 2) / scale;
  return Number(value.toFixed(digits));
}

function topConcepts(rows: readonly TspRegimeSummarySession[]) {
  const concepts = new Map<string, { name: string; topFiveDays: number; scoreSum: number; maxBoards: number; leaderSymbol: string | null }>();
  for (const { conceptRanks } of rows) {
    for (const { name, rank, score, maxBoards, leaderSymbol } of conceptRanks ?? []) {
      if (rank > 5) continue;
      const aggregate = concepts.get(name);
      if (aggregate) {
        aggregate.topFiveDays++;
        aggregate.scoreSum += score;
        aggregate.maxBoards = Math.max(aggregate.maxBoards, maxBoards);
      } else concepts.set(name, { name, topFiveDays: 1, scoreSum: score, maxBoards, leaderSymbol });
    }
  }
  return [...concepts.values()].sort((left, right) =>
    right.topFiveDays - left.topFiveDays || right.scoreSum - left.scoreSum || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, 3).map(item => ({ ...item, scoreSum: round(item.scoreSum, 1) }));
}

function phaseSegment(rows: readonly TspRegimeSummarySession[]) {
  const mean = (field: typeof countFields[number] | "promotionFraction" | "sealFraction", digits: number, omitMissing = false) => {
    const values = rows.map(row => row[field]).filter((value): value is number => value !== null);
    const denominator = omitMissing ? values.length : rows.length;
    return { value: denominator ? round(values.reduce((sum, value) => sum + value, 0) / denominator, digits) : null,
      observed: values.length, denominator };
  };
  return {
    phase: rows[0]!.phase, start: rows[0]!.tradingDate, end: rows.at(-1)!.tradingDate, days: rows.length,
    means: {
      height: mean("height", 1), firstBoardCount: mean("firstBoardCount", 1), twoOrMoreCount: mean("twoOrMoreCount", 1),
      promotionFraction: mean("promotionFraction", 3, true), sealFraction: mean("sealFraction", 3),
    },
    conceptDays: rows.filter(row => row.conceptRanks != null).length, topConcepts: topConcepts(rows),
  };
}

/** Summarize one explicit trading window using materialized state, phase and theme results. */
export function summarizeTspMarketRegime(rows: readonly TspRegimeSummarySession[]) {
  validate(rows);
  const latest = rows.at(-1);
  const statesByCount = new Map<TspMarketState | null, number>();
  const segments: ReturnType<typeof phaseSegment>[] = [];
  let segmentStart = 0, stateStreak = 0, switches = 0, observedPairs = 0, observedStates = 0;
  let lastWeakIndex = -1;
  for (const [index, row] of rows.entries()) {
    const prior = rows[index - 1];
    statesByCount.set(row.state, (statesByCount.get(row.state) ?? 0) + 1);
    if (row.state !== null) {
      observedStates++;
      if (row.state === "weak" || row.state === "lean_weak") lastWeakIndex = index;
      if (prior && prior.state !== null) {
        observedPairs++;
        if (row.state !== prior.state) switches++;
      }
    }
    stateStreak = row.state === null ? 0 : prior?.state === row.state ? stateStreak + 1 : 1;
    if (prior && row.phase !== prior.phase) {
      segments.push(phaseSegment(rows.slice(segmentStart, index)));
      segmentStart = index;
    }
  }
  if (latest) segments.push(phaseSegment(rows.slice(segmentStart)));
  const latestPhase = latest?.phase ?? null;
  const phaseLengths: number[] = [];
  const successors = new Map<TspMarketPhase | null, number>();
  for (const [index, segment] of segments.entries()) {
    if (latestPhase === null || segment.phase !== latestPhase) continue;
    phaseLengths.push(segment.days);
    const next = segments[index + 1];
    if (next) successors.set(next.phase, (successors.get(next.phase) ?? 0) + 1);
  }
  const allSuccessors = [...successors.values()].reduce((sum, value) => sum + value, 0);
  const recent = rows.slice(-5), recentFirst = recent[0]?.score, recentLast = latest?.score;
  const latestPercentiles = percentileFields.map(field => {
    const value = latest?.[field] ?? null;
    const observations = rows.map(row => row[field]).filter((entry): entry is number => entry !== null);
    return { field, value, observed: observations.length, percentilePct: value === null || observations.length < 20
      ? null : Math.round(100 * observations.filter(entry => entry <= value).length / observations.length) };
  });
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_market_regime_summary" as const, version: TSP_MARKET_REGIME_SUMMARY_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    window: { start: rows[0]?.tradingDate ?? null, end: latest?.tradingDate ?? null, sessions: rows.length, observedStates },
    distribution: [...statesByCount.entries()].sort((left, right) => right[1] - left[1])
      .map(([state, days]) => ({ state, days, pct: round(days / rows.length * 100, 1) })),
    stateSwitches: { count: switches, observedPairs, fraction: observedPairs ? switches / observedPairs : null },
    momentum: latest ? {
      state: latest.state, streak: latest.state === null ? null : stateStreak,
      scoreSlope: recent.length >= 2 && recentFirst != null && recentLast != null ? (recentLast - recentFirst) / (recent.length - 1) : null,
      sessionsSinceLastObservedWeak: lastWeakIndex < 0 ? null : rows.length - 1 - lastWeakIndex,
    } : null,
    latestPercentiles,
    segments,
    currentPhase: latestPhase !== null ? {
      phase: latestPhase, streak: segments.at(-1)!.days, segments: phaseLengths.length,
      averageDays: Math.round(phaseLengths.reduce((sum, value) => sum + value, 0) / phaseLengths.length),
      maxDays: Math.max(...phaseLengths),
      successors: [...successors.entries()].sort((left, right) => right[1] - left[1])
        .map(([phase, transitions]) => ({ phase, transitions, pct: Math.round(100 * transitions / allSuccessors) })),
    } : null,
  };
}

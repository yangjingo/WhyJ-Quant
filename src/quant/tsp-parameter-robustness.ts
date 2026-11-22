import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_PARAMETER_ROBUSTNESS_FORMULA_VERSION = "tsp-parameter-robustness-v1";

export const TSP_PARAMETER_OBJECTIVES = [
  "sortino", "sharpe", "calmar", "annual_return", "total_return", "profit_factor", "max_drawdown",
  "mc_maxdd_p50", "mc_maxdd_p95", "avg_pnl", "median_pnl",
] as const;

type ParameterValue = string | number | boolean | null;
type CandidateStatus = "eligible" | "insufficient-trades" | "unavailable-score" | "failed";

export interface TspParameterValidationWindow {
  start: string;
  end: string;
}

export interface TspParameterSegmentEvidence extends TspParameterValidationWindow {
  objective: number | null;
  tradeCount: number | null;
}

export interface TspParameterCandidateEvidence {
  params: Readonly<Record<string, ParameterValue>>;
  segments: readonly TspParameterSegmentEvidence[];
  failed?: boolean;
  fullWindow?: TspParameterSegmentEvidence;
}

export interface TspParameterRobustnessInput extends TspParameterValidationWindow {
  segmentCount: number;
  objective: typeof TSP_PARAMETER_OBJECTIVES[number];
  direction?: "max" | "min";
  minTradesTotal?: number;
  candidates: readonly TspParameterCandidateEvidence[];
}

const dayMs = 86_400_000;

export function planTspParameterValidation(start: string, end: string, segmentCount: number): TspParameterValidationWindow[] {
  if (!isDailyDate(start) || !isDailyDate(end) || start < "0001-01-01" || start > end ||
    !Number.isInteger(segmentCount) || segmentCount < 2 || segmentCount > 6) {
    throw new RangeError("Invalid parameter validation range or segment count.");
  }
  let cursor = Date.parse(start);
  const span = (Date.parse(end) - cursor) / dayMs + 1;
  if (span < segmentCount * 14) throw new RangeError("Each parameter validation segment requires at least 14 calendar days.");
  const commonDays = Math.floor(span / segmentCount);
  const extraDays = span % segmentCount;
  const windows: TspParameterValidationWindow[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const next = cursor + (commonDays + Number(i < extraDays)) * dayMs;
    windows.push({ start: new Date(cursor).toISOString().slice(0, 10), end: new Date(next - dayMs).toISOString().slice(0, 10) });
    cursor = next;
  }
  return windows;
}

function normalizeSegment(row: TspParameterSegmentEvidence, window: TspParameterValidationWindow): TspParameterSegmentEvidence {
  if (!row || !window || row.start !== window.start || row.end !== window.end ||
    (row.objective !== null && typeof row.objective !== "number") ||
    (row.tradeCount !== null && (!Number.isSafeInteger(row.tradeCount) || row.tradeCount < 0))) {
    throw new RangeError("Parameter evidence must match the exact validation window and contain a valid trade count.");
  }
  return { start: row.start, end: row.end, tradeCount: row.tradeCount,
    objective: Number.isFinite(row.objective) ? row.objective : null };
}

export function summarizeTspRobustObjectives(values: readonly (number | null)[]) {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return { score: null, median: null, worst: null, spread: null };
  const center = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[center]! : sorted[center - 1]! / 2 + sorted[center]! / 2;
  const worst = sorted[0]!;
  return { median, worst, spread: finiteStatistic(sorted.at(-1)! - worst), score: finiteStatistic(0.6 * median + 0.4 * worst) };
}

function segmentChampions(rows: readonly ScoredCandidate[], segmentCount: number) {
  const champions = [];
  const wins = new Map<ScoredCandidate, number>();
  for (let index = 0; index < segmentCount; index++) {
    let best: ScoredCandidate | undefined;
    let bestScore = -Infinity;
    for (const row of rows) {
      const score = row.normalizedObjectives[index];
      if (row.status === "eligible" && score != null && score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    if (!best) continue;
    champions.push({ segment: index, params: best.params, objective: best.segments[index]!.objective });
    wins.set(best, (wins.get(best) ?? 0) + 1);
  }
  const maxCount = Math.max(0, ...wins.values());
  const label = maxCount === 0 ? "no_data" : maxCount === segmentCount ? "unanimous" : maxCount > segmentCount / 2 ? "majority" : "scattered";
  return { label, champions, maxCount };
}

function candidateKey(params: TspParameterCandidateEvidence["params"], names: readonly string[]): string {
  return JSON.stringify(names.map(name => params[name]));
}

function parameterPlateau(
  byKey: ReadonlyMap<string, ScoredCandidate>, best: ScoredCandidate, names: string[], axes: ReadonlyMap<string, Set<ParameterValue>>,
) {
  if (best.score === null || !names.length) return null;
  const neighbors = [];
  for (const name of names) {
    const order = [...axes.get(name)!];
    const position = order.indexOf(best.params[name]!);
    for (const next of [position - 1, position + 1]) {
      if (next < 0 || next >= order.length) continue;
      const row = byKey.get(candidateKey({ ...best.params, [name]: order[next]! }, names));
      if (!row) continue;
      const decay = row.status === "eligible" && row.score !== null ? finiteStatistic(best.score - row.score) : null;
      neighbors.push({ params: row.params, score: row.score, status: row.status, decay });
    }
  }
  const valid = neighbors.filter(row => row.decay !== null);
  if (!valid.length) return { label: "isolated", ratio: null, tolerance: null, validNeighborCount: 0, neighbors };
  const scores = [...byKey.values()].flatMap(row => row.score === null ? [] : [row.score]);
  const scale = Math.max(Math.abs(best.score), finiteStatistic(Math.max(...scores) - Math.min(...scores)));
  const tolerance = 0.05 * scale;
  const ratio = valid.filter(row => row.decay! <= tolerance).length / valid.length;
  const label = ratio >= 0.6 ? "plateau" : ratio > 0 ? "slope" : "peak";
  return { label, ratio: roundDecimalTiesToEven(ratio), tolerance: roundDecimalTiesToEven(tolerance, 6),
    validNeighborCount: valid.length, neighbors };
}

interface ScoredCandidate {
  params: TspParameterCandidateEvidence["params"];
  segments: TspParameterCandidateEvidence["segments"];
  normalizedObjectives: (number | null)[];
  tradesTotal: number;
  status: CandidateStatus;
  score: number | null;
  median: number | null;
  worst: number | null;
  spread: number | null;
  fullWindow?: TspParameterSegmentEvidence;
  degradation: number | null;
  degradationFraction: number | null;
}

const statusTier: Record<CandidateStatus, number> = { eligible: 0, "insufficient-trades": 1, "unavailable-score": 1, failed: 2 };

export function computeTspParameterRobustness(input: TspParameterRobustnessInput) {
  const { objective, direction = "max", minTradesTotal = 30, candidates } = input;
  if (!TSP_PARAMETER_OBJECTIVES.includes(objective) || (direction !== "max" && direction !== "min") ||
    !Number.isSafeInteger(minTradesTotal) || minTradesTotal < 0 ||
    !Array.isArray(candidates) || !candidates.length || candidates.length > 2_000) {
    throw new TypeError("Invalid parameter robustness objective, threshold or candidate count.");
  }
  const windows = planTspParameterValidation(input.start, input.end, input.segmentCount);
  const names = Object.keys(candidates[0]?.params ?? {}).sort();
  const axes = new Map(names.map(name => [name, new Set<ParameterValue>()]));
  const byKey = new Map<string, ScoredCandidate>();
  const sign = direction === "max" ? 1 : -1;
  const normalized = (value: number | null): number | null => value !== null && Number.isFinite(value) ? sign * value : null;

  for (const candidate of candidates as readonly TspParameterCandidateEvidence[]) {
    if (!candidate?.params || typeof candidate.params !== "object" || Array.isArray(candidate.params) ||
      Object.keys(candidate.params).length !== names.length ||
      !Array.isArray(candidate.segments) || candidate.segments.length > windows.length ||
      (!candidate.failed && candidate.segments.length !== windows.length) ||
      (candidate.failed !== undefined && typeof candidate.failed !== "boolean")) {
      throw new TypeError("Each parameter candidate requires matching parameters and segment evidence.");
    }
    for (const name of names) {
      const value = candidate.params[name];
      if (!Object.hasOwn(candidate.params, name) ||
        (value !== null && typeof value !== "boolean" && typeof value !== "string" && !Number.isFinite(value))) {
        throw new TypeError("Invalid parameter candidate value.");
      }
      axes.get(name)!.add(value!);
    }
    const key = candidateKey(candidate.params, names);
    if (byKey.has(key)) throw new RangeError("Duplicate parameter candidate.");
    const segments = Array.from(candidate.segments as readonly TspParameterSegmentEvidence[],
      (row, index) => normalizeSegment(row, windows[index]!));
    const normalizedObjectives = segments.map(row => normalized(row.objective));
    const summary = summarizeTspRobustObjectives(candidate.failed ? [] : normalizedObjectives);
    const tradesTotal = segments.reduce((sum, row) => sum + (row.tradeCount ?? 0), 0);
    if (!Number.isSafeInteger(tradesTotal)) throw new RangeError("Total trade count exceeds the supported range.");
    const status = candidate.failed ? "failed" : summary.score === null ? "unavailable-score"
      : tradesTotal < minTradesTotal ? "insufficient-trades" : "eligible";

    const fullWindow = candidate.fullWindow === undefined ? undefined : normalizeSegment(candidate.fullWindow, input);
    const fullScore = fullWindow ? normalized(fullWindow.objective) : null;
    const degradation = status === "eligible" && fullScore !== null && summary.score !== null
      ? finiteStatistic(fullScore - summary.score) : null;
    const degradationFraction = degradation === null || fullScore === null || fullScore === 0 ? null
      : finiteStatistic(degradation / Math.abs(fullScore));
    byKey.set(key, { params: { ...candidate.params }, segments, normalizedObjectives, tradesTotal,
      status, ...summary, ...(fullWindow && { fullWindow }), degradation, degradationFraction });
  }

  const ordered = [...byKey.values()].sort((a, b) => statusTier[a.status] - statusTier[b.status] ||
    (a.score === b.score ? 0 : (b.score ?? -Infinity) - (a.score ?? -Infinity)));
  const best = ordered.find(row => row.status === "eligible");
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_PARAMETER_ROBUSTNESS_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    objective, direction, minTradesTotal, windows,
    bestParams: best?.params ?? null,
    bestScore: best?.score ?? null,
    convergence: segmentChampions(ordered, windows.length),
    plateau: best ? parameterPlateau(byKey, best, names, axes) : null,
    results: ordered.map((row, index) => ({ rank: index + 1, ...row })),
  };
}

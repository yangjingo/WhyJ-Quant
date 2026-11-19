import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspMarketState } from "./tsp-market-regime.ts";

export const TSP_MARKET_PHASE_FORMULA_VERSION = 1;
export type TspMarketPhaseMode = "causal" | "retrospective-tsp";
export type TspMarketPhase = "ice" | "ignite" | "rally" | "climax" | "ebb" | "repair";

const countFields = ["height", "firstBoardCount", "twoOrMoreCount"] as const;
const fractionFields = ["promotionFraction", "sealFraction"] as const;
const driverFields = [...countFields, ...fractionFields] as const;
type Driver = typeof driverFields[number];

export type TspMarketPhaseInput = { tradingDate: string; state?: TspMarketState | null } & Record<Driver, number | null>;

const alpha = 1 / 3;
const states = new Set<TspMarketState>(["strong", "lean_strong", "range", "lean_weak", "weak"]);
const positivePhases = new Set<TspMarketPhase>(["ignite", "rally", "climax"]);

type SmoothedDriver = {
  value: number | null;
  sourceDate: string | null;
  basis: "observed" | "carry-forward" | "later-observation" | "zero-default" | "unavailable";
};

function smooth(rows: readonly TspMarketPhaseInput[], key: Driver, mode: TspMarketPhaseMode): SmoothedDriver[] {
  const seed = mode === "retrospective-tsp" ? rows.find(row => row[key] !== null) : undefined;
  let current: number | null = null;
  let sourceDate: string | null = null;
  return rows.map(row => {
    const value = row[key];
    if (value !== null) {
      current = current === null ? value : current + alpha * (value - current);
      sourceDate = row.tradingDate;
      return { value: current, sourceDate, basis: "observed" };
    }
    if (current !== null) return { value: current, sourceDate, basis: "carry-forward" };
    if (seed) return { value: seed[key], sourceDate: seed.tradingDate, basis: "later-observation" };
    return mode === "retrospective-tsp" ? { value: 0, sourceDate: null, basis: "zero-default" }
      : { value: null, sourceDate: null, basis: "unavailable" };
  });
}

function candidateFor(height: number, first: number, width: number, promotion: number, seal: number,
  previousHeight: number, previousWidth: number): TspMarketPhase {
  if (width >= 50 || first >= 220) return "climax";
  if ((height >= 7 && width >= 15 && promotion >= 0.23) || (height >= 5 && width >= 12 && promotion >= 0.30)) return "rally";
  if (height <= 4 && width <= 6 && first <= 24) return "ice";
  const previouslyHigh = previousWidth >= 12 || previousHeight >= 6;
  if ((previouslyHigh && promotion <= 0.15 && width < previousWidth) || (promotion <= 0.13 && seal <= 0.57)) return "ebb";
  if ((width >= 8 && width - previousWidth >= 3 && promotion >= 0.20) ||
    (height >= 5 && height - previousHeight >= 1 && promotion >= 0.19)) return "ignite";
  return "repair";
}

/** Apply the pinned phase rules to explicitly supplied market sessions. */
export function computeTspMarketPhaseSeries(input: readonly TspMarketPhaseInput[], mode: TspMarketPhaseMode = "causal") {
  if (mode !== "causal" && mode !== "retrospective-tsp") throw new Error("Invalid market phase mode");
  const dates = new Set<string>();
  for (const row of input) {
    if (typeof row.tradingDate !== "string" || !isDailyDate(row.tradingDate) || dates.has(row.tradingDate) ||
      (row.state != null && !states.has(row.state))) throw new Error("Invalid or duplicate market phase session");
    dates.add(row.tradingDate);
    for (const key of countFields) {
      const value = row[key];
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid market phase count: ${key}`);
    }
    for (const key of fractionFields) {
      const value = row[key];
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`Invalid market phase fraction: ${key}`);
    }
  }

  const ordered = [...input].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  const drivers = Object.fromEntries(driverFields.map(field => [field, smooth(ordered, field, mode)])) as Record<Driver, SmoothedDriver[]>;
  let confirmed: TspMarketPhase | null = null;
  let pending: TspMarketPhase | null = null;
  const rows = ordered.map(({ tradingDate, state }, index) => {
    const smoothed = Object.fromEntries(driverFields.map(field => [field, drivers[field][index]!])) as Record<Driver, SmoothedDriver>;
    const baselineIndex = Math.max(0, index - 5);
    const earlierHeight = drivers.height[baselineIndex]!.value, earlierWidth = drivers.twoOrMoreCount[baselineIndex]!.value;
    const [height, first, width, promotion, seal] = driverFields.map(field => smoothed[field].value);
    const futureFields = driverFields.filter(field => smoothed[field].basis === "later-observation");
    const hasLadder = countFields.some(field => smoothed[field].sourceDate !== null);
    let candidate: TspMarketPhase | null = null;
    let vetoed = false;
    if (hasLadder && height != null && first != null && width != null && promotion != null && seal != null &&
      earlierHeight !== null && earlierWidth !== null) {
      candidate = candidateFor(height, first, width, promotion, seal, earlierHeight, earlierWidth);
      vetoed = (state === "weak" || state === "lean_weak") && positivePhases.has(candidate);
      if (vetoed) candidate = "repair";
    }

    if (candidate === null || confirmed === null || candidate === confirmed || candidate === pending) {
      confirmed = candidate;
      pending = null;
    } else pending = candidate;

    return { tradingDate, phase: confirmed, candidate, vetoed, state: state ?? null, smoothed, futureFields,
      comparison: { tradingDate: ordered[baselineIndex]!.tradingDate, height: earlierHeight, twoOrMoreCount: earlierWidth } };
  });
  return { producer: "whyj" as const,
    formula: { id: "tsp_market_phase" as const, version: TSP_MARKET_PHASE_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION }, mode, rows };
}

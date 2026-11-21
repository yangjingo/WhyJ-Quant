import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, mean, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_WALK_FORWARD_FORMULA_VERSION = "tsp-walk-forward-v1";

export interface TspWalkForwardSchedule {
  start: string;
  end: string;
  trainDays: number;
  testDays: number;
  stepDays: number;
}

export interface TspWalkForwardWindow {
  index: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
}

export interface TspWalkForwardFoldEvidence {
  window: TspWalkForwardWindow;
  training: { candidateId: string; objective: number | null } | null;
  heldOut: { candidateId: string; objective: number | null; totalReturn: number; tradeCount: number } | null;
}

export interface TspWalkForwardInput extends TspWalkForwardSchedule {
  objective: string;
  direction: "min" | "max";
  minHeldOutTrades?: number;
  folds: readonly TspWalkForwardFoldEvidence[];
}

const dayMilliseconds = 86_400_000;

function calendarDate(day: number): string {
  return new Date(day * dayMilliseconds).toISOString().slice(0, 10);
}

export function planTspWalkForward(schedule: TspWalkForwardSchedule): TspWalkForwardWindow[] {
  const { start, end, trainDays, testDays, stepDays } = schedule;
  if (!isDailyDate(start) || !isDailyDate(end) || start < "0001-01-01" || end < start ||
    ![trainDays, testDays, stepDays].every(days => Number.isSafeInteger(days) && days > 0)) {
    throw new RangeError("Invalid walk-forward calendar range or window length.");
  }
  const first = Date.parse(start) / dayMilliseconds;
  const final = Date.parse(end) / dayMilliseconds;
  const offset = trainDays + 1 + testDays;
  if (offset > final - first) throw new RangeError("Walk-forward calendar range has no complete test window.");
  const windows: TspWalkForwardWindow[] = [];
  for (let day = first; day <= final - offset; day += stepDays) {
    const trainEnd = day + trainDays;
    windows.push({ index: windows.length, trainStart: calendarDate(day), trainEnd: calendarDate(trainEnd),
      testStart: calendarDate(trainEnd + 1), testEnd: calendarDate(day + offset) });
  }
  return windows;
}

function validSelection(value: { candidateId: string; objective: number | null }): boolean {
  return typeof value?.candidateId === "string" && value.candidateId.trim().length > 0 &&
    (value.objective === null || Number.isFinite(value.objective));
}

export function computeTspWalkForward(input: TspWalkForwardInput) {
  const { objective, direction, minHeldOutTrades = 10, folds } = input;
  if (typeof objective !== "string" || !objective.trim() || (direction !== "min" && direction !== "max") ||
    !Number.isSafeInteger(minHeldOutTrades) || minHeldOutTrades < 0 || !Array.isArray(folds)) {
    throw new TypeError("Invalid walk-forward evidence scope.");
  }
  const windows = planTspWalkForward(input);
  const evidence = new Map<number, TspWalkForwardFoldEvidence>();
  for (const fold of folds as readonly TspWalkForwardFoldEvidence[]) {
    const index = fold?.window?.index;
    const window = Number.isSafeInteger(index) ? windows[index] : undefined;
    if (!window || evidence.has(index) || fold.window.trainStart !== window.trainStart ||
      fold.window.trainEnd !== window.trainEnd || fold.window.testStart !== window.testStart ||
      fold.window.testEnd !== window.testEnd) {
      throw new RangeError("Walk-forward fold must match a unique planned window.");
    }
    const { training, heldOut } = fold;
    if (training !== null && !validSelection(training)) throw new TypeError("Invalid training selection.");
    if (heldOut !== null && (!validSelection(heldOut) || heldOut.candidateId !== training?.candidateId ||
      !Number.isFinite(heldOut.totalReturn) || heldOut.totalReturn < -1 ||
      !Number.isSafeInteger(heldOut.tradeCount) || heldOut.tradeCount < 0)) {
      throw new TypeError("Held-out evidence must match the training selection and contain a valid return and trade count.");
    }
    evidence.set(index, fold);
  }

  const skipped: { window: TspWalkForwardWindow; reason: "missing-training" | "missing-held-out" | "insufficient-held-out-trades" }[] = [];
  const valid: { window: TspWalkForwardWindow; candidateId: string; trainObjective: number | null;
    heldOutObjective: number | null; heldOutReturn: number; heldOutTrades: number; degraded: boolean | null }[] = [];
  const isValues: number[] = [];
  const oosValues: number[] = [];
  const equityCurve: { fold: number; date: string; value: number }[] = [];
  let equity = 1;
  let positive = 0;
  let overlappingTestWindows = false;
  let previousTestEnd: string | undefined;
  const sign = direction === "max" ? 1 : -1;
  for (const window of windows) {
    const fold = evidence.get(window.index);
    const training = fold?.training;
    const heldOut = fold?.heldOut;
    if (!training) {
      skipped.push({ window, reason: "missing-training" });
      continue;
    }
    if (!heldOut || heldOut.tradeCount < minHeldOutTrades) {
      skipped.push({ window, reason: heldOut ? "insufficient-held-out-trades" : "missing-held-out" });
      continue;
    }

    if (previousTestEnd !== undefined && window.testStart <= previousTestEnd) overlappingTestWindows = true;
    previousTestEnd = window.testEnd;
    equity = finiteStatistic(equity * (1 + heldOut.totalReturn));
    if (heldOut.totalReturn > 0) positive++;
    equityCurve.push({ fold: window.index, date: window.testEnd, value: roundDecimalTiesToEven(equity) });
    if (training.objective !== null) isValues.push(training.objective);
    if (heldOut.objective !== null) oosValues.push(heldOut.objective);
    valid.push({ window, candidateId: training.candidateId, trainObjective: training.objective,
      heldOutObjective: heldOut.objective, heldOutReturn: heldOut.totalReturn, heldOutTrades: heldOut.tradeCount,
      degraded: training.objective === null || heldOut.objective === null ? null : sign * training.objective > sign * heldOut.objective });
  }

  const averageTrainObjective = isValues.length ? roundDecimalTiesToEven(mean(isValues)) : null;
  const averageHeldOutObjective = oosValues.length ? roundDecimalTiesToEven(mean(oosValues)) : null;
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_WALK_FORWARD_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    objective,
    direction,
    minHeldOutTrades,
    plannedFoldCount: windows.length,
    validFoldCount: valid.length,
    skippedFoldCount: skipped.length,
    overlappingTestWindows,
    folds: valid,
    skipped,
    summary: {
      averageTrainObjective,
      averageHeldOutObjective,
      degradation: averageTrainObjective === null || averageHeldOutObjective === null ? null
        : roundDecimalTiesToEven(sign * (averageTrainObjective - averageHeldOutObjective)),
      compoundedHeldOutReturn: roundDecimalTiesToEven(equity - 1),
      profitableFoldShare: valid.length ? roundDecimalTiesToEven(positive / valid.length) : 0,
      equityCurve,
    },
  };
}
import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_MINING_VALIDATION_FORMULA_VERSION = "tsp-mining-validation-v1";

const balanced = {
  outerTrainBars: 504, outerTestBars: 126, outerStepBars: 63,
  innerTrainBars: 252, innerTestBars: 63, innerStepBars: 63,
  purgeBars: 30, embargoBars: 5, minTrainBars: 126,
};
const profiles = {
  exploratory: { ...balanced, outerTrainBars: 126, outerTestBars: 63, outerStepBars: 63,
    innerTrainBars: 63, innerTestBars: 21, innerStepBars: 21, minTrainBars: 63 },
  balanced,
  strict: { ...balanced, outerTrainBars: 756, outerStepBars: 126, innerTrainBars: 504 },
};

export interface TspMiningValidationInput {
  assetType: "stock" | "etf";
  profile: keyof typeof profiles;
  /** Sorted unique trading dates with enriched data for the chosen asset type. */
  availableDates: readonly string[];
  start?: string | null;
  end?: string | null;
}

function splitFold(
  dates: readonly string[], start: number, trainBars: number, testBars: number,
  { purgeBars, embargoBars }: Pick<typeof balanced, "purgeBars" | "embargoBars">, hardStop: number,
) {
  const trainStop = start + trainBars;
  const testStart = trainStop + purgeBars;
  const testStop = testStart + testBars;
  return {
    train: dates.slice(start, trainStop),
    purge: dates.slice(trainStop, testStart),
    test: dates.slice(testStart, testStop),
    embargo: dates.slice(testStop, Math.min(hardStop, testStop + embargoBars)),
  };
}

export function planTspMiningValidation(input: TspMiningValidationInput) {
  const { assetType, profile, availableDates, start = null, end = null } = input;
  const validDate = (date: unknown): date is string => typeof date === "string" && date >= "0001-01-01" && isDailyDate(date);
  if ((assetType !== "stock" && assetType !== "etf") || typeof profile !== "string" || !Object.hasOwn(profiles, profile) ||
    !Array.isArray(availableDates) || (start !== null && !validDate(start)) || (end !== null && !validDate(end)) ||
    (start !== null && end !== null && start > end) ||
    Array.from(availableDates).some((date, i) => !validDate(date) || (i > 0 && date <= availableDates[i - 1]!))) {
    throw new Error("Invalid mining validation date evidence");
  }
  const config = { ...profiles[profile] };
  const throughEnd = availableDates.filter(date => end === null || date <= end);
  const scoped = throughEnd.filter(date => start === null || date >= start);
  const oneOuter = config.outerTrainBars + config.purgeBars + config.outerTestBars;
  const oneInner = config.innerTrainBars + config.purgeBars + config.innerTestBars;
  const requiredOuterFolds = profile === "exploratory" ? 1 : 3;
  const requiredBars = oneOuter + (requiredOuterFolds - 1) * config.outerStepBars;
  const folds = [];
  for (let outerStart = 0; outerStart + oneOuter <= scoped.length; outerStart += config.outerStepBars) {
    const outerIndex: number = folds.length;
    const outerTrainStop = outerStart + config.outerTrainBars;
    const outer = { outerIndex, ...splitFold(scoped, outerStart, config.outerTrainBars, config.outerTestBars, config, scoped.length) };
    const inner = [];
    for (let innerStart = outerStart; innerStart + oneInner <= outerTrainStop; innerStart += config.innerStepBars) {
      inner.push({ outerIndex, innerIndex: inner.length,
        ...splitFold(scoped, innerStart, config.innerTrainBars, config.innerTestBars, config, outerTrainStop) });
    }
    folds.push({ outer, inner });
  }
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_MINING_VALIDATION_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    assetType, profile, config,
    scope: { start, end },
    availability: {
      tradingBars: scoped.length, requiredBars, outerFolds: folds.length, requiredOuterFolds,
      eligible: scoped.length >= requiredBars,
      availableStart: availableDates[0] ?? null, availableEnd: availableDates.at(-1) ?? null,
      effectiveStart: scoped[0] ?? null, effectiveEnd: scoped.at(-1) ?? null,
      suggestedStart: throughEnd.at(-requiredBars) ?? null,
    },
    folds,
  };
}

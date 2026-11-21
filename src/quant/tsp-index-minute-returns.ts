import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_INDEX_MINUTE_RETURN_FORMULA_VERSION = "tsp-index-minute-return-v1";

export interface TspIndexMinutePrice {
  sourceTimestamp: number;
  closePoints: number;
}

function positivePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Keeps provider labels and derives the chart's fractional change only when a previous close is supplied. */
export function computeTspIndexMinuteReturns(prices: readonly TspIndexMinutePrice[], previousClosePoints: number | null) {
  if (!Array.isArray(prices) || (previousClosePoints !== null && !positivePrice(previousClosePoints))) {
    throw new TypeError("Invalid index minute prices or previous close.");
  }
  let previousTimestamp = 0;
  const points = Array.from(prices as readonly TspIndexMinutePrice[], row => {
    if (!row || !Number.isSafeInteger(row.sourceTimestamp) || row.sourceTimestamp <= previousTimestamp ||
      row.sourceTimestamp > 8_640_000_000_000_000 || !positivePrice(row.closePoints)) {
      throw new RangeError("Index minute prices require positive closes and strictly increasing timestamps.");
    }
    previousTimestamp = row.sourceTimestamp;
    return { sourceTimestamp: row.sourceTimestamp,
      returnFraction: previousClosePoints === null ? null : finiteStatistic(row.closePoints / previousClosePoints - 1) };
  });
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_INDEX_MINUTE_RETURN_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    returnUnit: "fraction" as const,
    previousClosePoints,
    points,
  };
}
import { TSP_DEVIATION_WINDOWS, type TspDeviationBoard, type TspPriceDeviationRow } from "./tsp-price-deviation.ts";

export const TSP_DEVIATION_PROXIMITY_FORMULA_VERSION = 1;

const shortThresholds = { SH: 0.20, SZ: 0.20, GEM: 0.30, STAR: 0.30, BJ: 0.40 } as const;
const longThresholds = { 10: { up: 1, down: 0.50 }, 30: { up: 2, down: 0.70 } } as const;
type Window = typeof TSP_DEVIATION_WINDOWS[number];
type Tier = "unavailable" | "below-watch" | "watch" | "edge" | "triggered";

interface ProximityWindow {
  window: Window;
  deviation: number | null;
  direction: "up" | "down" | null;
  threshold: number | null;
  closeness: number | null;
}

/** Apply the pinned TSP analytical threshold profile to completed-session deviation fractions. */
export function computeTspDeviationProximity(board: TspDeviationBoard, values: TspPriceDeviationRow["values"]) {
  if (!Object.hasOwn(shortThresholds, board)) throw new Error("Invalid TSP deviation board");
  let dominantWindow: Window | null = null;
  let maxCloseness: number | null = null;
  const windows: ProximityWindow[] = [];
  for (const window of TSP_DEVIATION_WINDOWS) {
    const deviation = values[`deviate_${window}d`];
    if (deviation === null) {
      windows.push({ window, deviation, direction: null, threshold: null, closeness: null });
      continue;
    }
    if (!Number.isFinite(deviation)) throw new Error("Invalid TSP deviation proximity input");
    const direction = deviation >= 0 ? "up" : "down";
    const threshold = window === 3 ? shortThresholds[board] : longThresholds[window][direction];
    const closeness = Math.abs(deviation) / threshold;
    if (!Number.isFinite(closeness)) throw new Error("TSP deviation proximity overflow");
    if (maxCloseness === null || closeness > maxCloseness) {
      dominantWindow = window;
      maxCloseness = closeness;
    }
    windows.push({ window, deviation, direction, threshold, closeness });
  }
  const tier: Tier = maxCloseness === null ? "unavailable" : maxCloseness >= 1 ? "triggered" : maxCloseness >= 0.7 ? "edge"
    : maxCloseness >= 0.5 ? "watch" : "below-watch";
  return { windows, dominantWindow, maxCloseness, tier };
}

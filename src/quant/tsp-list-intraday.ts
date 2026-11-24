import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { tspMinuteIndex, type TspCompletedMinuteBar } from "./tsp-intraday.ts";

export const TSP_LIST_INTRADAY_FORMULA_VERSION = 1;

export interface TspListIntradayInput {
  tradeDate: string;
  bars: readonly Pick<TspCompletedMinuteBar, "tradingDate" | "minute" | "open" | "close">[];
  previousClose: number | null;
  /** A supplied return must refer to the same last observed close. */
  sameCloseChangeFraction?: number | null;
}

export function computeTspListIntraday(input: TspListIntradayInput) {
  const { tradeDate, bars, previousClose, sameCloseChangeFraction = null } = input;
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !Array.isArray(bars) ||
    (previousClose !== null && (!Number.isFinite(previousClose) || previousClose <= 0)) ||
    (sameCloseChangeFraction !== null && (!Number.isFinite(sameCloseChangeFraction) || sameCloseChangeFraction <= -1))) {
    throw new Error("Invalid stock-list intraday chart inputs");
  }

  const observations = bars as TspListIntradayInput["bars"];
  let previousSlot = -1, runningClose = 0;
  const points = observations.map((bar, i) => {
    const slot = typeof bar?.minute === "string" ? tspMinuteIndex(bar.minute) : -1;
    if (slot <= previousSlot || bar.tradingDate !== tradeDate || !Number.isFinite(bar.close) || bar.close <= 0 ||
      (bar.open !== null && (!Number.isFinite(bar.open) || bar.open <= 0))) {
      throw new Error("Invalid or unordered stock-list intraday observation");
    }
    previousSlot = slot;
    runningClose = finiteStatistic(runningClose + bar.close);
    return { minute: bar.minute, close: bar.close, averageClose: runningClose / (i + 1),
      previousCloseReturnFraction: previousClose === null ? null : finiteStatistic(bar.close / previousClose - 1) };
  });

  const first = observations[0], last = points.at(-1);
  let plotBaseline: { kind: "previous-close" | "implied-from-last-return" | "first-observed-open" | "first-observed-close"; value: number } | null = null;
  if (first && last) {
    if (previousClose !== null) plotBaseline = { kind: "previous-close", value: previousClose };
    else if (sameCloseChangeFraction !== null && sameCloseChangeFraction !== 0) {
      plotBaseline = { kind: "implied-from-last-return", value: finiteStatistic(last.close / (1 + sameCloseChangeFraction)) };
    } else {
      plotBaseline = { kind: first.open === null ? "first-observed-close" : "first-observed-open", value: first.open ?? first.close };
    }
  }
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_list_intraday" as const, version: TSP_LIST_INTRADAY_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradeDate, plotBaseline,
    latestReturnFraction: last?.previousCloseReturnFraction ?? null,
    points,
  };
}

import { createHash } from "node:crypto";
import {
  computeTspIntradaySignal, parseTspIntradaySignalRule, TSP_INDICATOR_REVISION, TSP_INTRADAY_SIGNAL_FORMULA_VERSION,
  type TspIntradaySignalRule,
} from "../../quant/index.ts";
import type { HistoricalMinuteArchiveRef } from "../../storage/index.ts";
import { deriveTspArchiveIntraday, type IntradayReplayOptions } from "./intraday-replay.ts";

/** Emit completed-minute trigger evidence from fixed inputs without writing delivery state. */
export async function replayTspIntradaySignal(
  ref: HistoricalMinuteArchiveRef,
  request: TspIntradaySignalRule,
  options: IntradayReplayOptions = {},
) {
  const rule = parseTspIntradaySignalRule(request);
  const replay = await deriveTspArchiveIntraday(ref, options);
  options.signal?.throwIfAborted();
  const formula = { id: "tsp_intraday_custom_signal" as const, version: TSP_INTRADAY_SIGNAL_FORMULA_VERSION,
    revision: TSP_INDICATOR_REVISION };
  const ruleRevision = createHash("sha256").update(JSON.stringify([formula, replay.formula, rule])).digest("hex");
  const dates = new Set<string>();
  const events = computeTspIntradaySignal(replay.rows, rule).flatMap((row, index) => {
    dates.add(row.tradingDate);
    if (!row.triggered) return [];
    const { tradingDate, minute } = row;
    const { originalTradeTime, values } = replay.rows[index]!;
    const symbol = replay.input.symbol;
    const eventId = createHash("sha256").update(JSON.stringify([ruleRevision, symbol, tradingDate, minute])).digest("hex");
    return [{ eventId, symbol, tradingDate, minute, originalTradeTime, values }];
  });
  return {
    producer: "whyj" as const, formula, featureFormula: replay.formula,
    rule, ruleRevision, archiveRef: replay.archiveRef, input: replay.input,
    coverage: { completedBars: replay.rows.length, tradingDays: dates.size, openingBoundaries: replay.openingBoundaries.length },
    events,
  };
}

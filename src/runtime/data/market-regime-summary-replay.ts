import { summarizeTspMarketRegime } from "../../quant/index.ts";
import { replayTspMarketEnvironment, type MarketEnvironmentReplayRequest } from "./market-environment-replay.ts";
import { replayTspMarketMainline, type MarketMainlineReplayRequest } from "./market-mainline-replay.ts";

export interface MarketRegimeSummaryReplayRequest extends MarketEnvironmentReplayRequest {
  window?: { start: string; end: string };
  concepts?: Pick<MarketMainlineReplayRequest, "sectorHistory" | "filter">;
}

/** Keep the warmup calendar and archive evidence, then summarize the explicit display window. */
export async function replayTspMarketRegimeSummary(request: MarketRegimeSummaryReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { window, concepts, ...environment } = structuredClone(request);
  const first = window ? environment.sessions.indexOf(window.start) : 0;
  const last = window ? environment.sessions.indexOf(window.end) : environment.sessions.length - 1;
  if (window && (first < 0 || last < first)) throw new Error("Invalid market regime display window");

  const history = await replayTspMarketEnvironment(environment, signal);
  const mainline = concepts ? await replayTspMarketMainline({
    sessions: environment.sessions, marketRefs: environment.marketRefs, limitRefs: environment.limitRefs,
    riskWarningRefs: environment.riskWarningRefs, sectorHistory: concepts.sectorHistory, filter: concepts.filter,
  }, signal) : null;
  if (mainline?.scope && mainline.scope.kind !== "concept") throw new Error("Market regime summary requires concept mainlines");
  const byDate = new Map(mainline?.rows.map(row => [row.tradingDate, row.mainline?.rows ?? null]));
  const summary = summarizeTspMarketRegime(history.rows.slice(first, last + 1).map(({ tradingDate, regime, ladder, phase }) => ({
    tradingDate, state: regime?.state ?? null, score: regime?.score ?? null, phase: phase.phase,
    height: ladder?.ladder?.height ?? null, firstBoardCount: ladder?.ladder?.firstBoardCount ?? null,
    twoOrMoreCount: ladder?.ladder?.twoOrMoreCount ?? null, ladderCompletenessFraction: ladder?.ladder?.completeness ?? null,
    promotionFraction: ladder?.promotion.fraction ?? null,
    sealFraction: ladder?.seal.fraction ?? ladder?.seal.regimeFraction ?? null,
    conceptRanks: byDate.get(tradingDate) ?? null,
  })));
  signal?.throwIfAborted();
  return { summary, history, mainline };
}

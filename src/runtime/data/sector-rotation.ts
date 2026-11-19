import { computeTspSectorRotation } from "../../quant/index.ts";
import { replayTspSectorRanking, type SectorRankReplayRequest } from "./sector-rank-replay.ts";

/** Replay explicitly supplied sessions using only fixed local market and sector evidence. */
export async function replayTspSectorRotation(requests: readonly SectorRankReplayRequest[], days = 12, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const captured = requests.map(({ marketRef, catalogRef, memberRefs }) => ({
    marketRef: { ...marketRef }, catalogRef: { ...catalogRef }, memberRefs: memberRefs.map(ref => ({ ...ref })),
  }));
  const ranked = [];
  for (const request of captured) {
    ranked.push(await replayTspSectorRanking(request, signal));
  }
  signal?.throwIfAborted();
  const rotation = computeTspSectorRotation(ranked, days);
  const evidence = new Map(ranked.map(day => [day.tradingDate, day.input]));
  return { ...rotation, input: { sessions: rotation.input.sessions.map(session => ({
    ...session, archives: evidence.get(session.tradingDate)!,
  })) } };
}

import { computeTspMarketMainline, type TspMainlineFilter } from "../../quant/index.ts";
import { projectMarketLadderReplay, type MarketLadderReplayRequest } from "./market-ladder-replay.ts";
import { loadDatedSectorMembership, type SectorRankReplayRequest } from "./sector-rank-replay.ts";

export interface MarketMainlineReplayRequest extends MarketLadderReplayRequest {
  sectorHistory: readonly ({ tradeDate: string } & Pick<SectorRankReplayRequest, "catalogRef" | "memberRefs">)[];
  filter?: TspMainlineFilter;
}

/** Replay industry or concept mainlines with the same stock histories used by the exchange ladder. */
export async function replayTspMarketMainline(request: MarketMainlineReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const dates = new Set(request.sessions);
  const sectorByDate = new Map<string, Pick<SectorRankReplayRequest, "catalogRef" | "memberRefs">>();
  for (const { tradeDate, catalogRef, memberRefs } of request.sectorHistory) {
    if (!dates.has(tradeDate) || sectorByDate.has(tradeDate)) throw new Error("Duplicate or off-calendar market mainline sector input");
    sectorByDate.set(tradeDate, { catalogRef: { ...catalogRef }, memberRefs: memberRefs.map(ref => ({ ...ref })) });
  }
  const filter = { ...request.filter, blacklist: [...(request.filter?.blacklist ?? [])] };
  const scopeEvidence: { scope: { kind: "industry" | "concept"; taxonomy: string; source: string } | null } = { scope: null };
  const replay = await projectMarketLadderReplay(request, async ({ tradingDate, market, universe, observations, riskWarnings }) => {
    const sector = sectorByDate.get(tradingDate);
    const dated = sector && await loadDatedSectorMembership({ tradeDate: tradingDate, market: "A", source: "tushare" }, sector, signal);
    if (dated) {
      const { kind, taxonomy, source } = dated.membership;
      const { scope } = scopeEvidence;
      if (scope && (scope.kind !== kind || scope.taxonomy !== taxonomy || scope.source !== source)) {
        throw new Error("Incompatible market mainline sector scope");
      }
      scopeEvidence.scope ??= { kind, taxonomy, source };
    }
    const input = { market, sector: dated?.evidence ?? null, ...(riskWarnings ? { riskWarnings } : {}) };
    if (!market) return { tradingDate, status: "missing-market" as const, input, mainline: null };
    if (!universe) return { tradingDate, status: "missing-risk-warnings" as const, input, mainline: null };
    if (!dated || (dated.evidence.coverage.catalogGroups > 0 && dated.evidence.coverage.archivedGroups === 0)) {
      return { tradingDate, status: "missing-membership" as const, input, mainline: null };
    }
    return { tradingDate, status: "computed" as const, input,
      mainline: computeTspMarketMainline({ universe, observations, membership: dated.membership }, filter),
    };
  }, signal);
  return { producer: "whyj" as const, ...scopeEvidence, ...replay };
}

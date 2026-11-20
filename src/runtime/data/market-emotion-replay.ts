import { computeTspDashboardEmotion, TSP_DASHBOARD_CORE_INDICES, type TspDashboardEmotionInput } from "../../quant/index.ts";
import { loadBenchmarkIndexArchive, loadMarketCrossSectionArchive,
  type BenchmarkIndexArchiveRef, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";
import { loadMarketBreadthHistory } from "./market-breadth-history.ts";
import { readMarketAdjustedPriceArchives } from "./market-environment-replay.ts";
import { projectMarketLadderReplay, type MarketLadderReplayRequest } from "./market-ladder-replay.ts";
import { loadDatedSectorMembership, type SectorRankReplayRequest } from "./sector-rank-replay.ts";

type SectorArchives = Pick<SectorRankReplayRequest, "catalogRef" | "memberRefs">;

export interface MarketEmotionReplayRequest extends MarketLadderReplayRequest {
  /** Forward-adjusted stock archives ending on the final session in the calendar. */
  priceRefs: readonly TradingDateArchiveRef[];
  /** At most one point-pair archive per core index, covering the final session. */
  indexRefs: readonly BenchmarkIndexArchiveRef[];
  sectors?: { concept?: SectorArchives; industry?: SectorArchives };
}

async function loadCoreIndices(tradeDate: string, refs: readonly BenchmarkIndexArchiveRef[], signal?: AbortSignal) {
  if (refs.length > TSP_DASHBOARD_CORE_INDICES.length) throw new Error("Too many market emotion core index archives");
  const seen = new Set<string>();
  const indices: TspDashboardEmotionInput["indices"][number][] = [];
  const evidence = [];
  for (const ref of refs) {
    const { rows, ...capture } = await loadBenchmarkIndexArchive(ref, signal);
    const symbol = TSP_DASHBOARD_CORE_INDICES.find(symbol => symbol === capture.symbol);
    if (!symbol || seen.has(symbol) || tradeDate < capture.requested.start || tradeDate > capture.requested.end) {
      throw new Error("Duplicate or unrelated market emotion core index archive");
    }
    seen.add(symbol);
    const row = rows.find(row => row.tradeDate === tradeDate) ?? null;
    if (row) {
      const { closePoints, previousClosePoints } = row;
      const returnPct = previousClosePoints === null ? null : (closePoints - previousClosePoints) / previousClosePoints * 100;
      indices.push({ tradingDate: tradeDate, symbol, returnPct });
    }
    evidence.push({ ref, ...capture, row });
  }
  return { indices, evidence };
}

/** Bind the six-dimensional dashboard formula to the final exact session and its archive evidence. */
export async function replayTspMarketEmotion(request: MarketEmotionReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sessions = [...request.sessions];
  const target = sessions.at(-1);
  if (!target) throw new Error("Market emotion replay requires a target exchange session");
  const priceRefs = request.priceRefs.map(ref => ({ ...ref }));
  const indexRefs = request.indexRefs.map(ref => ({ ...ref }));
  const sectorRefs = (["concept", "industry"] as const).flatMap(kind => {
    const refs = request.sectors?.[kind];
    return refs ? [{ kind, catalogRef: { ...refs.catalogRef }, memberRefs: refs.memberRefs.map(ref => ({ ...ref })) }] : [];
  });
  const volumeDates = new Set(sessions.slice(-6, -1));
  const volumeRefs: MarketCrossSectionArchiveRef[] = [];
  const replay = await projectMarketLadderReplay({ ...request, sessions },
    async ({ tradingDate, previousTradingDate, market, universe, observations, riskWarnings }) => {
      if (tradingDate !== target) {
        if (market && volumeDates.has(tradingDate)) volumeRefs.push(market.ref);
        return null;
      }
      const index = await loadCoreIndices(tradingDate, indexRefs, signal);
      const sectors: NonNullable<TspDashboardEmotionInput["sectors"]> = {};
      const sectorEvidence = [];
      for (const { kind, ...refs } of sectorRefs) {
        const { membership, evidence } = await loadDatedSectorMembership({ tradeDate: tradingDate, source: "tushare", market: "A" }, refs, signal);
        if (membership.kind !== kind) throw new Error("Incompatible market emotion sector kind");
        sectors[kind] = membership;
        sectorEvidence.push({ kind, ...evidence });
      }
      const input = { market, indices: index.evidence, sectors: sectorEvidence, ...(riskWarnings ? { riskWarnings } : {}) };
      if (!market || !universe) return { status: !market ? "missing-market" as const : "missing-risk-warnings" as const,
        input: { ...input, prices: [], volumes: [] }, dashboard: null };
      const snapshot = await loadMarketCrossSectionArchive(market.ref, signal);
      const roster = new Set(snapshot.universe.members.map(member => member.symbol));
      const bars = new Map(snapshot.bars.rows.filter(row => roster.has(row.symbol)).map(row => [row.symbol, row]));
      const matched = new Set(bars.keys());
      const changes = new Map<string, number>();
      const prices = [];
      for await (const { archiveRef, records, last } of readMarketAdjustedPriceArchives(tradingDate, matched, priceRefs, signal)) {
        const prior = records.at(-2);
        const adjacent = prior !== undefined && prior.tradeDate === previousTradingDate;
        if (adjacent) changes.set(last.symbol, last.values.close / prior.values.close - 1);
        const { symbol, source, endpoint, observedAt, coverage, adjustment } = last;
        prices.push({ archiveRef, symbol, source, endpoint, observedAt, coverage, adjustment,
          previousBarDate: prior?.tradeDate ?? null, adjacent });
      }
      const { ratios, evidence } = await loadMarketBreadthHistory(snapshot, { priceArchives: [], volumeArchives: volumeRefs }, signal);
      const stocks = observations.flatMap(row => {
        const bar = bars.get(row.symbol);
        if (!bar) return [];
        return [{ ...row, close: bar.close, changeFraction: changes.get(row.symbol) ?? null,
          volumeShares: bar.volume === null ? null : bar.volume * 100, volumeRatio5d: ratios.get(row.symbol) ?? null }];
      });
      return { status: "computed" as const, input: { ...input, prices, volumes: evidence.volumes },
        dashboard: computeTspDashboardEmotion({ universe, stocks, indices: index.indices, sectors }) };
    }, signal);
  return { producer: "whyj" as const, tradingDate: target, calendar: replay.calendar, tradingLimits: replay.input.tradingLimits,
    ...replay.rows.at(-1)! };
}

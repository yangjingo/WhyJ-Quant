import { computeTspSectorRanking, type TspSectorMembership, type TspSectorSnapshotGroup } from "../../quant/index.ts";
import {
  loadMarketCrossSectionArchive, loadSectorObservationArchive,
  type MarketCrossSectionArchiveRef, type SectorObservationArchiveRef, type StoredMarketCrossSection,
} from "../../storage/index.ts";

export interface SectorRankReplayRequest {
  marketRef: MarketCrossSectionArchiveRef;
  catalogRef: SectorObservationArchiveRef;
  memberRefs: readonly SectorObservationArchiveRef[];
}

export async function loadDatedSectorMembership(scope: Pick<StoredMarketCrossSection, "tradeDate" | "source" | "market">,
  request: Pick<SectorRankReplayRequest, "catalogRef" | "memberRefs">, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { tradeDate, source, market: exchange } = scope;
  const catalogRef = { ...request.catalogRef };
  const memberRefs = request.memberRefs.map(ref => ({ ...ref }));
  const catalog = await loadSectorObservationArchive(catalogRef, signal);
  if (catalog.endpoint !== "dc_index" || catalog.tradeDate !== tradeDate || catalog.market !== exchange || catalog.source !== source) {
    throw new Error("Sector catalog does not match the market cross-section");
  }

  const uncollected = new Map(catalog.groups.map(group => [group.code, group.name]));
  if (memberRefs.length > uncollected.size) throw new Error("Too many sector member references for the catalog");
  const groups: TspSectorSnapshotGroup[] = [];
  const membershipRefs: { sectorCode: string; ref: SectorObservationArchiveRef }[] = [];
  for (const ref of memberRefs) {
    const members = await loadSectorObservationArchive(ref, signal);
    if (members.endpoint !== "dc_member" || members.tradeDate !== tradeDate || members.market !== catalog.market ||
      members.source !== source || members.taxonomy !== catalog.taxonomy) {
      throw new Error("Sector membership does not match the dated catalog");
    }
    const id = members.sectorCode;
    const name = uncollected.get(id);
    if (name === undefined) throw new Error("Foreign or duplicate sector membership reference");
    uncollected.delete(id);
    groups.push({ id, name, revision: ref.revision, observedAt: members.observedAt, symbols: members.members.map(member => member.symbol) });
    membershipRefs.push({ sectorCode: id, ref });
  }

  signal?.throwIfAborted();
  const membership: Extract<TspSectorMembership, { basis: "provider-dated-snapshot" }> = {
    kind: catalog.kind, taxonomy: catalog.taxonomy, source, revision: catalogRef.revision,
    basis: "provider-dated-snapshot", tradeDate, observedAt: catalog.observedAt, groups,
  };
  const evidence = {
    catalogRef, membershipRefs: membershipRefs.sort((left, right) => left.sectorCode.localeCompare(right.sectorCode)),
    coverage: { catalogGroups: catalog.groups.length, archivedGroups: groups.length, uncollectedGroupIds: [...uncollected.keys()].sort() },
  };
  return { membership, evidence };
}

/** Describe the reported historical snapshot using only the referenced local archives. */
export async function replayTspSectorRanking(request: SectorRankReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const marketRef = { ...request.marketRef };
  const sector = { catalogRef: { ...request.catalogRef }, memberRefs: request.memberRefs.map(ref => ({ ...ref })) };
  const market = await loadMarketCrossSectionArchive(marketRef, signal);
  const { tradeDate, source } = market;
  const { membership, evidence } = await loadDatedSectorMembership(market, sector, signal);
  const bars = new Map(market.bars.rows.map(row => [row.symbol, row]));
  const quotes = market.universe.members.flatMap(({ symbol, name }) => {
    const bar = bars.get(symbol);
    return bar ? [{ tradeDate, symbol, name,
      changeFraction: bar.returnPct === null ? null : bar.returnPct / 100,
      amountCny: bar.amount === null ? null : bar.amount * 1_000,
    }] : [];
  });
  const ranking = computeTspSectorRanking({
    tradingDate: tradeDate, quotes,
    universe: { id: `${source}:${market.universe.endpoint}:${market.universe.universe}`, revision: marketRef.revision,
      symbols: market.universe.members.map(member => member.symbol) },
    membership,
  });
  return {
    ...ranking,
    input: {
      marketRef, ...evidence,
      market: { source, universeEndpoint: market.universe.endpoint, universeObservedAt: market.universe.observedAt,
        priceEndpoint: market.bars.endpoint, priceObservedAt: market.bars.observedAt, coverage: market.bars.coverage,
        storedAmountUnit: market.bars.amountUnit },
    },
  };
}

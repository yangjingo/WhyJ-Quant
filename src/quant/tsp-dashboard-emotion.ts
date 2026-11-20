import { computeTspMarketBreadth, isTspMarketBreadthEligible, type TspBreadthMemberObservation, type TspBreadthUniverse } from "./tsp-market-breadth.ts";
import { computeTspMarketEmotion, TSP_MARKET_EMOTION_FORMULA_VERSION, type TspEmotionMetrics, type TspEmotionOverrides } from "./tsp-market-emotion.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { computeTspMarketLadder, type TspLimitLadderObservation } from "./tsp-market-ladder.ts";
import { computeTspSectorRanking, type TspSectorMembership, type TspSectorSnapshotGroup } from "./tsp-sector-ranking.ts";

export const TSP_DASHBOARD_EMOTION_FORMULA_VERSION = 1;
export const TSP_DASHBOARD_CORE_INDICES = ["000001.SH", "399001.SZ", "399006.SZ", "000680.SH"] as const;
type CoreIndex = typeof TSP_DASHBOARD_CORE_INDICES[number];
type DatedSector = Extract<TspSectorMembership, { basis: "provider-dated-snapshot" }>;
const coreIndices = new Set<string>(TSP_DASHBOARD_CORE_INDICES);

export interface TspDashboardEmotionInput {
  universe: TspBreadthUniverse;
  stocks: readonly (Pick<TspBreadthMemberObservation, "tradingDate" | "symbol" | "name" | "close" | "changeFraction" |
    "volumeShares" | "volumeRatio5d" | "amountCny"> & Pick<TspLimitLadderObservation, "limitUp" | "brokenLimitUp" | "upStreak">)[];
  indices: readonly { tradingDate: string; symbol: CoreIndex; returnPct: number | null }[];
  sectors?: { concept?: DatedSector; industry?: DatedSector };
}

function dashboardLeaders(
  membership: DatedSector, universe: TspBreadthUniverse, stocks: TspDashboardEmotionInput["stocks"],
) {
  const grouped = new Map<string, { groupIds: string[]; symbols: Set<string> }>();
  const seen = new Set<string>();
  for (const group of membership.groups) {
    if (!group.id.trim() || !group.name.trim() || !group.revision.trim() || !Number.isFinite(Date.parse(group.observedAt)) ||
      seen.has(group.id) || group.symbols.length !== new Set(group.symbols).size) throw new Error("Invalid dashboard sector membership group");
    seen.add(group.id);
    const label = membership.kind === "industry" ? group.name.split("-")[1]?.trim() || group.name : group.name;
    const item = grouped.get(label) ?? { groupIds: [], symbols: new Set<string>() };
    item.groupIds.push(group.id);
    for (const symbol of group.symbols) item.symbols.add(symbol);
    grouped.set(label, item);
  }
  const groups: TspSectorSnapshotGroup[] = [...grouped].map(([label, group]) => ({
    id: label, name: label, revision: membership.revision, observedAt: membership.observedAt,
    symbols: [...group.symbols].sort(),
  }));
  const quotes = stocks.map(({ tradingDate: tradeDate, symbol, name, changeFraction, amountCny }) => ({
    tradeDate, symbol, name, changeFraction, amountCny,
  }));
  const ranking = computeTspSectorRanking({ tradingDate: universe.tradingDate, universe, quotes, membership: { ...membership, groups } });
  return {
    leaders: ranking.leading.slice(0, 3).map(group => ({
      kind: membership.kind, name: group.name, averageFraction: group.averageFraction, observedCount: group.observedCount,
      groupIds: grouped.get(group.id)!.groupIds.sort(),
    })),
    membership: {
      kind: membership.kind, taxonomy: membership.taxonomy, source: membership.source, revision: membership.revision,
      basis: membership.basis, tradeDate: membership.tradeDate, observedAt: membership.observedAt,
      groups: membership.groups.map(({ id, name, revision, observedAt }) => ({ id, name, revision, observedAt })),
    },
  };
}

/** Calculate the historical dashboard's six-dimensional inputs from exact dated observations. */
export function computeTspDashboardEmotion(input: TspDashboardEmotionInput, overrides?: TspEmotionOverrides) {
  const { universe, stocks, indices, sectors } = input;
  const date = universe.tradingDate;
  const breadth = computeTspMarketBreadth(universe, stocks.map(row => ({ ...row, turnoverPct: null,
    ma5: null, ma20: null, ma60: null, high60d: null, low60d: null, newHighSignal: null, newLowSignal: null,
  })));
  const eligible = stocks.filter(isTspMarketBreadthEligible);
  const total = eligible.length;
  const activeUniverse = { ...universe, symbols: eligible.map(row => row.symbol) };
  const ladder = computeTspMarketLadder(activeUniverse, null, eligible.map(row => ({ ...row, priorUpStreak: null })));
  const indexValues = new Map<CoreIndex, number | null>();
  for (const row of indices) {
    if (row.tradingDate !== date || !coreIndices.has(row.symbol) || indexValues.has(row.symbol) ||
      (row.returnPct !== null && (!Number.isFinite(row.returnPct) || row.returnPct < -100))) {
      throw new Error("Invalid or duplicate dashboard core index observation");
    }
    indexValues.set(row.symbol, row.returnPct);
  }
  const indexEvidence = TSP_DASHBOARD_CORE_INDICES.map(symbol => ({ symbol, returnPct: indexValues.get(symbol) ?? null,
    present: indexValues.has(symbol) }));
  const indexReturns = indexEvidence.flatMap(row => row.returnPct === null ? [] : [row.returnPct]);
  const indexMean = indexReturns.length ? indexReturns.reduce((sum, value) => sum + value / indexReturns.length, 0) : null;

  const rankedSectors = (["concept", "industry"] as const).flatMap(kind => {
    const membership = sectors?.[kind];
    if (!membership) return [];
    if (membership.kind !== kind) throw new Error("Invalid dashboard sector kind");
    return [dashboardLeaders(membership, activeUniverse, eligible)];
  });
  const leaders = rankedSectors.flatMap(sector => sector.leaders);
  const percentOfRows = (count: number, knownCount: number) => total && knownCount ? count / total * 100 : null;
  const returnsKnown = breadth.breadth.observedReturns;
  const { seal, coverage } = ladder;
  const metrics: TspEmotionMetrics = {
    avg_index_pct: indexMean,
    up_pct: percentOfRows(breadth.breadth.up.count, returnsKnown),
    avg_pct: breadth.breadth.average,
    median_pct: breadth.breadth.median,
    strong_diff_pct: percentOfRows(breadth.breadth.strongUp.count - breadth.breadth.strongDown.count, returnsKnown),
    avg_vol_ratio: breadth.activity.volumeRatio.average,
    high_vol_pct: percentOfRows(breadth.activity.highVolume.count, breadth.activity.highVolume.denominator),
    limit_up: total !== 0 && coverage.limitUpsKnown === total ? seal.observedLimitUps : null,
    seal_rate: seal.denominator === null ? null : seal.denominator ? seal.observedLimitUps / seal.denominator * 100 : 0,
    max_boards: ladder.ladder?.height ?? null,
    tier2_count: ladder.ladder?.twoOrMoreCount ?? null,
    down_pct: percentOfRows(breadth.breadth.down.count, returnsKnown),
    strong_down_pct: percentOfRows(breadth.breadth.strongDown.count, returnsKnown),
    ...(leaders.length ? {
      mainline_avg: Math.max(...leaders.map(row => row.averageFraction)),
      mainline_cover_pct: Math.max(...leaders.map(row => row.observedCount)) / total * 100,
    } : {}),
  };
  return {
    producer: "whyj" as const, tradingDate: date, universe: breadth.universe,
    formula: { id: "tsp_dashboard_emotion" as const, version: TSP_DASHBOARD_EMOTION_FORMULA_VERSION,
      scoreVersion: TSP_MARKET_EMOTION_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    metrics, emotion: computeTspMarketEmotion(metrics, overrides),
    evidence: { stocks: breadth.coverage, returnsKnown, volumeRatiosKnown: breadth.activity.volumeRatio.denominator,
      exchange: { coverage, seal, depthCorrection: "unavailable" as const }, indexEvidence, leaders,
      sectorMembership: rankedSectors.map(sector => sector.membership) },
  };
}

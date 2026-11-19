import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { TSP_SECTOR_RANKING_FORMULA_VERSION, type computeTspSectorRanking, type TspSectorRank } from "./tsp-sector-ranking.ts";

export const TSP_SECTOR_ROTATION_FORMULA_VERSION = 1;

type DailyRanks = ReturnType<typeof computeTspSectorRanking>;

const scopeOf = ({ membership }: DailyRanks) => ({
  kind: membership.kind,
  taxonomy: membership.taxonomy,
  source: membership.source,
  basis: "basis" in membership ? membership.basis : "effective-dated" as const,
});

/** Order each day's comparable groups by average member return and retain the independent evidence. */
export function computeTspSectorRotation(input: readonly DailyRanks[], days = 12) {
  if (!Number.isSafeInteger(days)) throw new Error("Invalid sector rotation window");
  const window = Math.max(7, Math.min(30, days));
  const ordered = [...input].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  const scope = ordered[0] ? scopeOf(ordered[0]) : null;
  const formula = { id: "tsp_sector_rotation" as const, version: TSP_SECTOR_ROTATION_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION };
  let previousRanks = new Map<string, number>();
  let previousTradingDate: string | null = null;
  const sessions = [];
  const columns = [];

  for (const day of ordered) {
    const { tradingDate, membership, universe, groups } = day;
    const identity = scopeOf(day);
    if (!isDailyDate(tradingDate) || tradingDate === previousTradingDate || ("basis" in membership && membership.tradeDate !== tradingDate) ||
      day.producer !== "whyj" || day.formula.id !== "tsp_sector_ranking" || day.formula.version !== TSP_SECTOR_RANKING_FORMULA_VERSION ||
      day.formula.revision !== TSP_INDICATOR_REVISION || !scope || identity.kind !== scope.kind || identity.taxonomy !== scope.taxonomy ||
      identity.source !== scope.source || identity.basis !== scope.basis) throw new Error("Incompatible or duplicate sector rotation session");

    const seen = new Set<string>();
    const comparable: (TspSectorRank & { averageFraction: number })[] = [];
    for (const group of groups) {
      if (!group.id.trim() || !group.name.trim() || seen.has(group.id) ||
        (group.averageFraction === null ? group.returnCount !== 0 :
          !Number.isFinite(group.averageFraction) || group.averageFraction < -1 || group.returnCount <= 0)) {
        throw new Error("Invalid or duplicate sector rotation group");
      }
      seen.add(group.id);
      if (group.averageFraction !== null) comparable.push({ ...group, averageFraction: group.averageFraction });
    }
    comparable.sort((left, right) => right.averageFraction - left.averageFraction || left.id.localeCompare(right.id));
    const rows = comparable.map(({ id, name, averageFraction, memberCount, returnCount }, index) => {
      const rank = index + 1, prior = previousRanks.get(id);
      return { id, name, averageFraction, rank, rankMovement: prior === undefined ? null : prior - rank, memberCount, returnCount };
    });
    if (rows.length) columns.push({ tradingDate, previousTradingDate, rows });
    sessions.push({ tradingDate, universe, membership, groups: groups.length, comparableGroups: rows.length });
    previousRanks = new Map(rows.map(row => [row.id, row.rank]));
    previousTradingDate = tradingDate;
  }

  const latest = columns.slice(-window).reverse();
  const groupCount = new Set(latest.flatMap(column => column.rows.map(row => row.id))).size;
  return { producer: "whyj" as const, formula, scope, window, groupCount, columns: latest, input: { sessions } };
}

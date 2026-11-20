import { isDailyDate } from "../market/bars.ts";
import type { TspBreadthUniverse } from "./tsp-market-breadth.ts";
import type { TspSectorMembership } from "./tsp-sector-ranking.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_MARKET_MAINLINE_FORMULA_VERSION = 1;

export interface TspMainlineFilter {
  minMembers?: number;
  maxMembers?: number;
  blacklist?: readonly string[];
}

export interface TspMainlineInput {
  universe: TspBreadthUniverse;
  membership: Extract<TspSectorMembership, { basis: "provider-dated-snapshot" }>;
  observations: readonly {
    tradingDate: string;
    symbol: string;
    upStreak: number | null;
    amountCny: number | null;
  }[];
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const weights = [
  ["limitUpCount", 0.35], ["maxBoards", 0.25], ["rungsFilled", 0.25], ["twoOrMoreCount", 0.15],
] as const;

type StockObservation = TspMainlineInput["observations"][number];
type SuccessfulStreak = StockObservation & { upStreak: number };

function datedCapture(value: string): boolean {
  return typeof value === "string" && isDailyDate(value.slice(0, 10)) &&
    /^T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.slice(10));
}

function aggregateMember(name: string, joined: readonly StockObservation[]) {
  const positive = joined.filter((row): row is SuccessfulStreak => row.upStreak !== null && row.upStreak >= 1);
  // Pinned Polars ordering puts null amounts first when the streak is tied.
  const ranked = positive.sort((left, right) => right.upStreak - left.upStreak ||
    (right.amountCny ?? Infinity) - (left.amountCny ?? Infinity) || left.symbol.localeCompare(right.symbol));
  const multiple = ranked.filter(row => row.upStreak >= 2);
  const boardsSum = ranked.reduce((sum, row) => sum + row.upStreak, 0);
  if (!Number.isSafeInteger(boardsSum)) throw new Error("Market mainline board count exceeds the numeric range");
  return { name, limitUpCount: ranked.length, maxBoards: ranked[0]?.upStreak ?? 0, boardsSum, twoOrMoreCount: multiple.length,
    rungsFilled: new Set(multiple.map(row => row.upStreak)).size, leaderSymbol: ranked[0]?.symbol ?? null,
    leaderAmountCny: ranked[0]?.amountCny ?? null,
    mappedCount: joined.length, knownStreakCount: joined.filter(row => row.upStreak !== null).length, normalizedScore: 0 };
}

/** Apply the pinned limit-up-based score to an explicit dated market scope. */
export function computeTspMarketMainline(input: TspMainlineInput, filter: TspMainlineFilter = {}) {
  const { universe: { tradingDate, symbols, id, revision }, membership, observations } = input;
  const { groups, ...membershipMeta } = membership;
  if (!isDailyDate(tradingDate) || !id.trim() || !revision.trim() || membership.tradeDate !== tradingDate ||
    membership.basis !== "provider-dated-snapshot" || (membership.kind !== "industry" && membership.kind !== "concept") ||
    !membership.taxonomy.trim() || !membership.source.trim() || !membership.revision.trim() ||
    !datedCapture(membership.observedAt) || symbols.some(symbol => !stock.test(symbol))) throw new Error("Invalid market mainline scope");
  const roster = new Set(symbols);
  if (roster.size !== symbols.length) throw new Error("Duplicate market mainline roster symbol");
  const { minMembers = 4, maxMembers = 600, blacklist = [] } = filter;
  if (!Number.isSafeInteger(minMembers) || minMembers < 1 || !Number.isSafeInteger(maxMembers) ||
    maxMembers < minMembers || blacklist.some(name => typeof name !== "string" || !name.trim())) {
    throw new Error("Invalid market mainline member filter");
  }
  const blockedNames = new Set(blacklist);
  const applySizeFilter = minMembers > 1 || maxMembers < 5_000 || blockedNames.size > 0;

  const observationsBySymbol = new Map<string, StockObservation>();
  for (const row of observations) {
    if (row.tradingDate !== tradingDate || !roster.has(row.symbol) || observationsBySymbol.has(row.symbol) ||
      (row.upStreak !== null && (!Number.isSafeInteger(row.upStreak) || row.upStreak < 0)) ||
      (row.amountCny !== null && (!Number.isFinite(row.amountCny) || row.amountCny < 0))) throw new Error("Invalid or duplicate market mainline observation");
    observationsBySymbol.set(row.symbol, row);
  }

  const originalNames = new Map<string, Set<string>>();
  const groupIds = new Set<string>();
  for (const group of groups) {
    const members = new Set(group.symbols);
    if (!group.id.trim() || !group.name.trim() || !group.revision.trim() || !datedCapture(group.observedAt) ||
      groupIds.has(group.id) || members.size !== group.symbols.length || group.symbols.some(symbol => !stock.test(symbol))) {
      throw new Error("Invalid or duplicate market mainline membership");
    }
    groupIds.add(group.id);
    const combined = originalNames.get(group.name);
    if (combined) for (const member of members) combined.add(member);
    else originalNames.set(group.name, members);
  }

  const joinedMembers = new Map<string, StockObservation[]>();
  let filteredNames = 0;
  for (const [name, members] of originalNames) {
    if (applySizeFilter && (members.size < minMembers || members.size > maxMembers || blockedNames.has(name))) {
      filteredNames++;
      continue;
    }
    const parent = membership.kind === "industry" ? name.split("-").slice(0, 2).join("-") : name;
    const joined = joinedMembers.get(parent) ?? [];
    for (const symbol of members) {
      if (!roster.has(symbol)) continue;
      joined.push(observationsBySymbol.get(symbol) ?? { tradingDate, symbol, upStreak: null, amountCny: null });
    }
    joinedMembers.set(parent, joined);
  }

  const comparable = [...joinedMembers].map(([name, joined]) => aggregateMember(name, joined)).filter(row => row.limitUpCount >= 3);
  for (const [field, weight] of weights) {
    const ordered = [...comparable].sort((left, right) => left[field] - right[field]);
    const denominator = Math.max(ordered.length - 1, 1);
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && ordered[end]![field] === ordered[start]![field]) end++;
      const averagePercentile = (start + end - 1) / 2 / denominator;
      for (let index = start; index < end; index++) ordered[index]!.normalizedScore += weight * averagePercentile;
      start = end;
    }
  }
  comparable.sort((left, right) => right.normalizedScore - left.normalizedScore || left.name.localeCompare(right.name));
  const rows = comparable.slice(0, 30).map(({ normalizedScore, ...group }, index) => ({ ...group, score: normalizedScore * 100, rank: index + 1 }));
  return {
    producer: "whyj" as const, tradingDate, kind: membership.kind,
    formula: { id: "tsp_market_mainline" as const, version: TSP_MARKET_MAINLINE_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    membership: { ...membershipMeta, groups: groups.length },
    universe: { id, revision, roster: roster.size, knownStreaks: observations.filter(row => row.upStreak !== null).length },
    filter: { minMembers, maxMembers, blacklist: [...blockedNames], filteredNames },
    comparableGroups: comparable.length, rows,
  };
}

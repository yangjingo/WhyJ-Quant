import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_SECTOR_RANKING_FORMULA_VERSION = 1;

export interface TspSectorMember {
  groupId: string;
  groupName: string;
  symbol: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  knownOn: string;
}

export interface TspSectorSnapshotGroup {
  id: string;
  name: string;
  revision: string;
  observedAt: string;
  symbols: readonly string[];
}

export type TspSectorMembership = {
  kind: "industry" | "concept";
  taxonomy: string;
  source: string;
  revision: string;
} & (
  | { basis?: "effective-dated"; rows: readonly TspSectorMember[] }
  | { basis: "provider-dated-snapshot"; tradeDate: string; observedAt: string; groups: readonly TspSectorSnapshotGroup[] }
);

export interface TspSectorRankingInput {
  tradingDate: string;
  universe: { id: string; revision: string; symbols: readonly string[] };
  membership: TspSectorMembership;
  quotes: readonly {
    tradeDate: string;
    symbol: string;
    name: string | null;
    changeFraction: number | null;
    amountCny: number | null;
  }[];
}

export interface TspSectorRank {
  id: string;
  name: string;
  memberCount: number;
  observedCount: number;
  returnCount: number;
  averageFraction: number | null;
  upCount: number;
  downCount: number;
  amountCny: number | null;
  amountCount: number;
  leader: { symbol: string; name: string | null; changeFraction: number } | null;
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const text = (value: string): boolean => typeof value === "string" && !!value.trim();
const tally = (value: number, other: number): number => {
  const sum = value + other;
  if (!Number.isFinite(sum)) throw new Error("Sector aggregate exceeds numeric range");
  return sum;
};

function effectiveGroups(rows: readonly TspSectorMember[], tradingDate: string, eligible: ReadonlySet<string>) {
  const known = new Map<string, { member: TspSectorMember; conflicting: boolean }>();
  for (const member of rows) {
    if (!text(member.groupId) || !text(member.groupName) || !stock.test(member.symbol) || !isDailyDate(member.knownOn) ||
      !isDailyDate(member.effectiveFrom) || (member.effectiveUntil !== null &&
        (!isDailyDate(member.effectiveUntil) || member.effectiveUntil <= member.effectiveFrom))) {
      throw new Error("Invalid sector membership");
    }
    if (member.knownOn > tradingDate || !eligible.has(member.symbol)) continue;
    const key = JSON.stringify([member.groupId, member.symbol, member.effectiveFrom]);
    const prior = known.get(key);
    if (!prior || member.knownOn > prior.member.knownOn) known.set(key, { member, conflicting: false });
    else if (prior.member.knownOn === member.knownOn &&
      (prior.member.groupName !== member.groupName || prior.member.effectiveUntil !== member.effectiveUntil)) prior.conflicting = true;
  }

  const active = new Map<string, { name: string; symbols: Set<string> }>();
  for (const { member, conflicting } of known.values()) {
    if (conflicting) throw new Error("Conflicting revisions for sector membership");
    if (tradingDate < member.effectiveFrom || (member.effectiveUntil !== null && tradingDate >= member.effectiveUntil)) continue;
    const group = active.get(member.groupId);
    if (!group) active.set(member.groupId, { name: member.groupName, symbols: new Set([member.symbol]) });
    else {
      if (group.name !== member.groupName) throw new Error("Conflicting names for sector identity");
      group.symbols.add(member.symbol);
    }
  }
  return active;
}

const captureInstant = (value: string) => typeof value === "string" && isDailyDate(value.slice(0, 10)) &&
  /^T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.slice(10));

function snapshotGroups(membership: Extract<TspSectorMembership, { basis: "provider-dated-snapshot" }>,
  tradingDate: string, eligible: ReadonlySet<string>) {
  if (membership.tradeDate !== tradingDate || !captureInstant(membership.observedAt)) {
    throw new Error("Invalid sector snapshot date or capture time");
  }
  const active = new Map<string, { name: string; symbols: Set<string> }>();
  for (const { id, name, symbols, revision, observedAt } of membership.groups) {
    if (!text(id) || !text(name) || !text(revision) || !captureInstant(observedAt) || active.has(id)) {
      throw new Error("Invalid or duplicate sector snapshot group");
    }
    if (new Set(symbols).size !== symbols.length || symbols.some(symbol => !stock.test(symbol))) {
      throw new Error("Invalid or duplicate sector snapshot member");
    }
    active.set(id, { name, symbols: new Set(symbols.filter(symbol => eligible.has(symbol))) });
  }
  return active;
}

/** Rank effective-dated membership or describe a provider's independently captured exact-date snapshots. */
export function computeTspSectorRanking({ tradingDate, universe, membership, quotes }: TspSectorRankingInput) {
  const eligible = new Set(universe.symbols);
  if (!isDailyDate(tradingDate) || ![universe.id, universe.revision, membership.taxonomy, membership.source, membership.revision].every(text) ||
    (membership.kind !== "industry" && membership.kind !== "concept") ||
    (membership.basis !== undefined && membership.basis !== "effective-dated" && membership.basis !== "provider-dated-snapshot") ||
    eligible.size !== universe.symbols.length || universe.symbols.some(symbol => !stock.test(symbol))) throw new Error("Invalid sector ranking input");

  const quoteBySymbol = new Map<string, TspSectorRankingInput["quotes"][number]>();
  for (const quote of quotes) {
    if (quote.tradeDate !== tradingDate || !eligible.has(quote.symbol) || quoteBySymbol.has(quote.symbol) ||
      (quote.name !== null && typeof quote.name !== "string") ||
      (quote.changeFraction !== null && (!Number.isFinite(quote.changeFraction) || quote.changeFraction < -1)) ||
      (quote.amountCny !== null && (!Number.isFinite(quote.amountCny) || quote.amountCny < 0))) {
      throw new Error("Invalid or duplicate sector observation");
    }
    quoteBySymbol.set(quote.symbol, quote);
  }

  const active = membership.basis === "provider-dated-snapshot" ? snapshotGroups(membership, tradingDate, eligible)
    : effectiveGroups(membership.rows, tradingDate, eligible);

  const groups: TspSectorRank[] = [];
  for (const [id, { name, symbols }] of active) {
    let observedCount = 0, returnCount = 0, upCount = 0, downCount = 0, amountCount = 0;
    let totalReturn = 0, totalAmount = 0;
    let leader: TspSectorRank["leader"] = null;
    for (const symbol of [...symbols].sort()) {
      const quote = quoteBySymbol.get(symbol);
      if (!quote) continue;
      observedCount++;
      if (quote.amountCny !== null) {
        totalAmount = tally(totalAmount, quote.amountCny);
        amountCount++;
      }
      const change = quote.changeFraction;
      if (change === null) continue;
      totalReturn = tally(totalReturn, change);
      returnCount++;
      if (change > 0) upCount++;
      if (change < 0) downCount++;
      if (!leader || change > leader.changeFraction) leader = { symbol, name: quote.name, changeFraction: change };
    }
    groups.push({
      id, name, memberCount: symbols.size, observedCount, returnCount,
      averageFraction: returnCount ? totalReturn / returnCount : null,
      upCount, downCount, amountCount, amountCny: amountCount ? totalAmount : null, leader,
    });
  }
  groups.sort((left, right) => left.id.localeCompare(right.id));
  const ranked = groups.filter((group): group is TspSectorRank & { averageFraction: number } => group.averageFraction !== null);
  const ordered = (direction: 1 | -1) => [...ranked].sort((left, right) =>
    direction * (left.averageFraction - right.averageFraction) || left.id.localeCompare(right.id)).slice(0, 5);
  const { kind, taxonomy, source, revision } = membership;
  const identity = { kind, taxonomy, source, revision };
  const evidence = membership.basis === "provider-dated-snapshot" ? {
    ...identity, basis: membership.basis, tradeDate: membership.tradeDate, observedAt: membership.observedAt, coverage: "unknown" as const,
    groups: membership.groups.map(({ id, revision, observedAt }) => ({ id, revision, observedAt })).sort((left, right) => left.id.localeCompare(right.id)),
  } : identity;
  return {
    producer: "whyj" as const,
    formula: { id: "tsp_sector_ranking" as const, version: TSP_SECTOR_RANKING_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, universe: { id: universe.id, revision: universe.revision }, membership: evidence,
    groups, leading: ordered(-1), lagging: ordered(1),
  };
}

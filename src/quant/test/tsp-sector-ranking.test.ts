import { expect, test } from "bun:test";
import { computeTspSectorRanking, TSP_INDICATOR_REVISION, TSP_SECTOR_RANKING_FORMULA_VERSION } from "../index.ts";
import type { TspSectorMember, TspSectorRankingInput } from "../index.ts";
import fixture from "./fixtures/tsp-sector-ranks.json";

const tradingDate = fixture.date;
const universe = { id: "fixture-a", revision: "u1", symbols: fixture.quotes.map(quote => quote.symbol) };
const quotes = fixture.quotes.map(quote => ({ tradeDate: tradingDate, symbol: quote.symbol, name: quote.name,
  changeFraction: quote.change_pct, amountCny: quote.amount }));

test("industry and concept leaders and aggregates match the pinned complete cross-section", () => {
  expect(TSP_INDICATOR_REVISION).toBe(fixture.revision);
  expect(TSP_SECTOR_RANKING_FORMULA_VERSION).toBe(1);
  for (const sample of fixture.cases) {
    const kind = sample.kind === "industry" ? "industry" : "concept";
    const result = computeTspSectorRanking({ tradingDate, universe, quotes, membership: {
      kind, taxonomy: "resolved-provider-labels", source: "fixture", revision: "m1", rows: sample.members,
    } });
    const groups = new Map<string, { id: string; name: string; symbols: string[]; revision: string; observedAt: string }>();
    for (const { groupId, groupName, symbol } of sample.members) {
      const group = groups.get(groupId);
      if (group) group.symbols.push(symbol);
      else groups.set(groupId, { id: groupId, name: groupName, symbols: [symbol], revision: `members-${groupId}`,
        observedAt: "2026-03-04T06:04:00Z" });
    }
    const descriptive = computeTspSectorRanking({ tradingDate, universe, quotes, membership: {
      kind, basis: "provider-dated-snapshot", tradeDate: tradingDate, taxonomy: "resolved-provider-labels", source: "fixture", revision: "catalog-1",
      observedAt: "2026-03-04T06:00:00Z", groups: [...groups.values()],
    } });
    expect(descriptive.groups).toEqual(result.groups);
    expect(descriptive.leading).toEqual(result.leading);
    expect(descriptive.lagging).toEqual(result.lagging);
    for (const direction of ["leading", "lagging"] as const) {
      const ranks = result[direction], expected = sample.expected[direction];
      expect(ranks.map(item => item.name)).toEqual(expected.map(item => item.name));
      expect(ranks).toHaveLength(5);
      for (const [index, rank] of ranks.entries()) {
        const upstream = expected[index]!;
        expect(rank.averageFraction).toBeCloseTo(upstream.avg_pct, 12);
        expect(rank.memberCount).toBe(upstream.count);
        expect(rank.observedCount).toBe(upstream.count);
        expect(rank.returnCount).toBe(upstream.count);
        expect(rank.upCount).toBe(upstream.up_count);
        expect(rank.downCount).toBe(upstream.down_count);
        expect(rank.amountCny).toBe(upstream.amount);
        expect(rank.leader).toEqual({ symbol: upstream.leader.symbol, name: upstream.leader.name, changeFraction: upstream.leader.change_pct });
      }
    }
  }
});

test("membership revisions use their information date and preserve unavailable denominators", () => {
  const [a, b, c, d, e] = quotes;
  const spell = (symbol: string, extra: Partial<TspSectorMember> = {}): TspSectorMember => ({
    symbol, groupId: "bank", groupName: "Bank", effectiveFrom: "2026-01-01", effectiveUntil: null, knownOn: "2026-01-01", ...extra,
  });
  const rows = [
    spell(a!.symbol), spell(b!.symbol), spell(b!.symbol),
    spell(c!.symbol, { knownOn: "2026-01-06" }), spell(c!.symbol, { groupId: "empty", groupName: "No quote" }),
    spell(d!.symbol), spell(d!.symbol, { knownOn: "2026-01-03", effectiveUntil: tradingDate }),
    spell(e!.symbol, { effectiveFrom: "2026-01-06" }),
  ];
  const input = {
    tradingDate, universe, membership: { kind: "industry", taxonomy: "sector-v1", source: "fixture", revision: "m1", rows },
    quotes: [{ ...a!, changeFraction: null, amountCny: null }, { ...b!, changeFraction: 0, amountCny: 0 }, d!, e!],
  } satisfies TspSectorRankingInput;
  const result = computeTspSectorRanking(input);
  expect(result.membership).toEqual({ kind: "industry", taxonomy: "sector-v1", source: "fixture", revision: "m1" });
  expect(result.leading).toEqual([{ id: "bank", name: "Bank", memberCount: 2, observedCount: 2, returnCount: 1, averageFraction: 0,
    upCount: 0, downCount: 0, amountCny: 0, amountCount: 1, leader: { symbol: b!.symbol, name: b!.name, changeFraction: 0 } }]);
  expect(result.groups[1]).toMatchObject({ id: "empty", memberCount: 1, observedCount: 0, returnCount: 0, averageFraction: null, amountCny: null, leader: null });
  expect(computeTspSectorRanking({ ...input, membership: { ...input.membership, rows: rows.toReversed() }, quotes: input.quotes.toReversed() }))
    .toEqual(result);
  expect(() => computeTspSectorRanking({ ...input, quotes: [...input.quotes, a!] })).toThrow("duplicate");
  expect(() => computeTspSectorRanking({ ...input, membership: { ...input.membership, rows: [...rows, { ...rows[0]!, groupName: "Conflict" }] } }))
    .toThrow("Conflicting revisions");
});

test("provider snapshots preserve capture evidence without inferring historical availability", () => {
  const member = quotes[0]!;
  const first = { id: "BK1184.DC", name: "Robotics", revision: "members-a", observedAt: "2026-03-04T06:04:00Z",
    symbols: [member.symbol, "688777.SH"] };
  const second = { id: "BK0493.DC", name: "Renewables", revision: "members-b", observedAt: "2026-03-05T09:00:12.217Z", symbols: [] };
  const membership = { kind: "concept", basis: "provider-dated-snapshot", tradeDate: tradingDate, taxonomy: "eastmoney", source: "tushare",
    revision: "catalog-1", observedAt: "2026-03-04T06:00:00Z", groups: [first, second] } as const;
  const input = { tradingDate, universe, membership, quotes: [{ ...member, changeFraction: 0, amountCny: 0 }] };
  const result = computeTspSectorRanking(input);
  expect(result.producer).toBe("whyj");
  expect(result.formula).toEqual({ id: "tsp_sector_ranking", version: 1, revision: TSP_INDICATOR_REVISION });
  expect(result.membership).toEqual({ kind: "concept", basis: "provider-dated-snapshot", tradeDate: tradingDate, taxonomy: "eastmoney",
    source: "tushare", revision: "catalog-1", observedAt: membership.observedAt, coverage: "unknown", groups: [
      { id: second.id, revision: second.revision, observedAt: second.observedAt },
      { id: first.id, revision: first.revision, observedAt: first.observedAt },
    ] });
  expect(result.groups[0]).toMatchObject({ id: second.id, memberCount: 0, averageFraction: null });
  expect(result.leading[0]).toMatchObject({ id: first.id, memberCount: 1, returnCount: 1, averageFraction: 0, amountCny: 0 });
  expect(computeTspSectorRanking({ ...input, membership: { ...membership, groups: [second, first] } })).toEqual(result);
  expect(() => computeTspSectorRanking({ ...input, membership: { ...membership, tradeDate: "2026-01-06" } })).toThrow("snapshot date");
  expect(() => computeTspSectorRanking({ ...input, membership: { ...membership, observedAt: "2026-02-30T06:00:00Z" } })).toThrow("capture time");
  expect(() => computeTspSectorRanking({ ...input, membership: { ...membership, groups: [first, first] } })).toThrow("duplicate sector snapshot group");
  expect(() => computeTspSectorRanking({ ...input, membership: { ...membership,
    groups: [{ ...first, symbols: [member.symbol, member.symbol] }] } })).toThrow("duplicate sector snapshot member");
});

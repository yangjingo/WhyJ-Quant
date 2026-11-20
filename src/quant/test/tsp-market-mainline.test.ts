import { expect, test } from "bun:test";
import { computeTspMarketMainline, type TspMainlineInput } from "../index.ts";

const date = "2025-01-02", observedAt = "2025-01-03T00:00:00Z";
const symbols = Array.from({ length: 12 }, (_, index) => `${600000 + index}.SH`);
const group = (name: string, members: readonly string[], id = name) => ({ id, name, revision: "members-" + id, observedAt, symbols: members });
const base = (): TspMainlineInput => ({
  universe: { tradingDate: date, symbols, id: "fixed-roster", revision: "market-1" },
  membership: { kind: "concept", basis: "provider-dated-snapshot", taxonomy: "fixture", source: "tushare", revision: "catalog-1",
    tradeDate: date, observedAt, groups: [group("A", symbols.slice(0, 4)), group("B", symbols.slice(4, 8)), group("C", symbols.slice(8))] },
  observations: [3, 2, 1, 1, 4, 4, 4, 0, 1, 1, 1, 0].map((upStreak, index) => ({
    tradingDate: date, symbol: symbols[index]!, upStreak, amountCny: index === 5 ? 200 : 100,
  })),
});

test("market mainline ranks the four pinned factors with average ties and exact limit-up aggregates", () => {
  const result = computeTspMarketMainline(base());
  expect(result).toMatchObject({ producer: "whyj", tradingDate: date, kind: "concept", comparableGroups: 3,
    formula: { id: "tsp_market_mainline", version: 1 }, membership: { revision: "catalog-1", observedAt, groups: 3 },
    universe: { id: "fixed-roster", revision: "market-1", roster: 12, knownStreaks: 12 }, filter: { minMembers: 4, maxMembers: 600 },
  });
  expect(result.rows.map(row => [row.name, row.rank, row.limitUpCount, row.maxBoards, row.boardsSum, row.twoOrMoreCount, row.rungsFilled, row.leaderSymbol]))
    .toEqual([
      ["A", 1, 4, 3, 7, 2, 2, symbols[0]],
      ["B", 2, 3, 4, 12, 3, 1, symbols[5]],
      ["C", 3, 3, 1, 3, 0, 0, symbols[8]],
    ]);
  [80, 61.25, 8.75].forEach((score, index) => expect(result.rows[index]?.score).toBeCloseTo(score, 10));
  const input = base();
  input.observations = input.observations.map(row => row.symbol === symbols[4] ? { ...row, amountCny: null } : row);
  expect(computeTspMarketMainline(input).rows[1]).toMatchObject({ name: "B", leaderSymbol: symbols[4], leaderAmountCny: null });
});

test("filters original groups, combines industry paths at two levels and keeps singleton rank zero", () => {
  const input = base();
  input.membership = { ...input.membership, kind: "industry", groups: [
    group("制造-机械-通用设备", symbols.slice(0, 4)),
    group("制造-机械-专用设备", symbols.slice(4, 8)),
    group("制造-电气-小样本", symbols.slice(0, 3)),
    group("制造-电气-全行业", symbols),
    group("冶金-钢铁-黑名单", symbols.slice(8)),
    group("运输-铁路-涨停不足", [symbols[0]!, symbols[1]!, symbols[7]!, symbols[11]!]),
  ] };
  const result = computeTspMarketMainline(input, { maxMembers: 4, blacklist: ["冶金-钢铁-黑名单"] });
  expect(result.filter.filteredNames).toBe(3);
  expect(result.rows).toEqual([{
    name: "制造-机械", limitUpCount: 7, maxBoards: 4, boardsSum: 19, twoOrMoreCount: 5, rungsFilled: 3,
    leaderSymbol: symbols[5], leaderAmountCny: 200, mappedCount: 8, knownStreakCount: 8, score: 0, rank: 1,
  }]);
});

test("exposes observation gaps and preserves deterministic ties before the top-30 cutoff", () => {
  const input = base();
  input.membership = { ...input.membership, groups: Array.from({ length: 32 }, (_, index) =>
    group("Board " + String(index).padStart(2, "0"), symbols.slice(0, 4))).reverse() };
  input.observations = input.observations.slice(0, 3);
  const result = computeTspMarketMainline(input);
  expect(result.comparableGroups).toBe(32);
  expect(result.rows).toHaveLength(30);
  expect(result.rows[0]).toMatchObject({ name: "Board 00", rank: 1, knownStreakCount: 3, mappedCount: 4 });
  expect(result.rows[29]).toMatchObject({ name: "Board 29", rank: 30 });
  expect(result.rows[0]?.score).toBeCloseTo(50, 10);
  expect(computeTspMarketMainline({ ...input, observations: [] }).rows).toEqual([]);
});

test("rejects duplicate observations, mixed dates and incompatible membership", () => {
  const input = base();
  expect(() => computeTspMarketMainline({ ...input, membership: { ...input.membership, tradeDate: "2025-01-03" } }))
    .toThrow("Invalid market mainline scope");
  expect(() => computeTspMarketMainline({ ...input, observations: [...input.observations, input.observations[0]!] }))
    .toThrow("Invalid or duplicate market mainline observation");
  expect(() => computeTspMarketMainline({ ...input, observations: [{ ...input.observations[0]!, amountCny: NaN }] }))
    .toThrow("Invalid or duplicate market mainline observation");
  expect(() => computeTspMarketMainline({ ...input, membership: { ...input.membership,
    groups: [group("A", [symbols[0]!, symbols[0]!])] } })).toThrow("Invalid or duplicate market mainline membership");
  expect(() => computeTspMarketMainline(input, { minMembers: 5, maxMembers: 4 })).toThrow("Invalid market mainline member filter");
});

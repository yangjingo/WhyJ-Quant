import { expect, test } from "bun:test";
import { computeTspSectorRanking, computeTspSectorRotation, TSP_INDICATOR_REVISION } from "../index.ts";

const symbols = ["600000.SH", "000001.SZ", "873593.BJ"];
const ids = ["BK2000.DC", "BK1000.DC", "BK3000.DC"];

function rankDay(tradingDate: string, returns: readonly (number | null)[], taxonomy = "eastmoney") {
  return computeTspSectorRanking({
    tradingDate,
    universe: { id: "dated-stocks", revision: `stocks-${tradingDate}`, symbols },
    membership: { kind: "concept", basis: "provider-dated-snapshot", tradeDate: tradingDate, source: "tushare", taxonomy,
      revision: `catalog-${tradingDate}`, observedAt: "2025-03-01T00:00:00Z", groups: symbols.map((symbol, index) => ({
        id: ids[index]!, name: `Group ${index + 1}`, revision: `members-${tradingDate}-${index}`, observedAt: "2025-03-01T02:00:00Z", symbols: [symbol],
      })) },
    quotes: symbols.map((symbol, index) => ({ tradeDate: tradingDate, symbol, name: null, changeFraction: returns[index] ?? null, amountCny: null })),
  });
}

test("TSP rotation orders each day by mean return and reports rank changes using dated evidence", () => {
  const first = rankDay("2025-01-02", [0.04, 0.01, null]);
  const second = rankDay("2025-01-03", [-0.03, 0.05, 0]);
  const empty = rankDay("2025-01-06", [null, null, null]);
  const latest = rankDay("2025-01-07", [0.02, 0.02, -0.01]);
  const result = computeTspSectorRotation([latest, first, empty, second]);
  expect(result.producer).toBe("whyj");
  expect(result.formula).toEqual({ id: "tsp_sector_rotation", version: 1, revision: TSP_INDICATOR_REVISION });
  expect(result.scope).toEqual({ kind: "concept", basis: "provider-dated-snapshot", taxonomy: "eastmoney", source: "tushare" });
  expect(result.window).toBe(12);
  expect(result.groupCount).toBe(3);
  expect(result.columns.map(column => [column.tradingDate, column.previousTradingDate, column.rows.map(row => [
    row.id, row.averageFraction, row.rank, row.rankMovement,
  ])])).toEqual([
    ["2025-01-07", "2025-01-06", [[ids[1], 0.02, 1, null], [ids[0], 0.02, 2, null], [ids[2], -0.01, 3, null]]],
    ["2025-01-03", "2025-01-02", [[ids[1], 0.05, 1, 1], [ids[2], 0, 2, null], [ids[0], -0.03, 3, -2]]],
    ["2025-01-02", null, [[ids[0], 0.04, 1, null], [ids[1], 0.01, 2, null]]],
  ]);
  expect(result.input.sessions[2]).toEqual({ tradingDate: "2025-01-06", universe: empty.universe,
    membership: empty.membership, groups: 3, comparableGroups: 0 });
  expect(computeTspSectorRotation([first, second, empty, latest])).toEqual(result);
});

test("rotation uses the latest comparable dates in the pinned window bounds", () => {
  const input = Array.from({ length: 33 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    return rankDay(date, index === 30 ? [null] : [0.01]);
  });
  const recent = computeTspSectorRotation(input, 2);
  expect(recent.window).toBe(7);
  expect(recent.columns).toHaveLength(7);
  expect(recent.columns[0]!.tradingDate).toBe("2025-02-02");
  expect(recent.columns.map(column => column.tradingDate)).not.toContain("2025-01-31");
  expect(recent.input.sessions[30]!.comparableGroups).toBe(0);
  expect(computeTspSectorRotation(input, 100).columns).toHaveLength(30);
  expect(computeTspSectorRotation(input).columns).toHaveLength(12);
  expect(computeTspSectorRotation([])).toMatchObject({ scope: null, columns: [], input: { sessions: [] }, groupCount: 0 });
  expect(() => computeTspSectorRotation(input, NaN)).toThrow("Invalid sector rotation window");
});

test("rejects duplicated days or groups, mixed taxonomies and mixed membership modes", () => {
  const first = rankDay("2025-01-02", [0.01]);
  const second = rankDay("2025-01-03", [0.03]);
  const effective = computeTspSectorRanking({ tradingDate: "2025-01-03", quotes: [], universe: { id: "dated-stocks", revision: "u", symbols },
    membership: { kind: "concept", taxonomy: "eastmoney", source: "tushare", revision: "effective", rows: [] } });
  expect(() => computeTspSectorRotation([first, first])).toThrow("Incompatible or duplicate");
  expect(() => computeTspSectorRotation([first, rankDay("2025-01-03", [0.03], "other")])).toThrow("Incompatible or duplicate");
  expect(() => computeTspSectorRotation([first, effective])).toThrow("Incompatible or duplicate");
  expect(() => computeTspSectorRotation([first, { ...second, groups: [...second.groups, second.groups[0]!] }])).toThrow("Invalid or duplicate sector rotation group");
});

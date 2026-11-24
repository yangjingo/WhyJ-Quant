import { describe, expect, test } from "bun:test";
import { computeTspMonitorAlerts, type TspMonitorAlertCapture, type TspMonitorAlertRule } from "../index.ts";

const a = "600001.SH", b = "000001.SZ", c = "300001.SZ";
const rule: TspMonitorAlertRule = {
  id: "price_signal", revision: "rule-v1", type: "signal", assetType: "stock", scope: { kind: "all" },
  conditions: [{ field: "cross", op: "truth" }, { field: "change_pct", op: ">=", value: 0.03, unit: "fraction" }],
  logic: "and", cooldownMs: 1_000, severity: "warn",
};

function capture(offsetMs: number, columns: TspMonitorAlertCapture["columns"]): TspMonitorAlertCapture {
  return { revision: `capture-${offsetMs}`, evaluatedAt: Date.UTC(2026, 10, 20, 2) + offsetMs,
    symbols: [a, b, c], columns, units: { change_pct: "fraction" } };
}

describe("fixed TSP monitor alerts", () => {
  test("preserves comparisons, truth hits and the difference between a null cell and an absent column", () => {
    const input = capture(0, { cross: [true, true, null], change_pct: [0.03, null, 0.04] });
    const and = computeTspMonitorAlerts({ rule, captures: [input] });
    expect(and).toMatchObject({ formulaVersion: 1, ruleId: "price_signal", ruleRevision: "rule-v1", severity: "warn" });
    expect(and.evaluations[0]).toMatchObject({ eligibleCount: 3, unavailableCount: 1, missingFields: [],
      events: [{ symbol: a, matchedConditions: [0, 1], signals: ["cross"] }] });

    const or = computeTspMonitorAlerts({ rule: { ...rule, logic: "or" }, captures: [input, capture(1, { cross: [true, true, true] })] });
    expect(or.evaluations[0]?.events).toEqual([
      { symbol: a, matchedConditions: [0, 1], signals: ["cross"] },
      { symbol: b, matchedConditions: [0], signals: ["cross"] },
      { symbol: c, matchedConditions: [1], signals: [] },
    ]);
    expect(or.evaluations[1]).toMatchObject({ missingFields: ["change_pct"], unavailableCount: 3, events: [] });
  });

  test("matches each numeric comparator without coercing a null value", () => {
    const expected = { ">": [b], ">=": [a, b], "<": [], "<=": [a], "==": [a], "!=": [b] } as const;
    for (const [op, symbols] of Object.entries(expected)) {
      const result = computeTspMonitorAlerts({ rule: { ...rule, type: "price", conditions: [
        { field: "change_pct", op: op as keyof typeof expected, value: 0.03, unit: "fraction" },
      ] }, captures: [capture(0, { change_pct: [0.03, 0.04, null] })] });
      expect(result.evaluations[0]?.events.map(event => event.symbol)).toEqual([...symbols]);
      expect(result.evaluations[0]?.unavailableCount).toBe(1);
    }
  });

  test("applies cooldown independently per instrument and permits a continuous hit at expiry", () => {
    const first = capture(0, { cross: [true, false, false], change_pct: [0.03, 0.03, 0.03] });
    const both = { cross: [true, true, false], change_pct: [0.03, 0.03, 0.03] };
    const captures = [first, capture(500, both), capture(900, { cross: [true, true, false] }), capture(1_000, both), capture(1_500, both)];
    const result = computeTspMonitorAlerts({ rule, captures });
    expect(result.evaluations.map(row => [row.suppressedCount, row.events.map(event => event.symbol)])).toEqual([
      [0, [a]], [1, [b]], [0, []], [1, [a]], [1, [b]],
    ]);
    expect(computeTspMonitorAlerts({ rule, captures })).toEqual(result);
  });

  test("restricts symbols and a frozen watchlist without falling back to a wider roster", () => {
    const captures = [capture(0, { cross: [true, true, true], change_pct: [0.05, 0.05, 0.05] })];
    const subset = computeTspMonitorAlerts({ rule: { ...rule, scope: { kind: "symbols", symbols: [b] } }, captures });
    expect(subset.evaluations[0]).toMatchObject({ eligibleCount: 1, events: [{ symbol: b }] });
    const watchlist = { kind: "watchlist_group", membershipRevision: "group-v1", symbols: [a, c] } as const;
    const group = computeTspMonitorAlerts({ rule: { ...rule, scope: watchlist }, captures });
    expect(group.membershipRevision).toBe("group-v1");
    expect(group.evaluations[0]?.events.map(event => event.symbol)).toEqual([a, c]);
    const empty = computeTspMonitorAlerts({ rule: { ...rule, scope: { ...watchlist, symbols: [] } }, captures });
    expect(empty.evaluations[0]).toMatchObject({ eligibleCount: 0, events: [] });
  });

  test("rejects invalid time ordering, row alignment, units and primitive types", () => {
    const input = capture(0, { cross: [true, true, false], change_pct: [0.03, 0.03, 0.03] });
    expect(() => computeTspMonitorAlerts({ rule, captures: [input, input] })).toThrow("duplicate or unordered");
    expect(() => computeTspMonitorAlerts({ rule, captures: [{ ...input, symbols: [a, a, c] }] })).toThrow("duplicate monitor symbol");
    expect(() => computeTspMonitorAlerts({ rule, captures: [capture(0, { cross: [true] })] })).toThrow("Invalid monitor column");
    expect(() => computeTspMonitorAlerts({ rule, captures: [{ ...input, units: { change_pct: "percent" } }] })).toThrow("Incompatible monitor unit");
    expect(() => computeTspMonitorAlerts({ rule, captures: [capture(0, { ...input.columns, cross: [1, 1, 0] })] })).toThrow("Invalid monitor observation");
    expect(() => computeTspMonitorAlerts({ rule, captures: [capture(0, { ...input.columns, change_pct: [Infinity, 0.03, 0.03] })] })).toThrow("Invalid monitor observation");
  });
});

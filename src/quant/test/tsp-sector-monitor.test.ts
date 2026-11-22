import { expect, test } from "bun:test";
import { computeTspSectorMonitor, TSP_INDICATOR_REVISION, type TspSectorMonitorInput, type TspSectorMonitorQuote } from "../index.ts";

const tradingDate = "2025-01-03";
const at = (time: string) => Date.parse(tradingDate + "T" + time + "+08:00");
const indexTarget = { id: "composite", name: "指数", kind: "index", symbol: "000001.SH" } as const;
const index = (time: string, changeFraction: number | null) => ({
  observedAt: at(time),
  quotes: [{ symbol: indexTarget.symbol, name: indexTarget.name, changeFraction, pricePoints: 3010 }],
});
const sectorTarget = {
  id: "test-concept", name: "概念", kind: "concept", membershipRevision: "fixture-revision",
  members: ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH"],
} as const;

test("retains observed sector metrics and a deterministic leader at the coverage threshold", () => {
  const quotes: TspSectorMonitorQuote[] = [0.125, 0.125, -0.0625, 0, null].map((changeFraction, i) => ({
    symbol: sectorTarget.members[i]!, name: null, changeFraction,
  }));
  const report = computeTspSectorMonitor({ tradingDate, target: sectorTarget, captures: [
    { observedAt: at("09:30:00"), quotes: quotes.toReversed() },
    { observedAt: at("09:31:00"), quotes: quotes.slice(0, 3) },
  ] });
  expect(report).toMatchObject({ producer: "whyj", formula: { id: "tsp_sector_monitor", version: 1, revision: TSP_INDICATOR_REVISION },
    target: { membershipRevision: "fixture-revision" } });
  expect(report.rows[0]).toMatchObject({ valid: true, coverageRatio: 0.8, changeFraction: 0.046875, pricePoints: null,
    validCount: 4, totalCount: 5, upCount: 2, downCount: 1, leader: { symbol: "600001.SH", changeFraction: 0.125 } });
  expect(report.rows[1]).toMatchObject({ valid: false, coverageRatio: 0.6, validCount: 3, totalCount: 5, changeFraction: 0.0625 });
  expect(computeTspSectorMonitor({ tradingDate, target: { ...sectorTarget, members: sectorTarget.members.slice(0, 4) },
    captures: [{ observedAt: at("09:31:00"), quotes: quotes.slice(0, 4) }] }).rows[0]).toMatchObject({ valid: false, coverageRatio: 1 });
});

test("uses each window cutoff and includes the exact ninety-second tolerance boundary", () => {
  const report = computeTspSectorMonitor({ tradingDate, target: indexTarget, captures: [
    index("09:30:00", 0), index("09:31:00", 0.0625), index("09:32:00", null),
    index("09:36:00", 0.1875), index("09:37:30", 0.125), index("09:37:30.001", 0.125),
  ] });
  expect(report.rows[0]).toMatchObject({ valid: true, totalCount: 1, pricePoints: 3010, leader: null, changeFraction: 0 });
  expect(report.rows[2]).toMatchObject({ valid: false, coverageRatio: 0, validCount: 0, pricePoints: null });
  const atFive = (row: number) => report.rows[row]?.windows.find(window => window.minutes === 5);
  expect(atFive(3)).toEqual({ minutes: 5, baselineAt: at("09:31:00"), changeFraction: 0.125 });
  expect(atFive(4)).toEqual({ minutes: 5, baselineAt: at("09:31:00"), changeFraction: 0.0625 });
  expect(atFive(5)).toEqual({ minutes: 5, baselineAt: null, changeFraction: null });
  expect(report.rows[3]?.windows.map(window => window.minutes)).toEqual([1, 3, 5, 10, 15]);
});

test("uses false-to-true crossings and consumes crossings suppressed by the cooldown", () => {
  const report = computeTspSectorMonitor({ tradingDate, target: indexTarget,
    rule: { trigger: "change_pct", direction: "down", thresholdFraction: 0.0625, cooldownMs: 300_000 },
    captures: [index("09:30:00", -0.0625), index("09:31:00", 0), index("09:32:00", -0.0625),
      index("09:33:00", 0), index("09:34:00", -0.125), index("09:37:00", -0.125),
      index("09:38:00", 0), index("09:39:00", null), index("09:40:00", -0.125)],
  });
  expect(report.rows.map(row => row.triggered)).toEqual([false, false, true, false, false, false, false, false, true]);
  const momentum = computeTspSectorMonitor({ tradingDate, target: indexTarget,
    rule: { trigger: "momentum", windowMinutes: 5, direction: "up", thresholdFraction: 0.0625, cooldownMs: 0 },
    captures: [index("09:30:00", 0), index("09:31:00", 0.0625), index("09:36:00", 0.125)],
  });
  expect(momentum.rows.map(row => row.triggered)).toEqual([false, false, true]);
});

test("rejects invalid observation order, quotes, target identities and rule thresholds", () => {
  const base: TspSectorMonitorInput = { tradingDate, target: indexTarget, captures: [index("09:30:00", 0)] };
  expect(() => computeTspSectorMonitor({ ...base, captures: [index("09:31:00", 0), index("09:30:00", 0)] })).toThrow("unordered");
  expect(() => computeTspSectorMonitor({ ...base, tradingDate: "2025-01-02" })).toThrow("capture");
  expect(() => computeTspSectorMonitor({ ...base, target: { ...indexTarget, symbol: "600001.SH" } })).toThrow("monitor index");
  expect(() => computeTspSectorMonitor({ ...base, captures: [index("09:31:00", Infinity)] })).toThrow("monitor quote");
  expect(() => computeTspSectorMonitor({ ...base,
    rule: { trigger: "change_pct", direction: "up", thresholdFraction: 0.21, cooldownMs: 0 } })).toThrow("rule");
});

import { expect, test } from "bun:test";
import {
  replayTspStrategyMonitor, TSP_INDICATOR_REVISION, TSP_STRATEGY_MONITOR_EVENT_TYPES,
  type TspStrategyMonitorCapture, type TspStrategyMonitorRule,
} from "../index.ts";

const start = Date.parse("2026-05-08T09:30:00+08:00");
const tomorrow = Date.parse("2026-05-09T00:00:00+08:00") - start;
const day = "2026-05-08";
const nextDay = "2026-05-09";
const a = "600001.SH", b = "600002.SH", c = "600003.SH", d = "600004.SH";
const rule: TspStrategyMonitorRule = {
  id: "strategy_monitor", revision: "rule-v1", strategyId: "fixed-strategy", strategyRevision: "strategy-v2",
  assetType: "stock", eventTypes: TSP_STRATEGY_MONITOR_EVENT_TYPES, cooldownMs: 0,
};

function complete(offset: number, rows: readonly { symbol: string; score: number | null }[] = [],
  buys: readonly string[] = [], sells: readonly string[] = []) {
  return {
    revision: `result-${offset}`, evaluatedAt: start + offset, tradeDate: offset < tomorrow ? day : nextDay,
    status: "completed" as const, rows,
    buySignals: buys.map(symbol => ({ symbol, signals: ["entry"] })),
    sellSignals: sells.map(symbol => ({ symbol, signals: ["exit"] })),
  };
}

function unavailable(offset: number): TspStrategyMonitorCapture {
  return { revision: `unavailable-${offset}`, evaluatedAt: start + offset, tradeDate: day, status: "unavailable" };
}

test("seeds a completed baseline, keeps missing results separate and deduplicates each signal side by Shanghai date", () => {
  const captures = [
    unavailable(0),
    complete(1, [{ symbol: c, score: 20 }, { symbol: a, score: 10 }, { symbol: b, score: 9 }], [a, b], [b]),
    complete(2, [{ symbol: a, score: 20 }, { symbol: b, score: 10 }, { symbol: c, score: 21 }, { symbol: d, score: null }],
      [a, b, c, d], [a, b, c]),
    unavailable(3),
    complete(4),
    complete(5, [{ symbol: b, score: 10 }], [b], [c]),
    complete(tomorrow, [{ symbol: b, score: 10 }], [b], [c]),
  ];
  const scopedRule = { ...rule, scoreMin: 10, scoreMax: 20 };
  const report = replayTspStrategyMonitor({ rule: scopedRule, captures });
  expect(report).toMatchObject({ producer: "whyj", formulaVersion: 1, referenceRevision: TSP_INDICATOR_REVISION,
    ruleId: rule.id, ruleRevision: rule.revision, strategyId: rule.strategyId, strategyRevision: rule.strategyRevision, assetType: "stock" });
  expect(report.evaluations.map(({ status, pool, events }) => [status, pool,
    events.map(({ kind, members }) => [kind, members.map(member => member.symbol)])])).toEqual([
    ["unavailable", null, []],
    ["baseline", [a, c], []],
    ["completed", [a, b], [["buy_signal", [b]], ["sell_signal", [a]], ["sell_signal", [c]], ["pool_entry", [b]], ["pool_exit", [c]]]],
    ["unavailable", [a, b], []],
    ["completed", [], [["pool_exit", [a]], ["pool_exit", [b]]]],
    ["completed", [b], [["pool_entry", [b]]]],
    ["completed", [b], [["buy_signal", [b]], ["sell_signal", [c]]]],
  ]);
  expect(report.evaluations[2]).toMatchObject({ captureRevision: "result-2", evaluatedAt: start + 2, tradeDate: day });
  expect(report.evaluations[2]!.events[0]).toEqual({ kind: "buy_signal", batch: false, members: [{ symbol: b, signals: ["entry"] }] });
  expect(replayTspStrategyMonitor({ rule: scopedRule, captures })).toEqual(report);
});

test("applies independent cooldowns to symbols and batches and emits a batch again at exact expiry", () => {
  const symbols = Array.from({ length: 6 }, (_, index) => `51000${index + 1}.SH`);
  const rows = [...symbols].reverse().map(symbol => ({ symbol, score: null }));
  const extra = "510007.SH";
  const captures = [complete(0), complete(10, rows, symbols), complete(11), complete(20, rows, symbols, symbols),
    complete(30), complete(110, rows), complete(111, [...rows, { symbol: extra, score: null }])];
  const etfRule = { ...rule, assetType: "etf" as const, cooldownMs: 100 };
  const report = replayTspStrategyMonitor({ rule: etfRule, captures });
  expect(report.assetType).toBe("etf");
  expect(report.evaluations.map(({ events, suppressedCount }) =>
    [events.map(({ kind, batch }) => [kind, batch]), suppressedCount])).toEqual([
    [[], 0], [[["buy_signal", true], ["pool_entry", true]], 0],
    [[["pool_exit", true]], 0], [[["sell_signal", true]], 1], [[], 1],
    [[["pool_entry", true]], 0], [[["pool_entry", false]], 0],
  ]);
  expect(report.evaluations[1]!.events[0]!.members).toEqual(symbols.map(symbol => ({ symbol, signals: ["entry"] })));
  expect(report.evaluations[6]!.events[0]!.members).toEqual([{ symbol: extra, signals: [] }]);
  const exitsOnly = replayTspStrategyMonitor({ rule: { ...etfRule, eventTypes: ["pool_exit"] }, captures });
  expect(exitsOnly.evaluations.flatMap(({ events }) => events.map(event => event.kind))).toEqual(["pool_exit"]);
});

test("rejects ambiguous scopes, malformed evidence, unordered captures and duplicate identities", () => {
  const first = complete(0, [{ symbol: a, score: 10 }]);
  const second = complete(1, [{ symbol: a, score: 10 }], [a]);
  const run = (...captures: TspStrategyMonitorCapture[]) => replayTspStrategyMonitor({ rule, captures });
  expect(() => run(second, first)).toThrow("unordered");
  expect(() => run(first, { ...second, revision: first.revision })).toThrow("duplicate");
  expect(() => run({ ...first, tradeDate: nextDay })).toThrow("capture");
  expect(() => run({ ...first, rows: [{ symbol: "510001.SH", score: 10 }] })).toThrow("symbol");
  expect(() => run({ ...first, rows: [{ symbol: a, score: NaN }] })).toThrow("score");
  expect(() => run({ ...first, rows: [first.rows[0]!, first.rows[0]!] })).toThrow("duplicate");
  expect(() => run({ ...second, buySignals: [second.buySignals[0]!, second.buySignals[0]!] })).toThrow("duplicate");
  expect(() => run({ ...second, buySignals: [{ symbol: a, signals: ["entry", "entry"] }] })).toThrow("signal IDs");
  const inconsistent = { ...first, status: "unavailable" as const };
  expect(() => run(inconsistent)).toThrow("has result rows");
  expect(() => replayTspStrategyMonitor({ rule: { ...rule, scoreMin: 20, scoreMax: 10 }, captures: [] })).toThrow("rule");
  expect(() => replayTspStrategyMonitor({ rule: { ...rule, strategyRevision: " " }, captures: [] })).toThrow("rule");
});

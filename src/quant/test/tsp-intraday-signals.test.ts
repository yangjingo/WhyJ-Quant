import { expect, test } from "bun:test";
import { computeTspIntraday, computeTspIntradaySignal, parseTspIntradaySignalRule, type TspIntradaySignalRule } from "../index.ts";

const date = "2024-03-04";
const bar = (minute: string, close: number, tradingDate = date) => ({
  tradingDate, minute, open: close, high: close, low: close, close, volumeShares: 100, amountCny: close * 100,
});

test("emits a daily rising edge and never delays a suppressed early event", () => {
  const rows = computeTspIntraday([
    bar("09:30", 11), bar("09:31", 9), bar("09:32", 11), bar("09:33", 12),
    bar("09:34", 8), bar("09:35", 11), bar("09:36", 9), bar("09:38", 12),
    bar("09:39", 9), bar("09:40", 11), bar("11:29", 9), bar("13:00", 11),
    bar("09:30", 11, "2024-03-05"),
  ]);
  const rule: TspIntradaySignalRule = { id: "price_above", minBars: 4, conditions: [{ left: "price", op: ">", right: 10 }] };
  const result = computeTspIntradaySignal(rows, rule);
  expect(result.filter(row => row.triggered).map(row => row.minute)).toEqual(["09:35", "09:40", "13:00"]);
  for (const index of [0, 2, 3, 7, 12]) expect(result[index]).toMatchObject({ conditionMet: true, triggered: false });
});

test("supports inclusive-prior crossings, dynamic fields, and false conditions on missing operands", () => {
  const rows = computeTspIntraday([bar("09:30", 10), bar("09:31", 11), bar("09:32", 12), bar("09:33", 9),
    bar("09:34", 8), bar("09:35", 13), bar("09:36", 14), bar("09:37", 9), bar("09:38", 12)]);
  const vwaps = [10, 10, 10, 10, null, 10, 10, 10, 10];
  rows.forEach((row, i) => { row.values.vwap = vwaps[i] ?? null; });
  const conditions = [
    { left: "price", op: "cross_up", right: { field: "vwap" } },
    { left: "price", op: "<=", right: 12 },
  ] as const;
  const up = computeTspIntradaySignal(rows, { id: "vwap_up", conditions });
  expect(up.filter(row => row.triggered).map(row => row.minute)).toEqual(["09:31", "09:38"]);
  expect(up[5]?.conditionMet).toBe(false);
  const down = computeTspIntradaySignal(rows, { id: "threshold_down", conditions: [{ left: "price", op: "cross_down", right: 10 }] });
  expect(down.filter(row => row.triggered).map(row => row.minute)).toEqual(["09:33", "09:37"]);
});

test("normalizes default minimum and rejects invalid rules and rows", () => {
  const rule = { id: "minute", conditions: [{ left: "price", op: "==", right: 10 }] } as const;
  expect(parseTspIntradaySignalRule(rule)).toEqual({ ...rule, minBars: 0 });
  for (const invalid of [
    { ...rule, id: "bad-id" }, { ...rule, minBars: 241 }, { ...rule, conditions: [] },
    { ...rule, conditions: [{ left: "price", op: ">", right: Infinity }] },
    { ...rule, conditions: [{ left: "price", op: ">", right: { field: "unknown" } }] },
    { ...rule, conditions: [{ left: "price", op: ">", right: 10, leftDays: 1 }] },
  ]) expect(() => parseTspIntradaySignalRule(invalid)).toThrow();
  const [row] = computeTspIntraday([bar("09:30", 10)]);
  expect(() => computeTspIntradaySignal([row!, row!], rule)).toThrow("unordered");
});

import { expect, test } from "bun:test";
import { computeTspDailySignals, computeTspLimitStreaks, tspTradingLimitThresholds } from "../index.ts";

const sessions = ["2024-11-14", "2024-11-15", "2024-11-18", "2024-11-19", "2024-11-20"];

function signal(index: number, up: boolean | null, down: boolean | null) {
  return { date: sessions[index]!, values: { signal_limit_up: up, signal_limit_down: down } };
}

test("exchange closing flags build directional streaks across a weekend", () => {
  const closes = [9, 10, 11, 9, 8];
  const limits = [[10, 8], [10, 8], [11, 9], [12, 9], [10, 8]] as const;
  const signals = computeTspDailySignals(sessions.map((date, index) => {
    const close = closes[index]!;
    const [up, down] = limits[index]!;
    return { date, open: close, high: close, low: close, close, volume: 100,
      raw_close: close, raw_high: close, raw_low: close, ...tspTradingLimitThresholds(up, down) };
  }));
  const result = computeTspLimitStreaks(sessions, signals);
  expect(result.map(({ date }) => date)).toEqual(sessions);
  expect(result.map(row => row.consecutiveLimitUps)).toEqual([0, 1, 2, 0, 0]);
  expect(result.map(row => row.consecutiveLimitDowns)).toEqual([0, 0, 0, 1, 2]);
});

test("a missing observation and a left-censored run remain unknown until a verified reset", () => {
  const result = computeTspLimitStreaks(sessions, [signal(0, true, false), signal(2, true, false),
    signal(3, false, null), signal(4, true, false)]);
  expect(result.map(row => row.consecutiveLimitUps)).toEqual([null, null, null, 0, 1]);
  expect(result.map(row => row.consecutiveLimitDowns)).toEqual([0, null, 0, null, 0]);
  expect(computeTspLimitStreaks([], [])).toEqual([]);
});

test("invalid calendars and invalid observations cannot start or extend a run", () => {
  expect(() => computeTspLimitStreaks(["2024-02-30"], [])).toThrow("exchange sessions");
  expect(() => computeTspLimitStreaks(sessions.toReversed(), [])).toThrow("exchange sessions");
  expect(() => computeTspLimitStreaks([sessions[0]!, sessions[0]!], [])).toThrow("exchange sessions");
  expect(() => computeTspLimitStreaks(sessions, [signal(0, true, true)])).toThrow("signal observations");
  expect(() => computeTspLimitStreaks(sessions, [signal(0, false, false), signal(0, null, false)])).toThrow("signal observations");
  expect(() => computeTspLimitStreaks(sessions.slice(1), [signal(0, false, false)])).toThrow("signal observations");
});

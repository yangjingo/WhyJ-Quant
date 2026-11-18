import { expect, test } from "bun:test";
import { computeTspIntraday, TSP_INDICATOR_REVISION, TSP_INTRADAY_FORMULA_VERSION } from "../index.ts";
import type { TspCompletedMinuteBar, TspIntradaySignals, TspIntradayValues } from "../index.ts";
import fixture from "./fixtures/tsp-intraday.json";

test("all minute features and crossing rules match the pinned TSP minute frame", () => {
  expect(fixture.revision).toBe(TSP_INDICATOR_REVISION);
  expect(TSP_INTRADAY_FORMULA_VERSION).toBe(1);
  const bars = fixture.bars.map(([tradingDate, minute, open, high, low, close, volumeShares, amountCny]) =>
    ({ tradingDate, minute, open, high, low, close, volumeShares, amountCny }) as TspCompletedMinuteBar);
  const rows = computeTspIntraday(bars, fixture.previousCloses);
  const features = fixture.features as (keyof TspIntradayValues)[];
  const signals = fixture.signals as (keyof TspIntradaySignals)[];
  expect(features).toHaveLength(11);
  expect(signals).toHaveLength(4);
  for (const [i, row] of rows.entries()) {
    const expected = fixture.expected[i]!;
    for (const [j, field] of features.entries()) {
      const value = expected[j];
      if (typeof value === "number") expect(row.values[field], `${i}:${field}`).toBeCloseTo(value, 11);
      else expect(row.values[field], `${i}:${field}`).toBeNull();
    }
    for (const [j, field] of signals.entries()) {
      // TSP's event-only view suppresses unavailable first-bar signals to false.
      const value = expected[j + features.length];
      if (typeof value !== "boolean") throw new Error(`Missing upstream signal ${field} at row ${i}`);
      expect(row.signals[field], `${i}:${field}`).toBe(row.minute === "09:30" ? null : value);
    }
  }
  for (const field of signals) expect(rows.some(row => row.signals[field])).toBe(true);
  for (const length of [1, 29, 30, 120, 121, 133]) {
    expect(computeTspIntraday(bars.slice(0, length), fixture.previousCloses)).toEqual(rows.slice(0, length));
  }
});

const minuteBar = (minute: string, changes: Partial<TspCompletedMinuteBar> = {}): TspCompletedMinuteBar => ({
  tradingDate: "2026-01-05", minute, open: 10, high: 12, low: 8, close: 10, volumeShares: 100, amountCny: 1000, ...changes,
});

test("missing minutes and values preserve uncertainty without blocking independent, complete operands", () => {
  const rows = computeTspIntraday([
    minuteBar("09:30", { volumeShares: 0, amountCny: 0 }),
    minuteBar("09:31"),
    minuteBar("09:32", { volumeShares: 0, amountCny: 0, low: null }),
    minuteBar("09:34", { close: 11, amountCny: null }),
    minuteBar("09:35", { close: 9 }),
    minuteBar("13:00"),
    minuteBar("09:30", { tradingDate: "2026-01-06" }),
  ], { "2026-01-05": 10.5 });

  expect(rows[0]!.values.vwap).toBeNull();
  expect(rows[1]!.values.vol_ratio_1m_today).toBeNull();
  expect(rows[2]!.values).toMatchObject({ vwap: 10, vol_ratio_1m_today: 0, day_low_dist: null });
  expect(rows[2]!.values.day_high_dist).toBeCloseTo(-1 / 6, 12);
  expect(rows[3]!.values).toMatchObject({ vwap: null, day_high_dist: null, vol_ratio_1m_today: null, open_30m_high_dist: null });
  expect(rows[3]!.signals.signal_intraday_zero_cross_up).toBeNull();
  expect(rows[4]!.values).toMatchObject({ vwap: null, vol_ratio_1m_today: 1 });
  expect(rows[4]!.signals).toMatchObject({ signal_intraday_zero_cross_down: true, signal_intraday_avg_cross_down: null });
  expect(rows[5]!.values.vol_ratio_1m_today).toBeNull();
  expect(rows[6]!.values).toMatchObject({ vwap: 10, pct_vs_prev_close: null, pct_from_open: 0 });

  const [truncated] = computeTspIntraday([minuteBar("09:35")]);
  expect(truncated!.values).toMatchObject({ price: 10, vwap: null, pct_from_open: null, day_low_dist: null });
  const [zeroAmount] = computeTspIntraday([minuteBar("09:30", { amountCny: 0 })]);
  expect(zeroAmount!.values.vwap).toBe(0);
});

test("rejects out-of-session, misordered, duplicate, and malformed minute inputs", () => {
  for (const minute of ["09:29", "9:30", "11:30", "12:59", "15:00", "09:60"]) {
    expect(() => computeTspIntraday([minuteBar(minute)])).toThrow("completed A-share minute bars");
  }
  expect(() => computeTspIntraday([minuteBar("09:31"), minuteBar("09:30")])).toThrow("unordered");
  expect(() => computeTspIntraday([minuteBar("09:30"), minuteBar("09:30")])).toThrow("unordered");
  expect(() => computeTspIntraday([minuteBar("09:30", { high: 9 })])).toThrow("Invalid");
  expect(() => computeTspIntraday([minuteBar("09:30", { volumeShares: -1 })])).toThrow("Invalid");
  expect(() => computeTspIntraday([], { "2026-01-05": 0 })).toThrow("Invalid intraday previous close");
  expect(computeTspIntraday([])).toEqual([]);
});

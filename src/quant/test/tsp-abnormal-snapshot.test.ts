import { expect, test } from "bun:test";
import { rankTspAbnormalSnapshot, TSP_ABNORMAL_SNAPSHOT_SIGNALS, type TspAbnormalSnapshotObservation } from "../index.ts";

const date = "2024-03-04";
type Flags = TspAbnormalSnapshotObservation["signals"];
const signalValues = Object.fromEntries(TSP_ABNORMAL_SNAPSHOT_SIGNALS.map(([id]) => [id, false])) as Flags;
const stock = (code: number, changeFraction: number | null, flags: Partial<Flags>): TspAbnormalSnapshotObservation => ({
  symbol: `${600000 + code}.SH`, changeFraction, signals: { ...signalValues, ...flags },
});

test("counts every hit and ranks seven categories before applying the limit", () => {
  const input = [
    stock(9, 0.30, { signal_volume_surge: true }),
    stock(5, -0.20, { signal_limit_down: true }),
    stock(3, -0.13, { signal_limit_down_recovery: true }),
    stock(8, -0.17, { signal_n_day_low: true }),
    stock(1, 0.05, { signal_limit_up: true, signal_n_day_high: true, signal_volume_surge: true }),
    stock(4, -0.07, { signal_broken_limit_up: true }),
    stock(6, 0.07, { signal_broken_limit_up: true }),
    stock(2, 0.08, { signal_broken_limit_up: true }),
    stock(7, 0, { signal_n_day_high: true, signal_n_day_low: null }),
    stock(10, null, { signal_limit_up: null }),
  ];
  const full = rankTspAbnormalSnapshot(date, input);
  expect(full.rows.map(row => row.symbol)).toEqual([1, 2, 4, 6, 3, 5, 7, 8, 9].map(code => `${600000 + code}.SH`));
  expect(full.rows[0]?.signals).toEqual(["limit_up", "new_high", "volume_surge"]);
  expect(full.rows[6]?.changeFraction).toBe(0);
  const limited = rankTspAbnormalSnapshot(date, input, 1);
  expect(limited).toMatchObject({
    tradeDate: date, scopedCount: 10, matchedCount: 9,
    counts: { limit_up: 1, broken: 3, recovery: 1, limit_down: 1, new_high: 2, new_low: 1, volume_surge: 2 },
    unknown: { limit_up: 1, new_low: 1 },
  });
  expect(limited.rows).toEqual(full.rows.slice(0, 1));
});

test("retains unknown counts on an empty match set and rejects malformed snapshots", () => {
  const unknown = stock(1, null, { signal_limit_up: null });
  expect(rankTspAbnormalSnapshot(date, [unknown])).toMatchObject({
    rows: [], matchedCount: 0, counts: { limit_up: 0 }, unknown: { limit_up: 1 },
  });
  expect(() => rankTspAbnormalSnapshot(date, [unknown, unknown])).toThrow("duplicate");
  expect(() => rankTspAbnormalSnapshot("2024-02-30", [unknown])).toThrow("date");
  expect(() => rankTspAbnormalSnapshot(date, [unknown], 2_001)).toThrow("limit");
  expect(() => rankTspAbnormalSnapshot(date, [stock(1, NaN, {})])).toThrow("observation");
});

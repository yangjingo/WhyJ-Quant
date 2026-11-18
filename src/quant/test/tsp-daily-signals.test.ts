import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computeTspDailySignals, TSP_DAILY_SIGNAL_FIELDS, TSP_DAILY_SIGNAL_FORMULA_VERSION, TSP_INDICATOR_REVISION,
  type TspDailySignalBar, type TspDailySignalId } from "../index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tsp-daily-signals.json", import.meta.url), "utf8")) as {
  revision: string; fields: TspDailySignalId[]; bars: TspDailySignalBar[]; rows: (boolean | null)[][];
};

test("matches all pinned daily rules when their operands are available", () => {
  expect(TSP_DAILY_SIGNAL_FORMULA_VERSION).toBe(1);
  expect(TSP_INDICATOR_REVISION).toBe(fixture.revision);
  expect(TSP_DAILY_SIGNAL_FIELDS).toEqual(fixture.fields);
  expect(TSP_DAILY_SIGNAL_FIELDS).toHaveLength(20);
  const actual = computeTspDailySignals(fixture.bars);
  expect(actual).toHaveLength(fixture.rows.length);
  const hits = new Set<TspDailySignalId>();
  for (const [i, { date, values }] of actual.entries()) {
    expect(date).toBe(fixture.bars[i]!.date);
    for (const [column, key] of fixture.fields.entries()) {
      expect(values[key], `${date}: ${key}`).toBe(fixture.rows[i]![column]!);
      if (values[key]) hits.add(key);
    }
  }
  expect(hits.size).toBe(20);
});

test("preserves unavailable exchange observations and never uses future bars", () => {
  const bars = fixture.bars.map(({ date, open, high, low, close, volume }) => ({ date, open, high, low, close, volume }));
  const full = computeTspDailySignals(bars);
  expect(full[0]!.values).toMatchObject({ signal_macd_golden: null, signal_n_day_high: null, signal_volume_surge: null });
  expect(full.at(-1)!.values).toMatchObject({ signal_limit_up: null, signal_limit_down: null,
    signal_broken_limit_up: null, signal_limit_down_recovery: null });
  expect(typeof full.at(-1)!.values.signal_macd_dead).toBe("boolean");
  expect(computeTspDailySignals(bars.slice(0, 70))).toEqual(full.slice(0, 70));
  expect(() => computeTspDailySignals([{ ...bars[0]!, limit_up_price: -1 }])).toThrow("signal price observations");
});

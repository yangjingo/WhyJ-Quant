import { expect, test } from "bun:test";
import { computeTspQuotePollDelta, TSP_INDICATOR_REVISION, type TspQuotePollDeltaInput } from "../index.ts";

const tradingDate = "2025-01-03";
const at = (time: string, date = tradingDate) => Date.parse(date + "T" + time + "+08:00");
const symbols = Array.from({ length: 8 }, (_, i) => `60000${i + 1}.SH`);
const row = (index: number, timestamp: number, volume: number, amount: number | null) =>
  ({ symbol: symbols[index]!, timestamp, volume, amount });
const before = at("09:30:10"), after = at("09:30:20");

const snapshot: TspQuotePollDeltaInput = {
  tradingDate, requestedSymbols: symbols, volumeUnit: "hand", amountUnit: "CNY",
  rule: { metric: "amount", threshold: 3000 },
  previous: { observedAt: before, rows: [
    row(0, before, 1000, 2000), row(1, before, 200, 1000), row(2, before, 200, 1000),
    row(3, before, 200, 1000), row(4, before, 100, null), row(6, before, 500, 1000),
    row(7, at("09:25:00"), 100, 1000),
  ] },
  current: { observedAt: after, rows: [
    row(0, after, 1300, 5000), row(1, after, 200, 5000), row(2, after, 100, 2000),
    row(3, after, 300, 500), row(4, after, 200, null), row(5, after, 100, 1000),
    row(6, before, 500, 1000), row(7, after, 1000, 6000),
  ] },
};

test("replays positive paired counters, retains zero and skips reset or stale evidence", () => {
  const report = computeTspQuotePollDelta(snapshot);
  expect(report).toMatchObject({
    producer: "whyj", formula: { id: "tsp_quote_poll_delta", version: 1, revision: TSP_INDICATOR_REVISION },
    status: "comparable", session: "morning", pollSpanMs: 10_000, observedSymbols: 3,
  });
  expect(report.rows.map(row => [row.availability, row.nativeVolumeDelta, row.nativeAmountDelta, row.triggered])).toEqual([
    ["observed", 300, 3000, true], ["observed", 0, 4000, false], ["counter-reset", null, null, null],
    ["counter-reset", null, null, null], ["observed", 100, null, null], ["missing-previous", null, null, null],
    ["nonadvancing-quote", null, null, null], ["off-session-quote", null, null, null],
  ]);
  expect(computeTspQuotePollDelta({ ...snapshot, volumeUnit: "share", amountUnit: "CNY-thousand",
    rule: { metric: "volume", threshold: 3 } }).rows[0]).toMatchObject({
    nativeVolumeDelta: 300, volumeDeltaHands: 3, amountDeltaCny: 3_000_000, triggered: true,
  });
  expect(computeTspQuotePollDelta({ ...snapshot, amountUnit: "unknown", volumeUnit: "unknown" }).rows[0]).toMatchObject({
    nativeVolumeDelta: 300, nativeAmountDelta: 3000, volumeDeltaHands: null, amountDeltaCny: null, triggered: null,
  });
});

test("skips first polls, opening transitions, lunch and different Shanghai dates", () => {
  const current = (observedAt: number) => ({ observedAt, rows: [] });
  const status = (previous: number | undefined, next: number) => computeTspQuotePollDelta({
    ...snapshot, previous: previous === undefined ? undefined : current(previous), current: current(next),
  }).status;
  expect(status(undefined, after)).toBe("missing-previous");
  expect(status(at("09:25:00"), at("09:30:00"))).toBe("session-boundary");
  expect(status(at("11:30:00"), at("11:30:00.001"))).toBe("outside-session");
  expect(status(at("11:30:00"), at("13:00:01"))).toBe("session-boundary");
  expect(status(at("12:59:59"), at("13:00:00"))).toBe("session-boundary");
  expect(status(at("13:00:00"), at("15:00:00"))).toBe("comparable");
  expect(status(at("15:00:00", "2025-01-02"), at("09:31:00"))).toBe("session-boundary");
  expect(computeTspQuotePollDelta({ ...snapshot, tradingDate: "2025-01-04",
    previous: current(at("09:40:00", "2025-01-04")), current: current(at("09:45:00", "2025-01-04")) }).status).toBe("outside-session");
});

test("rejects ambiguous scope, future timestamps, non-finite counters and reordered polls", () => {
  expect(() => computeTspQuotePollDelta({ ...snapshot, requestedSymbols: [symbols[0]!, symbols[0]!] })).toThrow("Duplicate");
  expect(() => computeTspQuotePollDelta({ ...snapshot, rule: { metric: "volume", threshold: 0 } })).toThrow("scope");
  for (const rejected of [row(0, after + 1, 1, 100), row(0, after, NaN, 100), row(0, after, 100, Infinity)]) {
    expect(() => computeTspQuotePollDelta({ ...snapshot, current: { observedAt: after, rows: [rejected] } })).toThrow("poll row");
  }
  expect(() => computeTspQuotePollDelta({ ...snapshot, previous: snapshot.current, current: snapshot.previous! }))
    .toThrow("increasing order");
});

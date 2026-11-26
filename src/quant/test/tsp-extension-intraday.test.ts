import { expect, test } from "bun:test";
import { computeTspExtensionIntraday, type TspExtensionIntradayInput, type TspExtensionIntradaySeries } from "../index.ts";

const tradeDate = "2025-06-18", previousDate = "2025-06-17";
const a = "600001.SH", b = "000002.SZ", c = "600003.SH", missing = "600004.SH";
const start = Date.parse(tradeDate + "T09:30:00+08:00");
const timestamp = (offset: number) => start + offset * 60_000;
const bar = (offset: number, close: number | null) => ({ timestamp: timestamp(offset), close });
const history = (symbol: string, price: number | null, bars: TspExtensionIntradaySeries["bars"]): TspExtensionIntradaySeries => ({
  symbol, minuteRevision: "minute-" + symbol, previousClose: { tradeDate: previousDate, revision: "prior-" + symbol, price }, bars,
});
const input: TspExtensionIntradayInput = {
  tradeDate, previousDate, adjustment: "none",
  membership: { datasetId: "flow_demo", revision: "membership-fixture", field: "tag", value: "A", symbols: [a, b, missing] },
  universe: { id: "fixed", revision: "market-fixture", symbols: [a, b, c] },
  histories: [
    history(a, 100, [bar(1, 110), bar(3, 130), bar(4, 132)]),
    history(b, 0, [bar(1, 0), bar(2, 50), bar(4, 55)]),
    history(c, 100, [bar(0, 100), bar(1, 102), bar(2, 103), bar(3, null), bar(4, 104)]),
  ],
};

test("uses separate market and member denominators, a mixed baseline and the reference price cap", () => {
  const result = computeTspExtensionIntraday(input);
  expect(result).toMatchObject({
    status: "ok", producer: "whyj", basis: "mixed", memberPolicy: "forward-fill", tradeDate, previousDate,
    coverage: { memberCount: 3, membersWithMinute: 2, marketCount: 3, marketWithMinute: 3,
      fromPreviousClose: 2, fromFirstClose: 1, invalidCloses: 2, outOfBoundReturns: 1 },
  });
  expect(result.baselines[0]).toMatchObject({ symbol: a, minuteRevision: "minute-" + a, priorRevision: "prior-" + a,
    baseline: { basis: "prev_close", price: 100 } });
  expect(result.baselines[1]).toMatchObject({ symbol: b, baseline: { basis: "first_close", price: 50, timestamp: timestamp(2) } });
  expect(result.points).toEqual([
    { timestamp: timestamp(0), sector: null, sectorCount: 0, market: 0, marketCount: 1 },
    { timestamp: timestamp(1), sector: 0.1, sectorCount: 1, market: 0.06, marketCount: 2 },
    { timestamp: timestamp(2), sector: 0.05, sectorCount: 2, market: 0.015, marketCount: 2 },
    { timestamp: timestamp(3), sector: 0.15, sectorCount: 2, market: 0.3, marketCount: 1 },
    { timestamp: timestamp(4), sector: 0.2, sectorCount: 2, market: 0.07, marketCount: 2 },
  ]);
});

test("carries 2,000 members and uses observed-only mode at 2,001", () => {
  const members = Array.from({ length: 2_001 }, (_, index) => String(600_000 + index) + ".SH");
  const stockOutside = "603001.SH";
  const replay = (count: number) => {
    const symbols = members.slice(0, count);
    return computeTspExtensionIntraday({
      ...input, membership: { ...input.membership, symbols }, universe: { ...input.universe, symbols: [...symbols, stockOutside] },
      histories: [...symbols.map(symbol => history(symbol, 100, [bar(1, 110)])), history(stockOutside, 100, [bar(2, 100)])],
    });
  };
  const carried = replay(2_000);
  expect(carried.memberPolicy).toBe("forward-fill");
  expect(carried.points[1]).toMatchObject({ sector: 0.1, sectorCount: 2_000, market: 0, marketCount: 1 });
  const observed = replay(2_001);
  expect(observed.memberPolicy).toBe("observed-only");
  expect(observed.points[1]).toMatchObject({ sector: null, sectorCount: 0, market: 0, marketCount: 1 });
});

test("distinguishes empty membership, no input and no observed members", () => {
  expect(computeTspExtensionIntraday({ ...input, membership: { ...input.membership, symbols: [] } }))
    .toMatchObject({ status: "empty", reason: "no_members", points: [] });
  expect(computeTspExtensionIntraday({ ...input, histories: [] }))
    .toMatchObject({ status: "no_data", reason: "no_minute_evidence", points: [], basis: null });
  expect(computeTspExtensionIntraday({ ...input, histories: [history(c, null, [bar(1, 100)])] }))
    .toMatchObject({ status: "empty", reason: "no_member_bars", points: [], basis: "first_close" });
});

test("rejects duplicated, wrong-date and out-of-universe inputs", () => {
  expect(() => computeTspExtensionIntraday({ ...input, membership: { ...input.membership, symbols: new Array<string>(1) } }))
    .toThrow("symbol scope");
  expect(() => computeTspExtensionIntraday({ ...input, histories: [input.histories[0]!, input.histories[0]!] })).toThrow("intraday history");
  expect(() => computeTspExtensionIntraday({ ...input, histories: [history(a, 100, [bar(0, 101), bar(0, 102)])] })).toThrow("intraday minute");
  expect(() => computeTspExtensionIntraday({ ...input, histories: [history(a, 100, [bar(-1_440, 100)])] })).toThrow("intraday minute");
  expect(() => computeTspExtensionIntraday({ ...input, previousDate: "2025-06-16" })).toThrow("prior close");
  expect(() => computeTspExtensionIntraday({ ...input, previousDate: null, histories: [{
    ...history(a, 100, [bar(0, 102)]), previousClose: { tradeDate: null!, revision: "prior", price: 100 },
  }] })).toThrow("prior close");
  expect(() => computeTspExtensionIntraday({ ...input, histories: [history(missing, 100, [bar(0, 102)])] })).toThrow("intraday history");
});

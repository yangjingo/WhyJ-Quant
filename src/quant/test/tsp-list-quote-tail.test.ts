import { expect, test } from "bun:test";
import { computeTspListIntraday, projectTspListQuoteTail, type TspListQuoteTailInput } from "../index.ts";

const symbol = "600000.SH", tradeDate = "2025-06-18";
const stamp = (time: string, date = tradeDate) => Date.parse(date + "T" + time + "+08:00");

const first = Object.freeze({
  tradingDate: tradeDate, minute: "09:30", open: 10, high: 10, low: 10, close: 10, volumeShares: 100, amountCny: 1_000,
});
const last = Object.freeze({
  tradingDate: tradeDate, minute: "09:31", open: 10, high: 11, low: 10, close: 11, volumeShares: 0, amountCny: 0,
});
const bars = Object.freeze([first, last]);
const input: TspListQuoteTailInput = {
  symbol, tradeDate, bars, frameObservedAt: stamp("09:31:05"), asOf: stamp("09:31:59"),
  maxQuoteAgeMs: 30_000, quote: { symbol, timestamp: stamp("09:31:31"), price: 12 },
};

test("updates only the displayed minute tail and preserves source volume including zero", () => {
  const projected = projectTspListQuoteTail(input);
  expect(projected).toMatchObject({ producer: "whyj", status: "updated", formula: { id: "tsp_list_quote_tail", version: 1 },
    applied: { quoteTimestamp: stamp("09:31:31"), minute: "09:31", price: 12, finality: "provisional" },
    bars: [first, { ...last, close: 12, high: 12 }] });
  expect(projected.bars[0]).toBe(first);
  expect(bars[1]).toMatchObject({ close: 11, high: 11, low: 10 });
  const chart = computeTspListIntraday({ tradeDate, bars: projected.bars, previousClose: 10 });
  expect(chart.points.at(-1)).toMatchObject({ close: 12, averageClose: 11, previousCloseReturnFraction: 12 / 10 - 1 });
  const lower = projectTspListQuoteTail({ ...input, quote: { ...input.quote!, price: 9 } });
  expect(lower.bars[1]).toMatchObject({ open: 10, high: 11, low: 9, close: 9, volumeShares: 0 });
  const unknown = projectTspListQuoteTail({ ...input, bars: [first, { ...last, high: null, low: null }] });
  expect(unknown.bars[1]).toMatchObject({ high: null, low: null, close: 12 });
});

test("appends an ETF display point with unknown quantities, and retains earlier source bars", () => {
  const etf = "510300.SH";
  const projected = projectTspListQuoteTail({ ...input, symbol: etf, asOf: stamp("09:32:10"),
    quote: { symbol: etf, price: 10.2, timestamp: stamp("09:32:00") } });
  expect(projected).toMatchObject({ status: "appended", applied: { minute: "09:32", finality: "provisional" },
    bars: [first, last, { tradingDate: tradeDate, minute: "09:32", open: 10.2, high: 10.2, low: 10.2,
      close: 10.2, volumeShares: null, amountCny: null }] });
  expect(projected.bars[1]).toBe(last);
  expect(bars).toHaveLength(2);
});

test("allows the first normalized afternoon minute and skips weekends", () => {
  const afternoon = projectTspListQuoteTail({ ...input, frameObservedAt: stamp("12:59:59"), asOf: stamp("13:00:10"),
    quote: { symbol, timestamp: stamp("13:00:00"), price: 12 } });
  expect(afternoon).toMatchObject({ status: "appended", applied: { minute: "13:00" } });

  const saturday = "2025-06-21";
  const weekendBars = bars.map(bar => ({ ...bar, tradingDate: saturday }));
  const weekend = projectTspListQuoteTail({ ...input, tradeDate: saturday, bars: weekendBars,
    frameObservedAt: stamp("09:31:05", saturday), asOf: stamp("09:31:59", saturday),
    quote: { symbol, timestamp: stamp("09:31:31", saturday), price: 12 } });
  expect(weekend).toMatchObject({ status: "unchanged", reason: "out-of-session", applied: null });
  expect(weekend.bars).toBe(weekendBars);
});

test("keeps the provider chart when quotes lack matching, newer and active-session evidence", () => {
  const cases = [
    [{ ...input, bars: [] }, "empty"],
    [{ ...input, quote: null }, "missing-quote"],
    [{ ...input, quote: { ...input.quote!, symbol: "000001.SZ" } }, "mismatched-quote"],
    [{ ...input, quote: { ...input.quote!, timestamp: stamp("09:31:50", "2025-06-17") } }, "mismatched-quote"],
    [{ ...input, quote: { ...input.quote!, timestamp: stamp("09:31:59.001") } }, "stale-quote"],
    [{ ...input, maxQuoteAgeMs: 10_000 }, "stale-quote"],
    [{ ...input, asOf: stamp("09:31:25"), quote: { ...input.quote!, timestamp: input.frameObservedAt } }, "covered"],
    [{ ...input, frameObservedAt: stamp("09:30:01"), asOf: stamp("09:31:20"), maxQuoteAgeMs: 60_000,
      quote: { ...input.quote!, timestamp: stamp("09:30:21") } }, "covered"],
    [{ ...input, asOf: stamp("11:30:00"), maxQuoteAgeMs: 8_000_000 }, "out-of-session"],
    [{ ...input, asOf: stamp("13:00:00"), maxQuoteAgeMs: 14_000_000 }, "out-of-session"],
    [{ ...input, asOf: stamp("15:00:00") }, "out-of-session"],
  ] as const;
  for (const [candidate, reason] of cases) {
    const result = projectTspListQuoteTail(candidate);
    expect(result).toMatchObject({ status: "unchanged", reason, applied: null });
    expect(result.bars).toBe(candidate.bars);
  }
  expect(() => projectTspListQuoteTail({ ...input, bars: [last, first] })).toThrow("minute bars");
  expect(() => projectTspListQuoteTail({ ...input, frameObservedAt: stamp("09:32:01") })).toThrow("tail inputs");
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveQuotePollCapture, loadQuotePollArchive, loadValuationQuotePollArchive, saveSettings,
  type QuotePollArchiveRef, type StoredQuotePollCapture } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { replayTspPaperValuation, type PaperValuationReplayRequest } from "../data/paper-valuation-replay.ts";
import { collectQuotePollCapture, collectValuationQuotePollCapture, replayTspQuotePollDelta } from "../data/quote-poll-replay.ts";

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const symbols = Array.from({ length: 102 }, (_, i) => `${600001 + i}.SH`);
const first = symbols[0]!, last = symbols.at(-1)!;
const nativeRow = (symbol: string, timestamp: number) => ({ symbol, region: "CN", timestamp,
  last_price: 11, prev_close: 10, open: 10, high: 11, low: 10, volume: 1000, amount: null });

let root: string, previousRoot: string | undefined;
beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-quote-poll-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "quote-poll-fixture" } });
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

test("uses the configured Source in bounded batches and records actual receipt times and missing rows", async () => {
  const now = Date.now(), tradeDate = shanghai.format(now);
  const offDate = symbols[1]!, future = symbols[2]!;
  const requests: string[][] = [];
  const http = spyOn(globalThis, "fetch").mockImplementation((async (url, options) => {
    const route = new URL(String(url));
    expect(route.pathname).toBe("/v1/quotes");
    expect(new Headers(options?.headers).get("x-api-key")).toBe("quote-poll-fixture");
    requests.push(route.searchParams.get("symbols")!.split(","));
    return Response.json({ data: requests.length === 1
      ? [nativeRow(first, now), nativeRow(offDate, now - 86_400_000), nativeRow(future, now + 60_000)]
      : [nativeRow(last, now)] });
  }) as typeof fetch);
  try {
    const result = await collectQuotePollCapture({ tradeDate, symbols: symbols.toReversed() });
    expect(requests).toEqual([symbols.slice(0, 100), symbols.slice(100)]);
    expect(result).toMatchObject({ source: "tickflow", endpoint: "/v1/quotes", coverage: "unknown", units: "unknown",
      batches: 2, rowCount: 2, requestedSymbols: symbols, outsideCaptureSymbols: [offDate, future],
      missingSymbols: symbols.slice(1, -1) });
    const saved = await loadQuotePollArchive(result.ref);
    expect(saved).toMatchObject({ startedAt: result.startedAt, observedAt: result.observedAt,
      rows: [first, last].map(symbol => ({ symbol, timestamp: now, lastPrice: 11, previousClose: 10, volume: 1000, amount: null })) });
    expect(saved.rows.every(row => Date.parse(row.receivedAt) >= now && Date.parse(row.receivedAt) <= Date.parse(result.observedAt))).toBe(true);
  } finally { http.mockRestore(); }
});

test("commits no partial poll on a later provider failure", async () => {
  const tradeDate = shanghai.format(Date.now());
  const http = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: [nativeRow(first, Date.now())] }))
    .mockResolvedValueOnce(new Response("fixture failure", { status: 403 }));
  try {
    await expect(collectQuotePollCapture({ tradeDate, symbols }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    await expect(collectQuotePollCapture({ tradeDate, symbols })).rejects.toThrow("HTTP 403");
    expect(http).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "data", "quote-poll-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

test("collects a mixed valuation revision and replays exact stock and ETF marks offline", async () => {
  const timestamp = Date.now(), tradeDate = shanghai.format(timestamp);
  const zero = "159915.SZ", etf = "510300.SH", missing = "510500.SH";
  const requested = [zero, etf, missing, first];
  const http = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    data: [
      nativeRow(first, timestamp),
      { ...nativeRow(etf, timestamp), last_price: 4.5, prev_close: 4, open: 4, high: 5, low: 4 },
      { ...nativeRow(zero, timestamp), last_price: 0 },
    ],
  })).mockRejectedValue(new Error("Unexpected provider call"));
  try {
    await expect(collectValuationQuotePollCapture({ tradeDate, symbols: ["399001.SZ"] })).rejects.toThrow("quote poll scope");
    const result = await collectValuationQuotePollCapture({ tradeDate, symbols: requested.toReversed() });
    expect(result).toMatchObject({ ref: { kind: "valuation-quote-poll" }, requestedSymbols: requested, batches: 1,
      rowCount: 3, missingSymbols: [missing], outsideCaptureSymbols: [] });
    expect(await loadValuationQuotePollArchive(result.ref)).toMatchObject({ rows: [
      { symbol: zero, lastPrice: 0, timestamp }, { symbol: etf, lastPrice: 4.5, timestamp }, { symbol: first, lastPrice: 11, timestamp },
    ] });
    const input = {
      accountId: "mixed-fixture", currency: "CNY", tradeDate, basis: "snapshot", cash: 500, initialCash: 2000,
      priceBasisConfirmation: "caller-confirmed-unadjusted-CNY", valuationQuoteRef: result.ref,
      positions: [
        { symbol: first, currency: "CNY", assetType: "stock", quantity: 100, availableQuantity: 20, averageCost: 10 },
        { symbol: etf, currency: "CNY", assetType: "etf", quantity: 50, availableQuantity: 50, averageCost: 4 },
        { symbol: missing, currency: "CNY", assetType: "etf", quantity: 10, availableQuantity: 10, averageCost: 5 },
        { symbol: zero, currency: "CNY", assetType: "etf", quantity: 20, availableQuantity: 20, averageCost: 7 },
      ],
    } satisfies PaperValuationReplayRequest;
    const report = await replayTspPaperValuation(input);
    expect(report).toMatchObject({
      equity: 2015, totalPnl: 15, coverage: { marketMarks: 2, costFallbackSymbols: [zero, missing] },
      inputs: { quotePoll: { ref: result.ref, units: "unknown", quotes: [
        { symbol: zero, requested: true, price: 0, sourceTimestamp: timestamp },
        { symbol: etf, requested: true, price: 4.5, sourceTimestamp: timestamp, receivedAt: expect.any(String) },
        { symbol: missing, requested: true, price: null, sourceTimestamp: null, receivedAt: null },
        { symbol: first, requested: true, price: 11, sourceTimestamp: timestamp },
      ] } },
    });
    expect(await replayTspPaperValuation(input)).toEqual(report);
    await expect(replayTspPaperValuation({ ...input, tradeDate: "2025-01-01" })).rejects.toThrow("quote-poll date");
    const asStockRef = result.ref as unknown as QuotePollArchiveRef;
    await expect(replayTspPaperValuation({ ...input, valuationQuoteRef: undefined, quoteRef: asStockRef }))
      .rejects.toThrow("Invalid observation archive");
    await expect(replayTspPaperValuation({ ...input, quoteRef: asStockRef } as unknown as PaperValuationReplayRequest))
      .rejects.toThrow("archive scope");
    expect(http).toHaveBeenCalledTimes(1);
  } finally { http.mockRestore(); }
});

test("a canceled or partially failed valuation poll leaves no mixed archive", async () => {
  const now = Date.now(), tradeDate = shanghai.format(now), etf = "510300.SH";
  const http = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: [nativeRow(etf, now)] }))
    .mockResolvedValueOnce(new Response("fixture failure", { status: 403 }));
  try {
    const request = { tradeDate, symbols: [etf, ...symbols] };
    await expect(collectValuationQuotePollCapture(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    await expect(collectValuationQuotePollCapture(request)).rejects.toThrow("HTTP 403");
    expect(http).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "data", "valuation-quote-poll-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

test("replays two fixed revisions with exact scope and separates unknown units from caller declarations", async () => {
  const tradeDate = "2025-01-03";
  function capture(time: string, volume: number, amount: number, requestedSymbols = [first, last]): StoredQuotePollCapture {
    const timestamp = Date.parse(tradeDate + "T" + time + "+08:00");
    const observedAt = new Date(timestamp + 1000).toISOString();
    return { source: "tickflow", endpoint: "/v1/quotes", market: "A", tradeDate,
      startedAt: new Date(timestamp).toISOString(), observedAt, coverage: "unknown", units: "unknown", requestedSymbols,
      rows: [{ symbol: first, timestamp, receivedAt: observedAt, lastPrice: 11, previousClose: 10, volume, amount }] };
  }
  const [previousRef, currentRef, otherScope, afternoon, reset, empty, overlap] = await Promise.all([
    capture("09:30:00", 1000, 2000), capture("09:30:10", 1300, 5000), capture("09:30:30", 1500, 5100, [first]),
    capture("13:00:01", 1400, 6000), capture("09:30:30", 100, 5000), { ...capture("09:30:45", 1400, 7000), rows: [] },
    { ...capture("09:30:05", 1400, 6000), startedAt: "2025-01-03T01:30:00Z" },
  ].map(item => archiveQuotePollCapture(item)));
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider read is expected"));
  try {
    const request = { previousRef: previousRef!, currentRef: currentRef!, rule: { metric: "amount", threshold: 3000 } as const };
    const raw = await replayTspQuotePollDelta(request);
    expect(raw).toMatchObject({ status: "comparable", pollSpanMs: 10_000, amountUnit: "unknown",
      input: { previous: { ref: previousRef }, current: { ref: currentRef, units: "unknown" }, amountUnitBasis: "archive" },
      rows: [{ symbol: first, nativeVolumeDelta: 300, nativeAmountDelta: 3000, amountDeltaCny: null, triggered: null },
        { symbol: last, availability: "missing-previous" }] });
    const qualified = { ...request, volumeUnit: "share", amountUnit: "CNY" } as const;
    const result = await replayTspQuotePollDelta(qualified);
    expect(result.rows[0]).toMatchObject({ volumeDeltaHands: 3, amountDeltaCny: 3000, triggered: true });
    expect(result.input).toMatchObject({ amountUnitBasis: "caller-declared", current: { units: "unknown" } });
    expect(await replayTspQuotePollDelta(qualified)).toEqual(result);
    expect(await replayTspQuotePollDelta({ currentRef: currentRef! })).toMatchObject({ status: "missing-previous" });
    expect(await replayTspQuotePollDelta({ ...request, currentRef: afternoon! })).toMatchObject({ status: "session-boundary" });
    expect((await replayTspQuotePollDelta({ ...request, currentRef: reset! })).rows[0]?.availability).toBe("counter-reset");
    expect((await replayTspQuotePollDelta({ ...request, currentRef: empty! })).rows[0]?.availability).toBe("missing-current");
    await expect(replayTspQuotePollDelta({ ...request, currentRef: otherScope! })).rejects.toThrow("same requested symbols");
    await expect(replayTspQuotePollDelta({ ...request, currentRef: overlap! })).rejects.toThrow("nonoverlapping");
    await expect(replayTspQuotePollDelta(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

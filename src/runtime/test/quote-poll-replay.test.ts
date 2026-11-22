import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveQuotePollCapture, loadQuotePollArchive, saveSettings, type StoredQuotePollCapture } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectQuotePollCapture, replayTspQuotePollDelta } from "../data/quote-poll-replay.ts";

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

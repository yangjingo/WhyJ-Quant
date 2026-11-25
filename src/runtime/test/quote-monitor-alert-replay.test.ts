import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveQuotePollCapture, loadQuotePollArchive, saveSettings, type StoredQuotePollCapture } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectTspQuoteMonitorAlerts, replayTspQuoteMonitorAlerts, type CurrentQuoteMonitorRequest,
  type QuoteMonitorReplayRequest } from "../data/quote-monitor-alert-replay.ts";

const tradeDate = "2025-01-03", a = "600001.SH", b = "600002.SH", c = "600003.SH";
const time = Date.parse(`${tradeDate}T09:30:00+08:00`);
const roster = [a, b, c];
const basis = { priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "share", amountUnit: "CNY-thousand" } as const;
const rule: QuoteMonitorReplayRequest["rule"] = {
  id: "quote_thresholds", revision: "rule-v1", assetType: "stock", type: "price", scope: { kind: "all" },
  severity: "warn", logic: "and", cooldownMs: 60_000, conditions: [
    { field: "change_pct", op: ">", value: 0.08, unit: "fraction" },
    { field: "volume", op: ">=", value: 3, unit: "hand" },
    { field: "amount", op: ">=", value: 2_000, unit: "CNY" },
  ],
};

function iso(ms: number) { return new Date(ms).toISOString(); }

function rawQuote(symbol: string, observed: number, ageMs = 0, lastPrice = 11) {
  return { symbol, timestamp: observed - ageMs, receivedAt: iso(observed), lastPrice, previousClose: 10, volume: 300, amount: 2 };
}

function capture(offset: number, rows: StoredQuotePollCapture["rows"], symbols = roster, duration = 200) {
  return archiveQuotePollCapture({ source: "tickflow", endpoint: "/v1/quotes", market: "A", tradeDate,
    startedAt: iso(time + offset - duration), observedAt: iso(time + offset), coverage: "unknown", units: "unknown",
    requestedSymbols: symbols, rows });
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-quote-monitor-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("replays exact polls offline, preserves missing evidence, and reapplies cooldown at the expiry boundary", async () => {
  const first = await capture(0, [rawQuote(a, time, 1000), rawQuote(b, time, 1001)]);
  const second = await capture(10_000, [rawQuote(a, time + 10_000), rawQuote(b, time + 10_000, 0, 0)]);
  const expiry = await capture(60_000, [rawQuote(a, time + 60_000), rawQuote(b, time + 60_000)]);
  const request = { ...basis, rule, roster, maxAgeMs: 1000, captureRefs: [first, second, expiry] };
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Replay cannot make a provider request"));
  try {
    const report = await replayTspQuoteMonitorAlerts(request);
    expect(report).toMatchObject({ producer: "whyj", basis: { price: basis.priceBasis, volume: "share", amount: "CNY-thousand" },
      units: { change_pct: "fraction", volume: "hand", amount: "CNY" }, ruleRevision: "rule-v1" });
    expect(report.evaluations.map(({ missingSymbols, staleSymbols, suppressedCount, unavailableCount, events }) =>
      [missingSymbols, staleSymbols, suppressedCount, unavailableCount, events.map(event => event.symbol)])).toEqual([
      [[c], [b], 0, 2, [a]], [[c], [], 1, 2, []], [[c], [], 0, 1, [a, b]],
    ]);
    expect(report.evaluations[0]).toMatchObject({ archive: { ref: first, units: "unknown", source: "tickflow" }, events: [{
      symbol: a, quoteTimestamp: time - 1000, ageMs: 1000, receivedAt: iso(time), priceCny: 11, changeFraction: 0.1,
      operands: { change_pct: 0.1, volume: 3, amount: 2_000 }, eventId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }] });
    expect(await replayTspQuoteMonitorAlerts({ ...request, roster: [...roster].reverse() })).toEqual(report);
    const unknown = await replayTspQuoteMonitorAlerts({ rule, roster, captureRefs: [first], maxAgeMs: 1000 });
    expect(unknown.evaluations[0]).toMatchObject({ unavailableCount: 3, events: [] });
    const zero = await capture(120_000, [{ ...rawQuote(a, time + 120_000, 0, 0), volume: 0, amount: 0 }]);
    const zeroPrice = await replayTspQuoteMonitorAlerts({ ...request, captureRefs: [zero], rule: { ...rule,
      conditions: [{ field: "price", op: "<=", value: 1, unit: "CNY" }] } });
    expect(zeroPrice.evaluations[0]).toMatchObject({ unavailableCount: 3, events: [] });
    const zeroAmount = await replayTspQuoteMonitorAlerts({ ...request, captureRefs: [zero], rule: { ...rule,
      conditions: [{ field: "amount", op: "==", value: 0, unit: "CNY" }] } });
    expect(zeroAmount.evaluations[0]?.events[0]).toMatchObject({ priceCny: null, operands: { amount: 0 } });

    const otherRoster = await capture(1_000, [], [a]);
    const overlap = await capture(300, [], roster, 500);
    await expect(replayTspQuoteMonitorAlerts({ ...request, captureRefs: [otherRoster] })).rejects.toThrow("exact supplied roster");
    await expect(replayTspQuoteMonitorAlerts({ ...request, captureRefs: [first, overlap] })).rejects.toThrow("increasing and nonoverlapping");
    await expect(replayTspQuoteMonitorAlerts({ ...request, captureRefs: [first, first] })).rejects.toThrow("duplicate");
    await expect(replayTspQuoteMonitorAlerts(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

test("collects the configured TickFlow poll once, validates before IO, and returns only current decisions", async () => {
  const prior = await capture(0, [rawQuote(a, time)]);
  const now = time + 10_000;
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    const route = new URL(request.url);
    expect(route.pathname).toBe("/v1/quotes");
    expect(route.searchParams.get("symbols")).toBe(roster.join(","));
    expect(request.headers.get("x-api-key")).toBe("quote-monitor-fixture");
    return Response.json({ data: [a, b].map(symbol => ({ symbol, region: "CN", timestamp: now - 100,
      last_price: 11, prev_close: 10, open: 10, high: 11, low: 10, volume: 300, amount: 2 })) });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "quote-monitor-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    setSystemTime(now);
    const request: CurrentQuoteMonitorRequest = { ...basis, tradeDate, rule, roster, maxAgeMs: 1000, priorCaptureRefs: [prior] };
    await expect(collectTspQuoteMonitorAlerts({ ...request, rule: { ...rule,
      conditions: [{ field: "volume", op: ">", value: 1, unit: "share" }] } })).rejects.toThrow("Incompatible quote monitor");
    await expect(collectTspQuoteMonitorAlerts({ ...request, roster: [a] })).rejects.toThrow("exact supplied roster");
    await expect(collectTspQuoteMonitorAlerts({ ...request,
      priorCaptureRefs: [{ ...prior, revision: "0".repeat(64) }] })).rejects.toThrow();
    await expect(collectTspQuoteMonitorAlerts(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);
    const result = await collectTspQuoteMonitorAlerts(request);
    expect(requests).toBe(1);
    expect(result).toMatchObject({ capture: { tradeDate, source: "tickflow", rowCount: 2, missingSymbols: [c] }, priorCaptureRefs: [prior],
      evaluation: { evaluatedAt: now, suppressedCount: 1, events: [{ symbol: b, receivedAt: iso(now), quoteTimestamp: now - 100, ageMs: 100 }] } });
    expect(result).not.toHaveProperty("evaluations");
    expect(await loadQuotePollArchive(result.capture.ref)).toMatchObject({ units: "unknown", rows: [
      { symbol: a, volume: 300, amount: 2 }, { symbol: b, volume: 300, amount: 2 },
    ] });
    const replay = await replayTspQuoteMonitorAlerts({ ...request, captureRefs: [prior, result.capture.ref] });
    expect(replay.evaluations.at(-1)).toEqual(result.evaluation);
    expect(requests).toBe(1);
  } finally {
    setSystemTime();
    await server.stop(true);
  }
});

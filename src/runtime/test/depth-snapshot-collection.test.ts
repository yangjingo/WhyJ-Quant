import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDepthSnapshotArchive, readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectDepthSnapshot } from "../data/depth-snapshot-collection.ts";

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const symbols = Array.from({ length: 102 }, (_, index) => `${600001 + index}.SH`);
const nativeRow = (symbol: string, timestamp: number) => ({
  symbol, region: "CN", timestamp, bid_prices: [11, 0], bid_volumes: [500, 0], ask_prices: [], ask_volumes: [],
});

let root: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-depth-capture-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "depth-capture-fixture" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("collects sequential native batches and archives observed books while surfacing missing and wrong-time evidence", async () => {
  const now = Date.now(), tradeDate = shanghai.format(now);
  const first = symbols[0]!, offDate = symbols[1]!, afterReceipt = symbols[2]!, last = symbols.at(-1)!;
  const received: string[][] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/depth/batch");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("depth-capture-fixture");
    received.push(url.searchParams.get("symbols")!.split(","));
    return Response.json({ data: received.length === 1 ? {
      [first]: nativeRow(first, now),
      [offDate]: nativeRow(offDate, now - 86_400_000),
      [afterReceipt]: nativeRow(afterReceipt, now + 60_000),
    } : { [last]: nativeRow(last, now) } });
  }) as typeof fetch);
  try {
    const mutable = { tradeDate, symbols: [...symbols].reverse() };
    const pending = collectDepthSnapshot(mutable);
    mutable.symbols.splice(0, mutable.symbols.length);
    const result = await pending;
    expect(received).toEqual([symbols.slice(0, 100), symbols.slice(100)]);
    expect(result).toMatchObject({
      source: "tickflow", endpoint: "/v1/depth/batch", volumeUnit: "unknown", coverage: "unknown", tradeDate,
      status: "archived", batches: 2, rowCount: 2, requestedSymbols: symbols, outsideCaptureSymbols: [offDate, afterReceipt],
      missingSymbols: symbols.slice(1, -1),
    });
    expect(await loadDepthSnapshotArchive(result.ref)).toMatchObject({
      tradeDate, observedAt: result.observedAt, requestedSymbols: symbols,
      rows: [first, last].map(symbol => ({ symbol, timestamp: now, bids: [{ price: 11, volume: 500 }, { price: 0, volume: 0 }], asks: [] })),
    });
  } finally { fetcher.mockRestore(); }
});

test("records empty responses as fixed captures with all requested symbols unavailable", async () => {
  const tradeDate = shanghai.format(Date.now());
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: {} }));
  try {
    const result = await collectDepthSnapshot({ tradeDate, symbols: symbols.slice(0, 1) });
    expect(result).toMatchObject({ status: "empty", rowCount: 0, batches: 1, missingSymbols: [symbols[0]!] });
    expect((await loadDepthSnapshotArchive(result.ref)).rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { fetcher.mockRestore(); }
});

test("rejects historical and invalid scopes and commits nothing after a failed batch", async () => {
  const tradeDate = shanghai.format(Date.now());
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: { [symbols[0]!]: nativeRow(symbols[0]!, Date.now()) } }))
    .mockResolvedValueOnce(new Response("denied", { status: 403 }));
  try {
    await expect(collectDepthSnapshot({ tradeDate: "2020-01-02", symbols })).rejects.toThrow("current-day depth capture");
    await expect(collectDepthSnapshot({ tradeDate, symbols: ["899050.BJ"] })).rejects.toThrow("current-day depth capture");
    await expect(collectDepthSnapshot({ tradeDate, symbols: [symbols[0]!, symbols[0]!] })).rejects.toThrow("Duplicate depth capture");
    await expect(collectDepthSnapshot({ tradeDate, symbols }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(collectDepthSnapshot({ tradeDate, symbols })).rejects.toThrow("HTTP 403");
    const saved = readSettings();
    saveSettings({ ...saved, preferences: { ...saved.preferences, source: "tushare" } });
    await expect(collectDepthSnapshot({ tradeDate, symbols })).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "data", "depth-snapshot-archives-v1"))).toBe(false);
  } finally { fetcher.mockRestore(); }
});

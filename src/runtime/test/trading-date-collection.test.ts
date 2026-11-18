import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings } from "../../storage/index.ts";
import * as storage from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectTradingDateObservations, deriveTspArchiveIndicators, replayTradingDateObservations } from "../data/observation-collection.ts";
import type { TradingDateKlineRequest } from "../../source/index.ts";

let root: string; let previous: string | undefined;
const timestamp = Date.parse("2024-01-01T16:00:00Z");
const request = (): TradingDateKlineRequest => ({ timeMode: "trading-date", symbol: "600000.SH", assetType: "stock", interval: "1d", adjustment: "none", startDate: "2024-01-02", endDate: "2024-01-03" });
const tushare = { code: 0, data: { fields: ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"], items: [["600000.SH", "20240102", 10, 12, 9, 11, 100, null]] } };
const tickflow = { data: { timestamp: [timestamp], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } };
function select(source: "tushare" | "tickflow" | "akshare") {
  const current = existsSync(join(root, "settings.json")) ? loadSettings() : DEFAULT_SETTINGS;
  saveSettings({ ...current, preferences: { ...current.preferences, source }, env: { WHYJ_QUANT_TUSHARE_TOKEN: "fixture-secret", WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-secret" } });
}
beforeEach(() => { previous = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-date-collect-")); process.env.OHQUANT_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous; rmSync(root, { recursive: true, force: true }); });

test("collects and replays selected-source daily observations with no replay request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  try {
    for (const source of ["tushare", "tickflow"] as const) {
      select(source); fetchMock.mockResolvedValueOnce(Response.json(source === "tushare" ? tushare : tickflow));
      const receipt = await collectTradingDateObservations(request());
      if (receipt.status !== "archived") throw new Error("missing archive");
      expect(receipt.ref.version).toBe(2);
      expect(JSON.stringify(receipt)).not.toContain("fixture-secret");
      const [row] = await replayTradingDateObservations(receipt.ref);
      expect(row).toMatchObject({ symbol: "600000.SH", tradeDate: "2024-01-02", source, sourceTimestamp: source === "tushare" ? null : timestamp,
        volumeUnit: source === "tushare" ? "hand" : "unknown", requested: { startDate: "2024-01-02", endDate: "2024-01-03" } });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { fetchMock.mockRestore(); }
});

test("empty, malformed, unsupported, provider failure and cancellation never archive or fall back", async () => {
  select("tushare"); const fetchMock = spyOn(globalThis, "fetch");
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ ...tushare, data: { ...tushare.data, items: [] } }));
    expect(await collectTradingDateObservations(request())).toMatchObject({ status: "empty", rowCount: 0, ref: null });
    fetchMock.mockResolvedValueOnce(Response.json({ ...tushare, data: { ...tushare.data, items: [["600001.SH", "20240102", 10, 12, 9, 11, 100, null]] } }));
    await expect(collectTradingDateObservations(request())).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response("private body", { status: 403 }));
    await expect(collectTradingDateObservations(request())).rejects.toThrow("HTTP 403");
    await expect(collectTradingDateObservations({ ...request(), adjustment: "forward" })).rejects.toThrow("not implemented");
    const controller = new AbortController(); controller.abort();
    await expect(collectTradingDateObservations(request(), { signal: controller.signal })).rejects.toThrow();
    await expect(collectTradingDateObservations({ ...request(), timeMode: undefined } as unknown as TradingDateKlineRequest)).rejects.toThrow("Invalid trading-date collection request");
    select("akshare"); await expect(collectTradingDateObservations(request())).rejects.toThrow("not implemented");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "observation-archives-v2"))).toBe(false);
  } finally { fetchMock.mockRestore(); }
});

test("cancellation during provider fetch does not publish an archive", async () => {
  select("tushare"); const controller = new AbortController();
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => { controller.abort(); return Response.json(tushare); }) as unknown as typeof fetch);
  try {
    await expect(collectTradingDateObservations(request(), { signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, "data", "observation-archives-v2"))).toBe(false);
  } finally { fetchMock.mockRestore(); }
});

test("returns an already committed reference even when cancellation arrives immediately afterward", async () => {
  select("tushare"); const controller = new AbortController();
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(tushare));
  const original = storage.archiveTradingDateObservations;
  const archive = spyOn(storage, "archiveTradingDateObservations").mockImplementation(async (rows, signal) => {
    const ref = await original(rows, signal); controller.abort(); return ref;
  });
  try {
    const receipt = await collectTradingDateObservations(request(), { signal: controller.signal });
    expect(receipt.status).toBe("archived");
    if (receipt.status !== "archived") throw new Error("missing archive");
    expect(await replayTradingDateObservations(receipt.ref)).toHaveLength(1);
    expect(archive).toHaveBeenCalledTimes(1);
  } finally { archive.mockRestore(); fetchMock.mockRestore(); }
});

test("captures the requested dates and signal before asynchronous settings lookup", async () => {
  select("tushare");
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(tushare));
  const first = new AbortController(), second = new AbortController();
  try {
    const input = request(), options = { signal: first.signal };
    const pending = collectTradingDateObservations(input, options);
    input.startDate = "2024-01-03"; options.signal = second.signal;
    const receipt = await pending;
    if (receipt.status !== "archived") throw new Error("missing archive");
    expect((await replayTradingDateObservations(receipt.ref))[0]!.requested.startDate).toBe("2024-01-02");
    const cancelled = collectTradingDateObservations(request(), options); second.abort();
    await expect(cancelled).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});

test("derives pinned indicators from the entire dated batch without refetching or filling gaps", async () => {
  select("tickflow");
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
  try {
    for (const adjustment of ["none", "forward"] as const) {
      const endDate = "2024-01-04";
      fetchMock.mockResolvedValueOnce(Response.json({ data: {
        timestamp: [timestamp, Date.parse("2024-01-03T16:00:00Z")],
        open: [10, 11], high: [12, 12], low: [9, 8], close: [11, 10], volume: [100, 150], amount: [null, null],
      } }));
      const receipt = await collectTradingDateObservations({ ...request(), adjustment, endDate });
      if (receipt.status !== "archived") throw new Error("missing archive");
      const records = await replayTradingDateObservations(receipt.ref);
      // Storage also accepts a homogeneous batch whose incoming order differs from trading-date order.
      const reversedRef = await storage.archiveTradingDateObservations(records.toReversed());
      const original = await deriveTspArchiveIndicators(receipt.ref);
      const reversed = await deriveTspArchiveIndicators(reversedRef);

      expect(reversed).toEqual({ ...original, archiveRef: reversedRef });
      expect(original).toMatchObject({ archiveRef: receipt.ref,
        formula: { version: 1, revision: "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc" },
        input: { symbol: "600000.SH", source: "tickflow", endpoint: "/v1/klines", observedAt: receipt.observedAt,
          adjustment, calendarTimeZone: "Asia/Shanghai", requested: { startDate: "2024-01-02", endDate },
          firstTradeDate: "2024-01-02", lastTradeDate: endDate, coverage: "unknown", finality: "unknown" } });
      expect(original.rows).toEqual([
        { date: "2024-01-02", rsi6: 0, rsi14: 0, rsi24: 0, atr14: 3 },
        { date: endDate, rsi6: 0, rsi14: 0, rsi24: 0, atr14: expect.closeTo(43 / 14, 12) },
      ]);
      expect(await replayTradingDateObservations(receipt.ref)).toEqual(records);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { fetchMock.mockRestore(); }
});

test("indicator replay rejects invalid, missing, damaged, and cancelled archives", async () => {
  select("tushare");
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
  try {
    fetchMock.mockResolvedValueOnce(Response.json(tushare));
    const receipt = await collectTradingDateObservations(request());
    if (receipt.status !== "archived") throw new Error("missing archive");
    const controller = new AbortController();
    controller.abort();
    await expect(deriveTspArchiveIndicators(receipt.ref, controller.signal)).rejects.toThrow();
    await expect(deriveTspArchiveIndicators({ ...receipt.ref, version: 1 } as never)).rejects.toThrow("Invalid observation archive");
    await expect(deriveTspArchiveIndicators({ version: 2, revision: "a".repeat(64) })).rejects.toThrow();
    writeFileSync(join(root, "data", "observation-archives-v2", `${receipt.ref.revision}.json`), "{}");
    await expect(deriveTspArchiveIndicators(receipt.ref)).rejects.toThrow("damaged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});

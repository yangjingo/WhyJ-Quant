import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings } from "../../storage/index.ts";
import * as storage from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectTradingDateObservations, replayTradingDateObservations } from "../data/observation-collection.ts";
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

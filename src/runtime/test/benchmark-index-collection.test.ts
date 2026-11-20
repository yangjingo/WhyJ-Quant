import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchmarkIndexArchive, readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectBenchmarkIndexObservations } from "../data/benchmark-index-collection.ts";

const query = { symbol: " 000001.sh ", start: "2024-02-01", end: "2024-02-02" };
const fields = ["ts_code", "trade_date", "close", "pre_close", "change", "pct_chg"];
const response = (items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-benchmark-collection-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "benchmark-collection-fixture" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("collects a dated benchmark with its selected provider and produces an offline receipt", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(response([
    ["000001.SH", "20240201", 2900, 3000, -100, -3.3333],
  ])).mockResolvedValueOnce(response([]));
  try {
    const request = { ...query };
    const pending = collectBenchmarkIndexObservations(request);
    request.end = "2024-12-01";
    const receipt = await pending;
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "index_daily", token: "benchmark-collection-fixture",
      params: { ts_code: "000001.SH", start_date: "20240201", end_date: "20240202" },
      fields: fields.join(","),
    });
    expect(receipt).toEqual({
      status: "archived", rowCount: 1, ref: expect.any(Object), market: "A", source: "tushare", endpoint: "index_daily",
      observedAt: expect.any(String), coverage: "unknown", symbol: "000001.SH", requested: { start: query.start, end: query.end },
      priceUnit: "index-points", returnUnit: "percentage-points",
    });
    const batch = await loadBenchmarkIndexArchive(receipt.ref);
    expect(batch.observedAt).toBe(receipt.observedAt);
    expect(batch.requested).toEqual(receipt.requested);
    expect(batch.rows).toEqual([
      { tradeDate: "2024-02-01", closePoints: 2900, previousClosePoints: 3000, changePoints: -100, returnPct: -3.3333 },
    ]);
    const empty = await collectBenchmarkIndexObservations(query);
    expect(empty).toMatchObject({ status: "empty", rowCount: 0 });
    expect((await loadBenchmarkIndexArchive(empty.ref)).rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("denied, foreign, cancelled and unsupported reads commit no benchmark archive", async () => {
  const cancel = new AbortController();
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("permission required", { status: 403 }))
    .mockResolvedValueOnce(response([["399001.SZ", "20240201", 3000, null, null, null]]))
    .mockImplementationOnce((async () => {
      cancel.abort();
      return response([]);
    }) as unknown as typeof fetch);
  try {
    await expect(collectBenchmarkIndexObservations(query)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectBenchmarkIndexObservations(query)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectBenchmarkIndexObservations(query, { signal: cancel.signal })).rejects.toMatchObject({ name: "AbortError" });
    const settings = readSettings();
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "llmquant-data" } });
    await expect(collectBenchmarkIndexObservations(query)).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "benchmark-index-archives-v1"))).toBe(false);
  } finally { fetcher.mockRestore(); }
});

test("collects configured TickFlow BSE 50 points, reopens native records and reports empty explicitly", async () => {
  const settings = readSettings();
  saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "benchmark-tickflow-fixture" } });
  const bseQuery = { ...query, symbol: " 899050.bj " };
  const time = Date.parse("2024-02-01T00:00:00+08:00");
  const data = { timestamp: [time], open: [825], high: [850], low: [800], close: [830], volume: [1] };
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data }))
    .mockResolvedValueOnce(Response.json({ data: { timestamp: [], open: [], high: [], low: [], close: [], volume: [] } }));
  try {
    const receipt = await collectBenchmarkIndexObservations(bseQuery);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("symbol")).toBe("899050.BJ");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("benchmark-tickflow-fixture");
    expect(receipt).toMatchObject({ source: "tickflow", endpoint: "/v1/klines", symbol: "899050.BJ", status: "archived", rowCount: 1 });
    expect(await loadBenchmarkIndexArchive(receipt.ref)).toMatchObject({
      source: "tickflow", endpoint: "/v1/klines", symbol: "899050.BJ", coverage: "unknown",
      rows: [{ tradeDate: "2024-02-01", sourceTimestamp: time, closePoints: 830, previousClosePoints: null, changePoints: null, returnPct: null }],
    });
    const empty = await collectBenchmarkIndexObservations(bseQuery);
    expect(empty).toMatchObject({ status: "empty", rowCount: 0 });
    expect((await loadBenchmarkIndexArchive(empty.ref)).rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("TickFlow missing credentials, denied and foreign index reads create no archive", async () => {
  const inherited = process.env.WHYJ_QUANT_TICKFLOW_API_KEY;
  delete process.env.WHYJ_QUANT_TICKFLOW_API_KEY;
  const settings = readSettings();
  const selected = { ...settings, preferences: { ...settings.preferences, source: "tickflow" as const } };
  const bseQuery = { ...query, symbol: "899050.BJ" };
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 403 }))
    .mockResolvedValueOnce(Response.json({ data: { symbol: "000001.SH", timestamp: [], open: [], high: [], low: [], close: [], volume: [] } }));
  try {
    saveSettings({ ...selected, env: {} });
    await expect(collectBenchmarkIndexObservations(bseQuery)).rejects.toMatchObject({ code: "provider-failure" });
    expect(fetcher).not.toHaveBeenCalled();
    saveSettings({ ...readSettings(), env: { WHYJ_QUANT_TICKFLOW_API_KEY: "benchmark-tickflow-fixture" } });
    await expect(collectBenchmarkIndexObservations(bseQuery)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectBenchmarkIndexObservations(bseQuery)).rejects.toMatchObject({ code: "provider-failure" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "data", "benchmark-index-archives-v1"))).toBe(false);
  } finally {
    fetcher.mockRestore();
    if (inherited !== undefined) process.env.WHYJ_QUANT_TICKFLOW_API_KEY = inherited;
  }
});

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
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tickflow" } });
    await expect(collectBenchmarkIndexObservations(query)).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "benchmark-index-archives-v1"))).toBe(false);
  } finally { fetcher.mockRestore(); }
});

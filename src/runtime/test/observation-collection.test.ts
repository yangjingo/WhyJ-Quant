import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectObservations, replayObservations, type ObservationCollectionRequest } from "../data/observation-collection.ts";

let root: string; let old: string | undefined;
const timestamp = Date.parse("2026-11-12T00:00:00+08:00");
const bar = { data: { timestamp: [timestamp], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } };
const factor = { data: { "600000.SH": [{ timestamp, ex_factor: 1.25 }] } };
const request = (dataset: "1d" | "1m" | "factor"): ObservationCollectionRequest => dataset === "factor"
  ? { dataset: "adjustment_factor", symbol: "600000.SH", startTime: timestamp, endTime: timestamp }
  : { dataset: "bars", symbol: "600000.SH", interval: dataset, adjustment: "none", startTime: timestamp, endTime: timestamp };
beforeEach(() => { old = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-collect-")); process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" }, env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-key" } }); });
afterEach(() => { if (old === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = old; rmSync(root, { recursive: true, force: true }); });

test("collects and replays each selected-provider dataset without another request", async () => {
  const paths: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-key");
    const path = new URL(String(input)).pathname; paths.push(path);
    return Response.json(path.endsWith("ex-factors") ? factor : bar);
  }) as unknown as typeof fetch);
  try {
    for (const dataset of ["1d", "1m", "factor"] as const) {
      const receipt = await collectObservations(request(dataset));
      expect(receipt.status).toBe("archived");
      if (receipt.status !== "archived") throw new Error("missing receipt");
      expect(receipt).toMatchObject({ source: "tickflow", rowCount: 1, endpoint: dataset === "factor" ? "/v1/klines/ex-factors" : "/v1/klines" });
      expect(JSON.stringify(receipt)).not.toContain("fixture-key");
      const [row] = await replayObservations(receipt.ref);
      expect(row).toMatchObject({ symbol: "600000.SH", timestamp, source: "tickflow", observedAt: receipt.observedAt, units: "unknown", coverage: "unknown" });
      if (row?.kind === "adjustment_factor") expect(row).toMatchObject({ factorBasis: "unknown", values: { factor: 1.25 } });
      else expect(row).toMatchObject({ interval: dataset, adjustment: "none", values: { amount: null } });
    }
    expect(paths).toEqual(["/v1/klines", "/v1/klines", "/v1/klines/ex-factors"]);
  } finally { fetchMock.mockRestore(); }
});

test("empty and malformed responses and provider failures do not create a success receipt", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { timestamp: [], open: [], high: [], low: [], close: [], volume: [], amount: [] } }));
    expect(await collectObservations(request("1d"))).toMatchObject({ status: "empty", rowCount: 0, ref: null });
    expect(existsSync(join(root, "data", "observation-archives-v1"))).toBe(false);
    fetchMock.mockResolvedValueOnce(Response.json({ data: { ...bar.data, close: [11, 12] } }));
    await expect(collectObservations(request("1d"))).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(collectObservations(request("1d"))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "observation-archives-v1"))).toBe(false);
  } finally { fetchMock.mockRestore(); }
});

test("unsupported selected provider and cancellation do not fall back or overwrite prior archives", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(bar));
  try {
    const receipt = await collectObservations(request("1d"));
    if (receipt.status !== "archived") throw new Error("missing archive");
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(collectObservations(request("1m"), { signal: controller.signal })).rejects.toThrow("cancelled");
    const settings = loadSettings();
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tushare" } });
    await expect(collectObservations(request("1d"))).rejects.toThrow("not implemented");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await replayObservations(receipt.ref)).toHaveLength(1);
    expect(readdirSync(join(root, "data", "observation-archives-v1"))).toHaveLength(1);
  } finally { fetchMock.mockRestore(); }
});

test("an archive write failure cannot return success", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => { writeFileSync(join(root, "data"), "not a directory"); return Response.json(bar); }) as unknown as typeof fetch);
  try { await expect(collectObservations(request("1d"))).rejects.toThrow(); } finally { fetchMock.mockRestore(); }
});

test("cancellation during a provider request is passed through and does not archive", async () => {
  const controller = new AbortController();
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(init?.signal).toBeDefined();
    controller.abort(new Error("cancelled during request"));
    return Response.json(bar);
  }) as unknown as typeof fetch);
  try {
    await expect(collectObservations(request("1d"), { signal: controller.signal })).rejects.toThrow();
    expect(existsSync(join(root, "data", "observation-archives-v1"))).toBe(false);
  } finally { fetchMock.mockRestore(); }
});

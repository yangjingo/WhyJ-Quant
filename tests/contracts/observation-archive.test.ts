import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarketDataSource, toBarObservations, toFactorObservations } from "../../src/source/index.ts";
import { archiveObservations, loadObservationArchive } from "../../src/storage/index.ts";

let root: string; let previous: string | undefined;
beforeEach(() => { previous = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-observation-contract-")); process.env.OHQUANT_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous; rmSync(root, { recursive: true, force: true }); });

test("selected-source daily, minute and factor observations persist and replay unchanged", async () => {
  const original = globalThis.fetch; const timestamp = 1735689600000; const requests: string[] = [];
  globalThis.fetch = (async input => {
    const pathname = new URL(String(input)).pathname; requests.push(pathname);
    return pathname.endsWith("ex-factors") ? Response.json({ data: { "600000.SH": [{ timestamp, ex_factor: 1.25 }] } })
      : Response.json({ data: { timestamp: [timestamp], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } });
  }) as typeof fetch;
  try {
    const source = createMarketDataSource({ source: "tickflow", apiKey: "synthetic", env: {} });
    const daily = toBarObservations(await source.fetchKlines({ symbol: "600000.SH", interval: "1d", adjustment: "none", startTime: timestamp, endTime: timestamp }));
    const minute = toBarObservations(await source.fetchKlines({ symbol: "600000.SH", interval: "1m", adjustment: "forward", startTime: timestamp, endTime: timestamp }));
    const factors = toFactorObservations(await source.fetchAdjustmentFactors({ symbols: ["600000.SH"], startTime: timestamp, endTime: timestamp }));
    for (const batch of [daily, minute, factors]) {
      const ref = await archiveObservations(batch);
      expect(await loadObservationArchive(ref)).toEqual(batch);
    }
    expect(requests).toEqual(["/v1/klines", "/v1/klines", "/v1/klines/ex-factors"]);
  } finally { globalThis.fetch = original; }
});

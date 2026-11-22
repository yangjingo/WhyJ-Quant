import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketRegimeManifest, loadMarketRegimeManifest, MARKET_REGIME_MANIFEST_MAX_BYTES } from "../index.ts";

test("archives a market manifest larger than the workbench request and verifies the exact revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-regime-manifest-archive-"));
  const before = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const manifest = {
    version: 1, sessions: ["2024-03-04"], marketRevisions: ["1".repeat(64)],
    limitRevisions: Array.from({ length: 600 }, (_, i) => i.toString(16).padStart(64, "0")),
    priceHistory: [], benchmark: { symbol: "000001.SH", revisions: [] },
  };
  const { version, ...scope } = manifest;
  const original = JSON.stringify(manifest);
  const reordered = JSON.stringify({ ...scope, version }, null, 2);
  const dir = join(root, "data", "market-regime-manifests-v1");
  try {
    expect(Buffer.byteLength(original)).toBeGreaterThan(32_768);
    const [first, second] = await Promise.all([archiveMarketRegimeManifest(original), archiveMarketRegimeManifest(reordered)]);
    expect(first).toEqual(second);
    expect(first).toEqual({ version: 1, kind: "market-regime-manifest", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readdirSync(dir)).toEqual([first.revision + ".json"]);
    expect(await loadMarketRegimeManifest(first)).toEqual(manifest);
    await expect(loadMarketRegimeManifest({ ...first, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
    await expect(loadMarketRegimeManifest(first, AbortSignal.abort())).rejects.toThrow();

    for (const invalid of ["not JSON", "[]", "{}", " ".repeat(MARKET_REGIME_MANIFEST_MAX_BYTES + 1)]) {
      await expect(archiveMarketRegimeManifest(invalid)).rejects.toThrow("Invalid observation archive");
    }
    await expect(archiveMarketRegimeManifest(JSON.stringify({ ...manifest, version: 2 }), AbortSignal.abort())).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([first.revision + ".json"]);
    writeFileSync(join(dir, first.revision + ".json"), "{}");
    await expect(loadMarketRegimeManifest(first)).rejects.toThrow("Observation archive is damaged");
    await expect(archiveMarketRegimeManifest(original)).rejects.toThrow("Observation archive is damaged");
    writeFileSync(join(dir, first.revision + ".json"), Buffer.alloc(MARKET_REGIME_MANIFEST_MAX_BYTES + 1));
    await expect(loadMarketRegimeManifest(first)).rejects.toThrow("Invalid observation archive");
  } finally {
    if (before === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});

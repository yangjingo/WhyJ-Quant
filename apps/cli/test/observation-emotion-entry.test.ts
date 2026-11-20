import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveBenchmarkIndexObservations, archiveMarketCrossSection } from "../../../src/storage/index.ts";

const tradeDate = "2025-01-03", observedAt = "2025-01-04T01:00:00Z";

async function archiveFixture() {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  const symbol = "600001.SH";
  const market = await archiveMarketCrossSection({ source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "Fixture", industry: null, listedOn: null }] },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: 10,
        returnPct: 0, changeCny: 0, volume: 100, amount: 1 }] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const index = await archiveBenchmarkIndexObservations({ symbol: "000680.SH", source: "tushare", market: "A", endpoint: "index_daily",
    observedAt, coverage: "unknown", priceUnit: "index-points", returnUnit: "percentage-points", requested: { start: tradeDate, end: tradeDate },
    rows: [{ tradeDate, closePoints: 1020, previousClosePoints: 1000, changePoints: 20, returnPct: null }],
  });
  return { index, manifest: { sessions: [tradeDate], marketRevisions: [market.revision], limitRevisions: [], priceRevisions: [],
    indexRevisions: [index.revision] } };
}

test("exposes an offline market emotion command with distinct partial, missing and invalid states", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-emotion-cli-"));
  const previous = process.env.OHQUANT_DIR;
  const path = join(root, "emotion manifest.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const replay = (input: unknown) => {
    writeFileSync(path, JSON.stringify(input));
    return run("observation", "replay-market-emotion", "--manifest", path);
  };
  process.env.OHQUANT_DIR = root;
  try {
    const { index, manifest } = await archiveFixture();
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation replay-market-emotion",
      description: "Replay six-dimensional market emotion from dated archives",
    });
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", tradingDate: tradeDate, status: "computed",
      input: { indices: [{ ref: index, symbol: "000680.SH" }] },
      dashboard: { formula: { id: "tsp_dashboard_emotion", version: 1 }, metrics: { avg_index_pct: 2, up_pct: null, seal_rate: null },
        emotion: { observedDimensions: 1 }, evidence: { exchange: { depthCorrection: "unavailable" } } },
    } } });
    expect(await replay(manifest)).toEqual(result);
    expect(await replay({ ...manifest, marketRevisions: [] })).toMatchObject({
      code: 0, output: { data: { tradingDate: tradeDate, status: "missing-market", dashboard: null } },
    });
    expect(await replay({ ...manifest, riskWarningRevisions: [] })).toMatchObject({
      code: 0, output: { data: { status: "missing-risk-warnings", dashboard: null } },
    });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const input of [
      { ...manifest, extra: true }, { ...manifest, sessions: [tradeDate, tradeDate] },
      { ...manifest, indexRevisions: [index.revision, index.revision] },
      { ...manifest, sectors: { concept: { catalogRevision: "bad", memberRevisions: [] } } },
    ]) expect(await replay(input)).toMatchObject(invalid);
    expect(await replay({ ...manifest, indexRevisions: ["e".repeat(64)] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

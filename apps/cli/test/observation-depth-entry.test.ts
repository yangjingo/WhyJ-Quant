import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveDepthSnapshot, archiveMarketCrossSection } from "../../../src/storage/index.ts";

const tradeDate = "2025-01-03", observedAt = "2025-01-03T15:00:01+08:00";
const symbol = "600001.SH";

async function fixture() {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  const market = await archiveMarketCrossSection({ tradeDate, market: "A", source: "tushare",
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "Fixture", industry: null, listedOn: null }] },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open: 10, high: 11, low: 10, close: 11, exRightsPreviousClose: 10,
        returnPct: 10, changeCny: 1, volume: 100, amount: 1 }] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const limits = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
    coverage: "unknown", priceUnit: "CNY", requested: { startDate: tradeDate, endDate: tradeDate },
    rows: [{ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 }] });
  const depth = await archiveDepthSnapshot({ ...meta, source: "tickflow", endpoint: "/v1/depth", market: "A", volumeUnit: "unknown",
    requestedSymbols: [symbol], rows: [{ symbol, timestamp: Date.parse(tradeDate + "T15:00:00+08:00"),
      bids: [{ price: 10.99, volume: 50 }], asks: [{ price: 11, volume: 200 }] }] });
  return { depth, manifest: { sessions: [tradeDate], marketRevisions: [market.revision], limitRevisions: [limits.revision],
    indexRevisions: [], priceRevisions: [] } };
}

test("CLI binds the fixed depth reference to the dashboard correction and preserves ordinary manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-depth-cli-"));
  const previous = process.env.OHQUANT_DIR;
  const path = join(root, "depth manifest.json");
  const replay = async (input: unknown) => {
    writeFileSync(path, JSON.stringify(input));
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", "observation", "replay-market-emotion", "--manifest", path], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  process.env.OHQUANT_DIR = root;
  try {
    const { depth: ref, manifest } = await fixture();
    expect(await replay(manifest)).toMatchObject({ code: 0, output: { ok: true, data: {
      dashboard: { metrics: { limit_up: 1, seal_rate: 100 }, evidence: { exchange: { depthCorrection: "unavailable" } } },
    } } });
    const depth = { revision: ref.revision, asOf: tradeDate + "T15:00:05+08:00", maxAgeMs: 5_000 };
    expect(await replay({ ...manifest, depth })).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { depth: { ref, asOf: Date.parse(depth.asOf), usedSymbols: [symbol] } },
      dashboard: { metrics: { limit_up: 0, seal_rate: 0 }, evidence: { exchange: {
        seal: { observedLimitUps: 1 }, depthCorrection: { coverage: "complete", up: { observedUnsealed: 1, correctedCount: 0 } },
      } } },
    } } });
    expect(await replay({ ...manifest, depth: { ...depth, asOf: tradeDate + "T15:00:05" } })).toMatchObject({
      code: 1, output: { error: { code: "invalid_arguments" } },
    });
    for (const unavailable of [{ ...depth, asOf: tradeDate + "T15:00:00+08:00" }, { ...depth, revision: "f".repeat(64) }]) {
      expect(await replay({ ...manifest, depth: unavailable })).toMatchObject({
        code: 1, output: { error: { code: "observation_archive_unavailable" } },
      });
    }
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveMarketRegimeManifest, archiveSectorObservations,
  saveSettings } from "../../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import { HOST_MAX_REQUEST_BYTES } from "../../../types/workbench-host.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

const previous = "2025-03-03", active = "2025-03-04", missing = "2025-03-05";
const observedAt = "2025-03-06T01:00:00Z";
const symbols = ["600000.SH", "600001.SH", "600002.SH", "600003.SH"];

function market(tradeDate: string, close: number) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({
    market: "A", source: "tushare", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, listedOn: null, industry: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.map((symbol, index) => ({ symbol, open: 10, high: close, low: 10, close, exRightsPreviousClose: 10,
        returnPct: close === 11 ? 10 : 0, changeCny: close - 10, volume: 10, amount: index + 1 })) },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

test("Host reopens a market manifest larger than its RPC limit and returns the exact display window offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-regime-"));
  const before = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  let calls = 0;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    calls++;
    return new Response("fixture provider", { status: 403 });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "fixture-regime-key", TUSHARE_BASE_URL: provider.url.origin } });
  let host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const warmup: string[] = [];
    for (let time = Date.parse(previous) - 86_400_000; warmup.length < 3_000; time -= 86_400_000) {
      const day = new Date(time);
      if (day.getUTCDay() % 6 !== 0) warmup.push(day.toISOString().slice(0, 10));
    }
    const sessions = [...warmup.reverse(), previous, active, missing];
    const [priorMarket, activeMarket] = await Promise.all([market(previous, 10), market(active, 11)]);
    const limitRefs = await Promise.all(symbols.map(symbol => archiveDailyTradingLimits({
      symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt, priceUnit: "CNY", coverage: "unknown",
      requested: { startDate: previous, endDate: active },
      rows: [previous, active].map(tradeDate => ({ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 })),
    })));
    const meta = { source: "tushare", market: "A", taxonomy: "eastmoney", tradeDate: active, observedAt, coverage: "unknown" } as const;
    const catalog = await archiveSectorObservations({
      ...meta, endpoint: "dc_index", kind: "concept", providerType: "概念板块",
      groups: [{ code: "BK1000.DC", name: "Fixture concept", level: null }],
    });
    const members = await archiveSectorObservations({
      ...meta, endpoint: "dc_member", sectorCode: "BK1000.DC", members: symbols.map(symbol => ({ symbol, name: null })),
    });
    const manifest = JSON.stringify({
      version: 1, sessions, marketRevisions: [priorMarket.revision, activeMarket.revision],
      limitRevisions: limitRefs.map(ref => ref.revision), priceHistory: [], benchmark: { symbol: "000001.SH", revisions: [] },
      phaseMode: "retrospective-tsp", window: { start: active, end: missing },
      concepts: { sectorHistory: [{ tradeDate: active, catalogRevision: catalog.revision, memberRevisions: [members.revision] }] },
    });
    expect(Buffer.byteLength(manifest)).toBeGreaterThan(HOST_MAX_REQUEST_BYTES);
    const ref = await archiveMarketRegimeManifest(manifest);
    const invalidManifest = await archiveMarketRegimeManifest("{\"version\":2}");
    const connect = async () => {
      const baseUrl = host.server.url.origin;
      const { token } = await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string };
      return {
        client: createHostClient({ baseUrl }),
        send: (argument: unknown, auth = true) => fetch(baseUrl + "/api/workbench/rpc", {
          method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { "x-workbench-token": token } : {}) },
          body: JSON.stringify({ method: "readObservationMarketRegime", args: [argument] }),
        }),
      };
    };
    const initial = await connect();
    expect((await initial.send(ref, false)).status).toBe(401);
    const result = await initial.client.readObservationMarketRegime!(ref);
    expect(result).toMatchObject({
      manifestRef: ref, calendar: { zone: "Asia/Shanghai", start: sessions[0], end: missing, sessions: sessions.length },
      phase: { mode: "retrospective-tsp" }, summary: { window: { start: active, end: missing, sessions: 2 } },
      rows: [
        { tradingDate: active, market: { ref: activeMarket, source: "tushare", observedAt },
          daily: { activity: { totalAmountCny: 10_000 }, exchange: { limitUp: { count: 4 } } },
          concepts: { catalogRef: catalog, archivedGroups: 1, catalogGroups: 1,
            ranks: [{ name: "Fixture concept", rank: 1, maxBoards: 1 }] } },
        { tradingDate: missing, market: null, daily: null, regime: null, concepts: null },
      ],
    });
    expect(result.rows).toHaveLength(2);
    await host.close();
    host = startWorkbenchServer({ port: 0, assetsRoot });
    const restarted = await connect();
    expect(await restarted.client.readObservationMarketRegime!(ref)).toEqual(result);
    await expect(restarted.client.readObservationMarketRegime!({ ...ref, revision: "../invalid" }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(restarted.client.readObservationMarketRegime!(invalidManifest))
      .rejects.toMatchObject({ code: "OBSERVATION_ARCHIVE_UNAVAILABLE" });
    const unavailable = await restarted.send({ ...ref, revision: "0".repeat(64) });
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({ error: { code: "OBSERVATION_ARCHIVE_UNAVAILABLE" } });
    expect(calls).toBe(0);
  } finally {
    await host.close();
    await provider.stop(true);
    if (before === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

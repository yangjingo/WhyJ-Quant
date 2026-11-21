import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveMarketCrossSection, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const symbol = "600001.SH", missing = "600002.SH";

async function marketManifest(tradeDate: string, observedAt: string) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  const market = await archiveMarketCrossSection({ tradeDate, market: "A", source: "tushare",
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [
      { symbol, name: "Fixture", listedOn: null, industry: null },
    ] },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open: 10, high: 11, low: 10, close: 11, exRightsPreviousClose: 10,
        returnPct: 10, changeCny: 1, volume: 100, amount: 1 }] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const limits = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
    coverage: "unknown", priceUnit: "CNY", requested: { startDate: tradeDate, endDate: tradeDate },
    rows: [{ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 }] });
  return { sessions: [tradeDate], marketRevisions: [market.revision], limitRevisions: [limits.revision], indexRevisions: [], priceRevisions: [] };
}

test("CLI collects a configured native depth batch and replays its fixed receipt offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-depth-capture-cli-"));
  const previous = process.env.OHQUANT_DIR;
  const symbolsFile = join(root, "depth symbols.json");
  const manifestFile = join(root, "market emotion.json");
  const requests: URL[] = [];
  let providerAvailable = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url));
    if (!providerAvailable || request.headers.get("x-api-key") !== "depth-cli-fixture") return new Response("", { status: 403 });
    const responseTime = Date.now();
    const dayStart = Date.parse(shanghai.format(responseTime) + "T00:00:00+08:00");
    // Keep the provider sample away from the child process's receipt boundary.
    const timestamp = Math.max(dayStart, responseTime - 1_000);
    return Response.json({ data: { [symbol]: { symbol, region: "CN", timestamp,
      bid_prices: [10.99], bid_volumes: [100], ask_prices: [11], ask_volumes: [200] } } });
  } });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const collect = (date: string) => run("observation", "collect-depth", "--date", date, "--symbols-file", symbolsFile);
  process.env.OHQUANT_DIR = root;
  try {
    const tradeDate = shanghai.format(Date.now());
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "depth-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation collect-depth",
      description: "Capture current Shanghai market depth for a specified stock list",
    });
    const invalid = { code: 1, output: { error: { code: "invalid_arguments" } } };
    writeFileSync(symbolsFile, JSON.stringify([symbol, symbol]));
    expect(await collect(tradeDate)).toMatchObject(invalid);
    writeFileSync(symbolsFile, JSON.stringify([missing, symbol]));
    expect(await collect("2020-01-02")).toMatchObject(invalid);
    expect(requests).toHaveLength(0);

    const result = await collect(tradeDate);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      source: "tickflow", endpoint: "/v1/depth/batch", tradeDate, requestedSymbols: [symbol, missing],
      status: "archived", rowCount: 1, missingSymbols: [missing], outsideCaptureSymbols: [],
    } } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/depth/batch");
    expect(requests[0]?.searchParams.get("symbols")).toBe(symbol + "," + missing);
    providerAvailable = false;

    const { ref, observedAt } = result.output.data;
    const manifest = await marketManifest(tradeDate, observedAt);
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, depth: { revision: ref.revision, asOf: observedAt, maxAgeMs: 10_000 } }));
    expect(await run("observation", "replay-market-emotion", "--manifest", manifestFile)).toMatchObject({
      code: 0, output: { ok: true, data: { input: { depth: { ref, endpoint: "/v1/depth/batch", usedSymbols: [symbol] } },
        dashboard: { metrics: { limit_up: 0, seal_rate: 0 },
          evidence: { exchange: { seal: { observedLimitUps: 1 }, depthCorrection: { coverage: "complete" } } } },
      } },
    });
    expect(requests).toHaveLength(1);
    expect(await collect(tradeDate)).toMatchObject({ code: 1, output: { error: { code: "observation_collection_failed" } } });
    expect(requests).toHaveLength(2);
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

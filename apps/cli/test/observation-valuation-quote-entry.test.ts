import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI archives a mixed stock and ETF quote poll and replays exact intraday marks offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-valuation-quotes-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const symbolsPath = join(root, "valuation symbols.json");
  const manifestPath = join(root, "valuation manifest.json");
  const tradeDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format();
  const stock = "600001.SH", etf = "510330.SH", missing = "159915.SZ";
  const requested = [missing, etf, stock];
  const prices = [{ symbol: etf, price: 4.5 }, { symbol: stock, price: 11 }];
  const requests: string[] = [];
  // Simulate an earlier quote on the requested date, independent of either process's receipt clock.
  const timestamp = Date.parse(tradeDate + "T00:00:00+08:00");
  let stopped = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    if (url.pathname !== "/v1/quotes" || url.searchParams.get("symbols") !== requested.join(",") ||
      request.headers.get("x-api-key") !== "valuation-quotes-cli-fixture") return new Response("", { status: 403 });
    return Response.json({ data: prices.map(({ symbol, price }) => ({
      symbol, region: "CN", timestamp, last_price: price, prev_close: price, open: price,
      high: price, low: price, volume: 100, amount: null,
    })) });
  } });
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function collect(symbols: string[], date = tradeDate) {
    writeFileSync(symbolsPath, JSON.stringify(symbols));
    return run("observation", "collect-valuation-quotes", "--date", date, "--symbols-file", symbolsPath);
  }
  function replay(value: unknown) {
    writeFileSync(manifestPath, JSON.stringify(value));
    return run("observation", "replay-paper-valuation", "--manifest", manifestPath);
  }
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "valuation-quotes-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = (await run("--help")).output.data.commands;
    expect(help).toContainEqual({ command: "whyj --json observation collect-valuation-quotes",
      description: "Archive one current Shanghai quote poll for stocks and ETFs" });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await collect([etf, etf])).toMatchObject(invalid);
    expect(await collect(["399001.SZ", etf])).toMatchObject(invalid);
    expect(await collect(requested, "2000-01-01")).toMatchObject(invalid);
    expect(requests).toHaveLength(0);

    const capture = await collect([stock, missing, etf]);
    expect(capture).toMatchObject({ code: 0, output: { ok: true, data: {
      source: "tickflow", endpoint: "/v1/quotes", tradeDate, status: "archived",
      requestedSymbols: requested, rowCount: 2, missingSymbols: [missing], outsideCaptureSymbols: [], ref: { kind: "valuation-quote-poll", version: 1 },
    } } });
    const ref = capture.output.data.ref;
    expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
    await server.stop(true);
    stopped = true;

    const manifest = { schemaVersion: 1, accountId: "mixed-fixture", basis: "snapshot", tradeDate, currency: "CNY",
      priceBasisConfirmation: "caller-confirmed-unadjusted-CNY", cash: 100, initialCash: 1_650,
      positions: [
        { symbol: stock, assetType: "stock", currency: "CNY", quantity: 100, averageCost: 10, availableQuantity: 100 },
        { symbol: etf, assetType: "etf", currency: "CNY", quantity: 100, averageCost: 4, availableQuantity: 100 },
        { symbol: missing, assetType: "etf", currency: "CNY", quantity: 50, averageCost: 3, availableQuantity: 50 },
      ], valuationQuoteRevision: ref.revision };
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", basis: "snapshot", equity: 1_800, totalPnl: 150,
      coverage: { marketMarks: 2, costFallbackSymbols: [missing] },
      inputs: { quotePoll: { ref, source: "tickflow", quotes: [
        { symbol: missing, requested: true, price: null, sourceTimestamp: null, receivedAt: null },
        { symbol: etf, requested: true, price: 4.5, sourceTimestamp: timestamp, receivedAt: expect.any(String) },
        { symbol: stock, requested: true, price: 11, sourceTimestamp: timestamp, receivedAt: expect.any(String) },
      ] } },
    } } });
    expect(await replay(manifest)).toEqual(result);
    expect(await replay({ ...manifest, quoteRevision: ref.revision })).toMatchObject(invalid);
    expect(await replay({ ...manifest, valuationQuoteRevision: "../outside" })).toMatchObject(invalid);
    expect(await replay({ ...manifest, basis: "finalized", dailyRevisions: [] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, valuationQuoteRevision: undefined, quoteRevision: ref.revision })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    expect(requests).toHaveLength(1);
  } finally {
    if (!stopped) await server.stop(true);
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("actual CLI captures an ETF close and uses the fixed revision in offline valuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-etf-daily-cli-"));
  const manifestPath = join(root, "valuation.json");
  const previous = process.env.OHQUANT_DIR;
  const symbol = "510330.SH", start = "2025-06-17", end = "2025-06-18";
  const timestamp = Date.parse(end + "T15:00:00+08:00");
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    const url = new URL(request.url);
    if (url.pathname !== "/v1/klines" || url.searchParams.get("symbol") !== symbol ||
      url.searchParams.get("period") !== "1d" || url.searchParams.get("adjust") !== "none" ||
      request.headers.get("x-api-key") !== "etf-daily-cli-fixture") return new Response("", { status: 403 });
    return Response.json({ data: { symbol, timestamp: [timestamp], open: [4], close: [4.1],
      high: [4.2], low: [3.9], volume: [200], amount: [null] } });
  } });
  let stopped = false;
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(value: unknown) {
    writeFileSync(manifestPath, JSON.stringify(value));
    return run("observation", "replay-paper-valuation", "--manifest", manifestPath);
  }
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "etf-daily-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation collect-etf-daily");
    const capture = await run("observation", "collect-etf-daily", "--symbol", symbol, "--start", start, "--end", end);
    expect(capture).toMatchObject({ code: 0, output: { ok: true, data: {
      source: "tickflow", endpoint: "/v1/klines", market: "A", assetType: "etf",
      adjustment: "none", priceUnit: "unknown", requested: { start, end }, status: "archived",
      rowCount: 1, ref: { kind: "dated-etf-daily", version: 1 },
    } } });
    const ref = capture.output.data.ref;
    expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
    await server.stop(true);
    stopped = true;

    const manifest = { schemaVersion: 1, accountId: "paper-fixture", basis: "finalized", tradeDate: end, currency: "CNY",
      priceBasisConfirmation: "caller-confirmed-unadjusted-CNY", cash: 300, initialCash: 700,
      positions: [{ symbol, assetType: "etf", currency: "CNY", quantity: 100, averageCost: 4, availableQuantity: 100 }],
      dailyRevisions: [], etfDailyRevisions: [ref.revision] };
    const valued = await replay(manifest);
    expect(valued).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", basis: "finalized", equity: 710, totalPnl: 10, coverage: { marketMarks: 1, costFallbackSymbols: [] },
      inputs: { etfDaily: [{ ref, source: "tickflow", priceUnit: "unknown", price: 4.1, sourceTimestamp: timestamp }] },
    } } });
    expect(await replay(manifest)).toEqual(valued);
    expect(await replay({ ...manifest, tradeDate: start })).toMatchObject({ code: 0, output: { ok: true, data: {
      equity: 700, coverage: { marketMarks: 0, costFallbackSymbols: [symbol] }, inputs: { etfDaily: [{ ref, price: null }] },
    } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, etfDailyRevisions: ["../outside"] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, basis: "snapshot", dailyRevisions: undefined, quoteRevision: "0".repeat(64) })).toMatchObject(invalid);
    expect(await run("observation", "collect-etf-daily", "--symbol", "600001.SH", "--start", start, "--end", end)).toMatchObject(invalid);
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await replay({ ...manifest, tradeDate: "2025-06-19" })).toMatchObject(unavailable);
    expect(await replay({ ...manifest, etfDailyRevisions: ["0".repeat(64)] })).toMatchObject(unavailable);
    expect(requests).toBe(1);
  } finally {
    if (!stopped) await server.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const tradeDate = "2024-04-08";
const timestamp = (time: string) => Date.parse(tradeDate + "T" + time + "+08:00");

test("current stock and ETF CLI manifests opt in to a separate TickFlow quote receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-minute-quote-tail-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const clock = join(root, "fixture clock.cjs");
  writeFileSync(clock, `
let now = ${timestamp("09:31:20")};
Date.now = () => now;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (new URL(input instanceof Request ? input.url : input).pathname === "/v1/quotes") now = ${timestamp("09:31:55")};
  return originalFetch(input, init);
};
`);
  const manifest = join(root, "current minutes.json");
  const requests: [string, string | null][] = [];
  const minutePath = "/v1/klines/intraday/batch";
  const quotesPath = "/v1/quotes";
  const key = "minute-quote-tail-cli-fixture";
  let quoteStatus: "fresh" | "stale" | "unavailable" = "fresh";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("x-api-key") !== key) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbols");
    requests.push([url.pathname, symbol]);
    if (symbol === null) return new Response(null, { status: 400 });
    if (url.pathname === minutePath) {
      return Response.json({ data: { [symbol]: {
        timestamp: [timestamp("09:31:00")], open: [10], high: [11], low: [10], close: [11], volume: [0], amount: [0],
      } } });
    }
    if (url.pathname !== quotesPath || quoteStatus === "unavailable") return new Response(null, { status: 403 });
    return Response.json({ data: [{
      symbol, region: "CN", timestamp: timestamp(quoteStatus === "stale" ? "09:31:22" : "09:31:45"),
      last_price: 12, prev_close: 10, open: 10, high: 12, low: 10, volume: 300, amount: 3_000,
    }] });
  } });
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", "--require", clock, fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "--preload", clock, "src/index.ts"];
  const run = async (command: string, value: unknown) => {
    writeFileSync(manifest, JSON.stringify(value));
    const child = Bun.spawn([...entry, "--json", "observation", command, "--manifest", manifest], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TICKFLOW_API_KEY: key, TICKFLOW_BASE_URL: server.url.origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(key);
    return { code, output: JSON.parse(stdout) };
  };
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: key, TICKFLOW_BASE_URL: server.url.origin } });
    const quoteTail = { maxAgeMs: 15_000, priceBasis: "caller-confirmed-same-basis" };
    const interpretation = { timestampLabel: "minute-start", priceBasis: "caller-confirmed-unadjusted-CNY" };
    for (const [command, field, symbol] of [
      ["read-current-stock-minutes", "stocks", "600001.SH"],
      ["read-current-etf-minutes", "etfs", "510300.SH"],
    ]) {
      requests.length = 0;
      const input = { version: 1, tradeDate, [field]: [{ symbol }], interpretation };
      const enabled = { ...input, quoteTail };
      const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
      for (const bad of [
        { ...enabled, interpretation: undefined },
        { ...enabled, quoteTail: null },
        { ...enabled, quoteTail: { ...quoteTail, maxAgeMs: -1 } },
        { ...enabled, quoteTail: { ...quoteTail, maxAgeMs: 1.5 } },
        { ...enabled, quoteTail: { ...quoteTail, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 } },
        { ...enabled, quoteTail: { ...quoteTail, priceBasis: "unknown" } },
        { ...enabled, quoteTail: { ...quoteTail, extra: true } },
      ]) expect(await run(command, bad)).toMatchObject(invalid);
      expect(requests).toEqual([]);
      const base = await run(command, input);
      expect(base).toMatchObject({ code: 0, output: { ok: true } });
      expect(base.output.data.input).not.toHaveProperty("quoteTail");
      expect(requests).toEqual([[minutePath, symbol]]);

      quoteStatus = "fresh";
      const fresh = await run(command, enabled);
      expect(fresh).toMatchObject({ code: 0, output: { ok: true, data: {
        input: { minutes: base.output.data.input.minutes, quoteTail: { status: "observed", source: "tickflow",
          data: [{ symbol, lastPrice: 12, timestamp: timestamp("09:31:45") }] } },
        rows: [{ quoteTail: { producer: "whyj", status: "updated", applied: { finality: "provisional" } },
          metrics: { points: [{ close: 12, priceSource: "quote" }] } }],
      } } });
      quoteStatus = "stale";
      const stale = await run(command, enabled);
      expect(stale).toMatchObject({ code: 0, output: { ok: true, data: { rows: [{
        quoteTail: { status: "unchanged", reason: "stale-quote" }, metrics: base.output.data.rows[0].metrics,
      }] } } });
      quoteStatus = "unavailable";
      const unavailable = await run(command, enabled);
      expect(unavailable).toMatchObject({ code: 0, output: { ok: true, data: { input: { quoteTail: { status: "unavailable" } },
        rows: [{ metrics: base.output.data.rows[0].metrics }] } } });
      const expectedPaths = [minutePath, minutePath, quotesPath, minutePath, quotesPath, minutePath, quotesPath];
      expect(requests).toEqual(expectedPaths.map((path): [string, string] => [path, symbol]));
    }
  } finally {
    await server.stop(true);
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

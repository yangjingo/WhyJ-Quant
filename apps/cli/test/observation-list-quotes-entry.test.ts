import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveMarketCrossSection, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const symbol = "600000.SH";
function marketArchive(tradeDate: string) {
  const observedAt = new Date(tradeDate + "T10:00:00+08:00").toISOString();
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({
    tradeDate, market: "A", source: "tushare",
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "fixture", listedOn: null, industry: null }] },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open: 9, high: 9, low: 9, close: 9, exRightsPreviousClose: 9,
        returnPct: 0, changeCny: 0, volume: 5, amount: 4.5 }] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

test("only the explicit list quote command contacts the configured provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-quotes-cli-"));
  const manifestPath = join(root, "list-rows.json");
  const before = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const requests: string[] = [];
  let failure = false;
  const date = "2024-03-05";
  const now = Date.parse(date + "T10:00:00+08:00");
  const timestamp = now - 1_000;
  const clock = join(root, "clock.cjs");
  // The CLI uses both no-argument Intl formatting and Date to select and timestamp current quotes.
  writeFileSync(clock, `
const fixed = ${now};
globalThis.Date = new Proxy(Date, {
  apply(target) { return new target(fixed).toString(); },
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [fixed], newTarget);
  },
  get(target, key, receiver) {
    return key === "now" ? () => fixed : Reflect.get(target, key, receiver);
  },
});
const formatGetter = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format").get;
Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
  configurable: true,
  get() {
    const format = formatGetter.call(this);
    return (value = fixed) => format(value);
  },
});
`);
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + "?" + url.searchParams.get("symbols"));
    if (failure) return new Response("fixture-provider-error", { status: 403 });
    return Response.json({ data: [{ symbol, region: "CN", timestamp, last_price: 11, prev_close: 10,
      open: 10, high: 11, low: 9, volume: 0, amount: null }] });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-list-quote-key", TICKFLOW_BASE_URL: provider.url.origin } });
    const [marketRef, historicalRef] = await Promise.all([marketArchive(date), marketArchive("2024-03-04")]);
    const input = { version: 1, marketRevision: marketRef.revision, adjustment: "none", stocks: [{ symbol }] };
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, "run", "--preload", clock, "src/index.ts", "--json", ...args], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "" },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      return { code, output: JSON.parse(stdout) };
    };
    const observe = ["observation", "read-list-quotes", "--manifest", manifestPath];
    writeFileSync(manifestPath, JSON.stringify(input));
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation read-list-quotes");
    const fixed = await run("observation", "replay-list-rows", "--manifest", manifestPath);
    expect(fixed).toMatchObject({ code: 0, output: { data: { tradeDate: date, rows: [{ observations: { bar: { close: 9 } } }] } } });
    expect(requests).toEqual([]);
    expect(await run(...observe)).toMatchObject({ code: 0, output: { data: {
      fixed: fixed.output.data, quotes: { status: "observed", source: "tickflow", units: "unknown", rows: [
        { symbol, status: "available", sourceTimestamp: timestamp, snapshot: { lastPrice: 11, volume: 0 },
          change: { producer: "whyj", changeAmount: 1, changeFraction: 0.1 } },
      ] },
    } } });
    expect(requests).toEqual(["/v1/quotes?" + symbol]);
    writeFileSync(manifestPath, JSON.stringify({ ...input, marketRevision: historicalRef.revision }));
    expect(await run(...observe)).toMatchObject({ code: 0, output: { data: { quotes: { status: "outside-current-day" } } } });
    writeFileSync(manifestPath, JSON.stringify({ ...input, version: 2 }));
    expect(await run(...observe)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    expect(requests).toHaveLength(1);
    failure = true;
    writeFileSync(manifestPath, JSON.stringify(input));
    expect(await run(...observe)).toMatchObject({ code: 0, output: {
      data: { fixed: fixed.output.data, quotes: { status: "unavailable" } },
    } });
    expect(requests).toHaveLength(2);
  } finally {
    await provider.stop(true);
    if (before === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

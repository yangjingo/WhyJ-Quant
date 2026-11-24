import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDatedEtfDailyBars, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const tradeDate = "2024-04-08", previousTradeDate = "2024-04-03";
const stamp = (date: string, time: string) => Date.parse(date + "T" + time + "+08:00");

test("CLI captures one native current ETF batch and exposes optional WHYJ chart indicators", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-etf-minute-cli-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const clock = join(root, "fixture clock.cjs");
  writeFileSync(clock, "Date.now = () => " + stamp(tradeDate, "10:00:00") + ";\n");
  const manifest = join(root, "ETF minutes.json");
  const etf = "510300.SH", noClose = "159915.SZ", missing = "588000.SH";
  const symbols = [etf, noClose, missing];
  const requests: URL[] = [];
  let online = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(url);
    if (!online || request.headers.get("x-api-key") !== "etf-minute-cli-fixture") return new Response(null, { status: 403 });
    const raw = (close: number) => ({ timestamp: [stamp(tradeDate, "09:31:00")],
      open: [close], high: [close], low: [close], close: [close], volume: [0], amount: [0] });
    return Response.json({ data: { [etf]: raw(10), [noClose]: raw(8) } });
  } });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "--preload", clock, "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TICKFLOW_API_KEY: "etf-minute-cli-fixture", TICKFLOW_BASE_URL: server.url.origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("etf-minute-cli-fixture");
    return { code, output: JSON.parse(stdout) };
  };
  const read = (value: unknown) => {
    writeFileSync(manifest, JSON.stringify(value));
    return run("observation", "read-current-etf-minutes", "--manifest", manifest);
  };
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "etf-minute-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = (await run("--help")).output.data.commands;
    expect(help).toContainEqual({ command: "whyj --json observation read-current-etf-minutes",
      description: "Read provisional ETF minute batches and optional WHYJ chart indicators" });
    const ref = await archiveDatedEtfDailyBars({
      symbol: etf, market: "A", assetType: "etf", source: "tickflow", endpoint: "/v1/klines", observedAt: "2024-04-08T01:00:00Z",
      priceUnit: "unknown", volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown", interval: "1d",
      adjustment: "none", timeZone: "Asia/Shanghai", requested: { start: previousTradeDate, end: previousTradeDate },
      rows: [{ tradeDate: previousTradeDate, sourceTimestamp: stamp(previousTradeDate, "15:00:00"), open: 10, high: 10,
        low: 10, close: 10, volume: 1, amount: null }],
    });
    const raw = { version: 1, tradeDate, etfs: [{ symbol: " 510300.sh " }, { symbol: noClose }, { symbol: missing }] };
    const previousClose = { dailyRevision: ref.revision, priceBasis: "caller-confirmed-same-basis",
      calendar: { revision: "fixture-calendar", previousTradeDate, tradeDate } };
    const interpret = { ...raw, etfs: [{ symbol: etf, previousClose }, ...raw.etfs.slice(1)],
      interpretation: { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY" } };
    for (const bad of [
      { ...raw, tradeDate: previousTradeDate }, { ...raw, etfs: [{ symbol: "600000.SH" }] },
      { ...raw, etfs: [...raw.etfs, { symbol: etf }] }, { ...interpret, interpretation: undefined },
      { ...interpret, etfs: [{ symbol: etf, previousClose: { ...previousClose, dailyRevision: "../invalid" } }] },
    ]) expect(await read(bad)).toMatchObject({ code: 1, output: { ok: false, error: { code: "invalid_arguments" } } });
    expect(requests).toHaveLength(0);
    const observed = await read(raw);
    expect(observed).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { interpretation: null, minutes: { source: "tickflow", assetType: "etf", adjustment: "unknown", finality: "provisional",
        requestedSymbols: symbols, frames: [{ symbol: etf, status: "observed", rows: [{ close: 10, volume: 0, amount: 0 }] },
          { symbol: noClose, status: "observed" }, { symbol: missing, status: "missing", rows: [] }] } },
      rows: [{ metrics: null }, { metrics: null }, { metrics: null }],
    } } });
    const chart = await read(interpret);
    expect(chart).toMatchObject({ code: 0, output: { ok: true, data: { rows: [
      { previousClose: { dailyRef: ref }, metrics: { producer: "whyj", finality: "provisional", latestReturnFraction: 0,
        points: [{ minute: "09:30", averageClose: 10, previousCloseReturnFraction: 0 }] } },
      { previousClose: null, metrics: { latestReturnFraction: null } }, { status: "missing", metrics: null },
    ] } } });
    online = false;
    expect(await read(raw)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    expect(requests.map(url => [url.pathname, url.searchParams.get("symbols")])).toEqual(
      Array(3).fill(["/v1/klines/intraday/batch", symbols.join(",")]),
    );
  } finally {
    await server.stop(true);
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

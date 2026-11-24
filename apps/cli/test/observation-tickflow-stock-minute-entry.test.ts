import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveDatedStockMinutes, archiveMarketCrossSection, saveSettings } from "../../../src/storage/index.ts";

import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const first = "2024-04-08", second = "2024-04-09", symbol = "600001.SH";
const stamp = (date: string, time: string) => Date.parse(date + "T" + time + "+08:00");
const times = ["09:30:00", "09:30:59.123", "09:31:00", "09:32:00"].map(time => stamp(first, time));

test("CLI replays fixed intraday chart evidence from stock-list manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-intraday-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const manifestPath = join(root, "stock minute.json");
  async function invoke(action: string, value: unknown) {
    writeFileSync(manifestPath, JSON.stringify(value));
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", "observation", action, "--manifest", manifestPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }

  process.env.OHQUANT_DIR = root;
  try {
    const batch = {
      source: "tickflow", endpoint: "/v1/klines", market: "A", symbol, assetType: "stock", tradeDate: first,
      observedAt: "2024-04-10T01:00:00Z", coverage: "unknown", interval: "1m", adjustment: "none",
      priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native",
      timeZone: "Asia/Shanghai", timestampLabel: "provider-native", finality: "unknown",
    } as const;
    const rows = [99, 88, 9, 11].map((close, index) => ({
      sourceTimestamp: times[index]!, open: close, high: close, low: close, close, volume: 1, amount: close / 10,
    }));
    const refs = await Promise.all([archiveDatedStockMinutes({ ...batch, rows }),
      archiveDatedStockMinutes({ ...batch, tradeDate: second, rows: [] })]);
    const closeRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit",
      observedAt: batch.observedAt, requested: { startDate: first, endDate: second }, coverage: "unknown", priceUnit: "CNY",
      rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const priceBasis = "caller-confirmed-same-basis" as const;
    const interpretation = { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY",
      volumeUnit: "hand", amountUnit: "CNY-thousand" } as const;
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const listMeta = { tradeDate: first, observedAt: "2024-04-10T01:00:00Z", coverage: "unknown" } as const;
    const marketRef = await archiveMarketCrossSection({
      market: "A", source: "tushare", tradeDate: first,
      universe: { ...listMeta, endpoint: "bak_basic", universe: "provider-dated-stocks",
        members: [{ symbol, name: "Fixture", listedOn: null, industry: null }] },
      bars: { ...listMeta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
        amountUnit: "CNY-thousand", rows: [] },
      basics: { ...listMeta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
        marketValueUnit: "CNY-ten-thousand", rows: [] },
    });
    const intraday = { minuteRevision: refs[0].revision, interpretation, previousClose: { revision: closeRef.revision, priceBasis } };
    const list = { version: 1, marketRevision: marketRef.revision, adjustment: "none", stocks: [{ symbol, intraday }] };
    const fixed = await invoke("replay-list-rows", list);
    expect(fixed).toMatchObject({ code: 0, output: { ok: true, data: { rows: [{
      observations: { intraday: { ref: refs[0], tradeDate: first, volumeUnit: "provider-native", interpretation } },
      metrics: { intraday: { producer: "whyj", latestReturnFraction: 11 / 10 - 1,
        plotBaseline: { kind: "previous-close", value: 10 },
        points: [{ minute: "09:30", sourceTimestamp: times[2], close: 9, averageClose: 9 },
          { minute: "09:31", sourceTimestamp: times[3], close: 11, averageClose: 10 }] } },
    }] } } });
    expect(await invoke("read-list-quotes", list)).toMatchObject({ code: 0, output: { ok: true,
      data: { fixed: fixed.output.data, quotes: { status: "outside-current-day" } } } });
    const legacy = await invoke("replay-list-rows", { ...list, stocks: [{ symbol }] });
    expect(legacy.code).toBe(0);
    expect(legacy.output.data.rows[0].observations).not.toHaveProperty("intraday");
    for (const entry of [{ ...intraday, minuteRevision: undefined }, { ...intraday, date: first },
      { ...intraday, interpretation: { ...interpretation, amountUnit: "unknown" } }]) {
      expect(await invoke("replay-list-rows", { ...list, stocks: [{ symbol, intraday: entry }] })).toMatchObject(invalid);
    }
    for (const minuteRevision of [refs[1].revision, "e".repeat(64)]) {
      expect(await invoke("replay-list-rows", { ...list, stocks: [{ symbol, intraday: { ...intraday, minuteRevision } }] }))
        .toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    }
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("CLI reads a bounded provisional stock-minute batch and optional chart metrics", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-current-stock-minute-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const manifestPath = join(root, "current minute.json");
  const requests: URL[] = [];
  let online = true;
  const clock = join(root, "clock.cjs");
  writeFileSync(clock, "Date.now = () => " + stamp(first, "10:00:00") + ";\n");
  const token = "stock-minute-cli-fixture";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(url);
    if (!online || request.headers.get("x-api-key") !== token) return new Response(null, { status: 403 });
    expect(url.pathname).toBe("/v1/klines/intraday/batch");
    expect(url.searchParams.get("symbols")).toBe("600001.SH,000001.SZ,830799.BJ,000002.SZ");
    const prices = [99, 88, 10, 11];
    const pack = (offset: number) => ({
      timestamp: times.slice(offset), open: prices.slice(offset), high: prices.slice(offset), low: prices.slice(offset),
      close: prices.slice(offset), volume: prices.slice(offset).map(() => 1), amount: prices.slice(offset),
    });
    return Response.json({ data: { [symbol]: pack(0), "000001.SZ": pack(2), "000002.SZ": pack(times.length) } });
  } });
  async function runCli(args: string[], preload?: string) {
    const child = Bun.spawn([process.execPath, "run", ...(preload ? ["--preload", preload] : []), "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TICKFLOW_API_KEY: token, TICKFLOW_BASE_URL: server.url.origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(token);
    return { code, output: JSON.parse(stdout) };
  }
  function invoke(action: string, value: unknown, preload?: string) {
    writeFileSync(manifestPath, JSON.stringify(value));
    return runCli(["observation", action, "--manifest", manifestPath], preload);
  }
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: token, TICKFLOW_BASE_URL: server.url.origin } });
    expect((await runCli(["--help"])).output.data.commands).toContainEqual({
      command: "whyj --json observation read-current-stock-minutes",
      description: "Read provisional stock minute batches and optional WHYJ chart indicators",
    });
    const closeRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt: "2024-04-08T01:00:00Z",
      requested: { startDate: first, endDate: first }, coverage: "unknown", priceUnit: "CNY",
      rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const previousClose = { revision: closeRef.revision, priceBasis: "caller-confirmed-same-basis" };
    const interpretation = { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "hand" } as const;
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const current = { version: 1, tradeDate: first,
      stocks: [{ symbol: " 600001.sh " }, { symbol: "000001.SZ" }, { symbol: "830799.BJ" }, { symbol: "000002.SZ" }] };
    const { timestampLabel } = interpretation;
    const interpret = { ...current, stocks: [{ symbol, previousClose: previousClose }, ...current.stocks.slice(1)],
      interpretation: { timestampLabel, priceBasis: interpretation.priceBasis } };
    const read = (manifest: unknown) => invoke("read-current-stock-minutes", manifest, clock);
    expect(await read({ ...current, tradeDate: second })).toMatchObject(invalid);
    expect(await read({ ...current, stocks: [...current.stocks, { symbol }] })).toMatchObject(invalid);
    expect(await read({ ...interpret, interpretation: undefined })).toMatchObject(invalid);
    expect(await read({ ...interpret, interpretation })).toMatchObject(invalid);
    expect(await read({ ...current, stocks: [{ symbol: "399001.SZ" }] })).toMatchObject(invalid);
    expect(requests).toHaveLength(0);

    const raw = await read(current);
    expect(raw).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { interpretation: null, minutes: { finality: "provisional", adjustment: "unknown", tradeDate: first, source: "tickflow",
        frames: [{ symbol, status: "observed" }, { symbol: "000001.SZ", status: "observed" },
          { symbol: "830799.BJ", status: "missing", rows: [] }, { symbol: "000002.SZ", status: "empty", rows: [] }] } },
      rows: [{ metrics: null }, { metrics: null }, { metrics: null }, { metrics: null }],
    } } });
    expect(raw.output.data.input.minutes.frames[0].rows.map((row: { sourceTimestamp: number }) => row.sourceTimestamp)).toEqual(times);
    const chart = await read(interpret);
    expect(chart).toMatchObject({ code: 0, output: { ok: true, data: { rows: [
      { previousClose: { archiveRef: closeRef }, metrics: { producer: "whyj", finality: "provisional",
        latestReturnFraction: 11 / 10 - 1, points: [
          { minute: "09:30", sourceTimestamp: times[2], close: 10, averageClose: 10, previousCloseReturnFraction: 0 },
          { minute: "09:31", sourceTimestamp: times[3], close: 11, averageClose: 10.5 },
        ] }, excluded: [{ reason: "opening-boundary" }, { reason: "unaligned" }] },
      { previousClose: null, metrics: { latestReturnFraction: null } },
      { status: "missing", metrics: null }, { status: "empty", metrics: null },
    ] } } });
    expect(requests).toHaveLength(2);
    expect(await read({ ...interpret, stocks: [{ symbol: "000001.SZ", previousClose: previousClose }] }))
      .toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    expect(requests).toHaveLength(2);

    online = false;
    expect(await read(current)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    expect(requests).toHaveLength(3);
  } finally {
    await server.stop(true);
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

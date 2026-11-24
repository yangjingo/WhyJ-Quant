import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveMarketCrossSection, archiveTradingDateObservations, saveSettings, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const sessions = Array.from({ length: 52 }, (_, day) => new Date(Date.UTC(2025, 1, 10 + day)))
  .filter(date => date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
  .slice(0, 33).map(date => date.toISOString().slice(0, 10));
const symbol = "920001.BJ", start = sessions[0]!, end = sessions.at(-1)!;
const observedAt = "2025-05-01T00:00:00Z";
const timestamps = sessions.map(date => Date.parse(date + "T00:00:00+08:00"));

test("CLI collects the selected BSE 50 benchmark and replays all three archived deviation windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-deviation-cli-"));
  const previous = process.env.OHQUANT_DIR;
  const path = join(root, "price deviation manifest.json");
  let providerAvailable = true;
  const requests: URL[] = [];
  const close = sessions.map((_, index) => 1000 * 1.01 ** index);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url));
    if (!providerAvailable || request.headers.get("x-api-key") !== "deviation-cli-fixture") return new Response("", { status: 403 });
    return Response.json({ data: { symbol: "899050.BJ", timestamp: timestamps, open: close, high: close, low: close, close,
      volume: sessions.map(() => 100) } });
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
  const replay = (input: unknown, action = "replay-price-deviation") => {
    writeFileSync(path, JSON.stringify(input));
    return run("observation", action, "--manifest", path);
  };
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "deviation-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation replay-price-deviation",
      description: "Replay 3, 10 and 30-session stock deviations from dated archives",
    });
    const collected = await run("observation", "collect-benchmark", "--symbol", "899050.BJ", "--start", start, "--end", end);
    expect(collected).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "archived", symbol: "899050.BJ", endpoint: "/v1/klines", source: "tickflow", rowCount: sessions.length,
    } } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/klines");
    expect(requests[0]?.searchParams.get("symbol")).toBe("899050.BJ");
    expect(requests[0]?.searchParams.get("adjust")).toBe("none");
    providerAvailable = false;

    const stock = await archiveTradingDateObservations(sessions.map<StoredTradingDateBarObservation>((tradeDate, index) => {
      const price = 10 * 1.02 ** index;
      return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, sourceTimestamp: timestamps[index]!,
        observedAt, requested: { startDate: start, endDate: end }, source: "tickflow", endpoint: "/v1/klines", market: "A",
        assetType: "stock", calendarTimeZone: "Asia/Shanghai", interval: "1d", adjustment: "forward", volumeUnit: "unknown",
        amountUnit: "unknown", coverage: "unknown", values: { open: price, high: price, low: price, close: price, volume: 1, amount: null } };
    }));
    const manifest = { symbol, sessions, stockRevision: stock.revision, benchmarkRevision: collected.output.data.ref.revision };
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", outputUnit: "fraction", formula: { id: "tsp_price_deviation", version: 1 }, board: "BJ",
      benchmark: "899050.BJ", input: { stock: { ref: stock }, benchmark: { ref: collected.output.data.ref, source: "tickflow" } },
    } } });
    const day = result.output.data.rows.at(-1);
    const proximity = result.output.data.proximity.rows.at(-1);
    expect(result.output.data.proximity).toMatchObject({
      basis: "completed-session", formula: { id: "tsp_deviation_proximity", version: 1 },
    });
    expect(proximity).toMatchObject({ date: day.date, dominantWindow: 30, tier: "below-watch" });
    for (const window of [3, 10, 30] as const) {
      expect(day.comparisonDates[window]).toBe(sessions.at(-1 - window)!);
      expect(day.values[`deviate_${window}d`]).toBeCloseTo(1.02 ** window - 1.01 ** window, 12);
      expect(proximity.windows.find((entry: { window: number }) => entry.window === window).threshold)
        .toBe({ 3: 0.4, 10: 1, 30: 2 }[window]);
    }
    const meta = { tradeDate: end, observedAt, coverage: "unknown" } as const;
    const marketRef = await archiveMarketCrossSection({
      source: "tushare", market: "A", tradeDate: end,
      universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
        members: [{ symbol, name: "fixture", listedOn: null, industry: null }] },
      bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [] },
      basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
        marketValueUnit: "CNY-ten-thousand", rows: [] },
    });
    const deviationCalendar = { revision: "cli-fixture-calendar", sessions };
    const deviation = { stockRevision: manifest.stockRevision, benchmarkRevision: manifest.benchmarkRevision };
    const list = { version: 1, marketRevision: marketRef.revision, adjustment: "none", deviationCalendar, stocks: [{ symbol, deviation }] };
    const fixed = await replay(list, "replay-list-rows");
    const { rows: _rows, calendar, proximity: { rows: _pointRows, ...proximityEvidence }, ...deviationEvidence } = result.output.data;
    expect(fixed).toMatchObject({ code: 0, output: { ok: true, data: {
      deviationCalendar: { ...deviationCalendar, ...calendar },
      rows: [{ instrument: { symbol }, observations: { bar: null }, metrics: {
        deviation: { ...deviationEvidence, ...day, proximity: { ...proximityEvidence, ...proximity } },
      } }],
    } } });
    expect(await replay(list, "read-list-quotes")).toMatchObject({ code: 0, output: { ok: true, data: {
      fixed: fixed.output.data, quotes: { status: "outside-current-day" },
    } } });
    const missingIndex = await replay({ ...list, stocks: [{ symbol, deviation: { stockRevision: manifest.stockRevision } }] }, "replay-list-rows");
    expect(missingIndex).toMatchObject({ code: 0, output: { data: { rows: [{ metrics: { deviation: {
      input: { benchmark: null }, values: { deviate_3d: null, deviate_10d: null, deviate_30d: null }, proximity: { tier: "unavailable" },
    } } }] } } });
    const legacy = await replay({ ...list, deviationCalendar: undefined, stocks: [{ symbol }] }, "replay-list-rows");
    expect(legacy).toMatchObject({ code: 0, output: { ok: true } });
    expect(legacy.output.data).not.toHaveProperty("deviationCalendar");
    expect(legacy.output.data.rows[0].metrics).not.toHaveProperty("deviation");
    for (const malformed of [{ ...list, deviationCalendar: undefined },
      { ...list, deviationCalendar: { ...deviationCalendar, sessions: [start, start] } },
      { ...list, stocks: [{ symbol, deviation: { ...deviation, stockRevision: "../private" } }] }]) {
      expect(await replay(malformed, "replay-list-rows")).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    }
    expect(await replay({ ...list, stocks: [{ symbol, deviation: { ...deviation, benchmarkRevision: "f".repeat(64) } }] }, "replay-list-rows"))
      .toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    const { benchmarkRevision: _reference, ...noBenchmark } = manifest;
    const missing = await replay(noBenchmark);
    expect(missing.output.data.rows.at(-1)?.values).toEqual({ deviate_3d: null, deviate_10d: null, deviate_30d: null });
    expect(missing.output.data.proximity.rows.at(-1)).toMatchObject({ tier: "unavailable", maxCloseness: null });
    expect(await replay({ ...manifest, sessions: [start, start] })).toMatchObject({
      code: 1, output: { error: { code: "invalid_arguments" } },
    });
    expect(await replay({ ...manifest, benchmarkRevision: "e".repeat(64) })).toMatchObject({
      code: 1, output: { error: { code: "observation_archive_unavailable" } },
    });
    expect(requests).toHaveLength(1);
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

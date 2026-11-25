import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, loadDatedStockMinuteArchive, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";
import { replayTspIntradayMonitorAlerts, type IntradayMonitorAlertReplayRequest } from "../../../src/runtime/data/intraday-monitor-alert-replay.ts";
import { replayTspTickFlowStockMinutes } from "../../../src/runtime/data/tickflow-stock-minute-replay.ts";

const first = "2024-04-08", second = "2024-04-09", symbol = "600001.SH";
const stamp = (date: string, time: string) => Date.parse(`${date}T${time}+08:00`);
const times = ["09:30:00", "09:30:59.123", "09:31:00", "09:32:00"].map(time => stamp(first, time));

test("CLI captures exact TickFlow stock minute data and replays the same indicators and monitor events offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-tickflow-stock-minute-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const manifestPath = join(root, "stock minute.json");
  const requests: URL[] = [];
  let online = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(url);
    if (!online || request.headers.get("x-api-key") !== "stock-minute-cli-fixture") return new Response(null, { status: 403 });
    expect(url.pathname).toBe("/v1/klines");
    expect(url.searchParams.get("symbol")).toBe(symbol);
    expect(url.searchParams.get("period")).toBe("1m");
    expect(url.searchParams.get("adjust")).toBe("none");
    const timestamp = url.searchParams.get("start_time") === String(stamp(first, "09:25:00")) ? times : [];
    const prices = timestamp.length ? [99, 88, 9, 11] : [];
    return Response.json({ data: { symbol, timestamp, open: prices, high: prices, low: prices, close: prices,
      volume: prices.map(() => 1), amount: prices.map(price => price / 10) } });
  } });
  const run = async (...args: string[]) => {
    const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
      ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
      : [process.execPath, "run", "src/index.ts"];
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TICKFLOW_API_KEY: "stock-minute-cli-fixture", TICKFLOW_BASE_URL: server.url.origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("stock-minute-cli-fixture");
    return { code, output: JSON.parse(stdout) };
  };
  const invoke = (command: string, value: unknown) => {
    writeFileSync(manifestPath, JSON.stringify(value));
    return run("observation", command, "--manifest", manifestPath);
  };

  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "stock-minute-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = (await run("--help")).output.data.commands;
    expect(help).toContainEqual({ command: "whyj --json observation collect-tickflow-stock-minutes",
      description: "Capture one completed TickFlow stock minute session" });
    expect(help).toContainEqual({ command: "whyj --json observation replay-tickflow-stock-minutes",
      description: "Replay intraday stock metrics from exact TickFlow minute archives" });
    const collect = (tradeDate: string, code = symbol) => run("observation", "collect-tickflow-stock-minutes", "--symbol", code, "--date", tradeDate);
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await collect("9999-12-31")).toMatchObject(invalid);
    expect(await collect(first, "399001.SZ")).toMatchObject(invalid);
    expect(requests).toHaveLength(0);

    const saved = await collect(first);
    const empty = await collect(second);
    expect(saved).toMatchObject({ code: 0, output: { ok: true, data: { symbol, tradeDate: first, rowCount: 4, status: "archived", ref: { kind: "dated-stock-minute" } } } });
    expect(empty).toMatchObject({ code: 0, output: { ok: true, data: { symbol, tradeDate: second, rowCount: 0, status: "empty" } } });
    expect(requests.map(url => url.searchParams.get("end_time"))).toEqual([first, second].map(date => String(stamp(date, "15:05:00"))));
    const refs = [saved.output.data.ref, empty.output.data.ref];
    expect((await loadDatedStockMinuteArchive(refs[0])).rows.map(row => row.sourceTimestamp)).toEqual(times);
    const closeRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt: "2024-04-10T01:00:00Z",
      requested: { startDate: first, endDate: second }, coverage: "unknown", priceUnit: "CNY",
      rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const priceBasis = "caller-confirmed-same-basis" as const;
    const interpretation = { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "hand", amountUnit: "CNY-thousand" } as const;
    const history = { minuteRevisions: refs.map(ref => ref.revision), interpretation, previousClose: { revision: closeRef.revision, priceBasis } };

    online = false;
    const replay = { version: 1, ...history };
    const metrics = await invoke("replay-tickflow-stock-minutes", replay);
    const runtimeHistory = { refs, interpretation, previousClose: { ref: closeRef, priceBasis } };
    expect(metrics.code).toBe(0);
    expect(metrics.output.data).toEqual(await replayTspTickFlowStockMinutes(runtimeHistory));
    expect(metrics.output.data.rows[1]).toMatchObject({ minute: "09:31", sourceTimestamp: times[3], values: { price: 11, vwap: 10 },
      signals: { signal_intraday_zero_cross_up: true, signal_intraday_avg_cross_up: true } });
    expect(metrics.output.data.excluded.map((row: { reason: string }) => row.reason)).toEqual(["opening-boundary", "unaligned"]);
    const rule: IntradayMonitorAlertReplayRequest["rule"] = { id: "stock_cross", revision: "v1", type: "signal", assetType: "stock", scope: { kind: "all" },
      logic: "and", severity: "warn", cooldownMs: 0,
      conditions: [{ field: "signal_intraday_zero_cross_up", op: "truth" }, { field: "volume", op: ">=", value: 100, unit: "share" }] };
    const scope = { roster: [symbol], slots: [{ tradeDate: first, minute: "09:31" }, { tradeDate: second, minute: "09:31" }], rule };
    const monitor = { version: 1, ...scope, histories: [{ symbol, ...history }] };
    const alerts = await invoke("replay-intraday-monitor-alerts", monitor);
    expect(alerts.code).toBe(0);
    expect(alerts.output.data).toEqual(await replayTspIntradayMonitorAlerts({ ...scope, histories: [{ symbol, ...runtimeHistory }] }));
    expect(alerts.output.data.evaluations[0].events[0]).toMatchObject({ sourceTimestamp: times[3], operands: { volume: 100 },
      eventId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(alerts.output.data.evaluations[1]).toMatchObject({ missingSymbols: [symbol], events: [] });
    expect(await invoke("replay-intraday-monitor-alerts", monitor)).toEqual(alerts);

    expect(await invoke("replay-tickflow-stock-minutes", { ...replay, interpretation: { ...interpretation, timestampLabel: "provider-native" } })).toMatchObject(invalid);
    expect(await invoke("replay-tickflow-stock-minutes", { ...replay, minuteRevisions: [refs[0].revision, refs[0].revision] })).toMatchObject(invalid);
    expect(await invoke("replay-intraday-monitor-alerts", { ...monitor, histories: [{ symbol, ...history, minuteRevision: refs[0].revision }] })).toMatchObject(invalid);
    expect(await invoke("replay-tickflow-stock-minutes", { ...replay, minuteRevisions: ["f".repeat(64)] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    expect(requests).toHaveLength(2);
    expect(await collect(first)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    expect(requests).toHaveLength(3);
  } finally {
    await server.stop(true);
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

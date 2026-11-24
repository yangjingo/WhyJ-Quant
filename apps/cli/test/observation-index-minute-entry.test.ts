import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const symbol = "000001.SH", date = "2024-04-08", previousDate = "2024-04-03";
const minute = Date.parse(date + "T09:31:00+08:00"), daily = Date.parse(previousDate + "T00:00:00+08:00");

test("CLI captures index chart inputs and reproduces exact offline returns after provider shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-index-minutes-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const calls: URL[] = [];
  const currentNow = Date.parse(date + "T09:32:00+08:00");
  let emptyCurrent = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    calls.push(url);
    if (url.pathname !== "/v1/klines" || url.searchParams.get("symbol") !== symbol ||
      url.searchParams.get("adjust") !== "none" || request.headers.get("x-api-key") !== "index-minutes-cli-fixture") {
      return new Response("", { status: 403 });
    }
    if (url.searchParams.get("period") === "1d") {
      return Response.json({ data: { symbol, timestamp: [daily], open: [3_000], high: [3_010],
        low: [2_990], close: [3_000], volume: [80] } });
    }
    if (url.searchParams.get("period") === "1m") {
      const blank = Number(url.searchParams.get("start_time")) < minute - 86_400_000 ||
        (emptyCurrent && Number(url.searchParams.get("end_time")) === currentNow);
      return Response.json({ data: { symbol, timestamp: blank ? [] : [minute], open: blank ? [] : [3_005],
        high: blank ? [] : [3_032], low: blank ? [] : [3_001], close: blank ? [] : [3_030], volume: blank ? [] : [0] } });
    }
    return new Response("", { status: 400 });
  } });
  let stopped = false;
  const runCli = async (args: string[], clock?: string) => {
    const child = Bun.spawn([process.execPath, "run", ...(clock ? ["--preload", clock] : []), "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const run = (...args: string[]) => runCli(args);
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "index-minutes-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command)).toContain("whyj --json observation collect-index-minutes");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command)).toContain("whyj --json observation replay-index-minutes");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command)).toContain("whyj --json observation read-current-index-minutes");

    const minuteCapture = await run("observation", "collect-index-minutes", "--symbol", symbol, "--date", date);
    expect(minuteCapture).toMatchObject({ code: 0, output: { ok: true, data: { status: "archived", rowCount: 1,
      symbol, tradeDate: date, priceBasis: "index-level", ref: { kind: "dated-index-minute" } } } });
    const empty = await run("observation", "collect-index-minutes", "--symbol", symbol, "--date", previousDate);
    expect(empty).toMatchObject({ code: 0, output: { ok: true, data: { status: "empty", rowCount: 0, tradeDate: previousDate } } });
    const benchmark = await run("observation", "collect-benchmark", "--symbol", symbol, "--start", previousDate, "--end", previousDate);
    expect(benchmark).toMatchObject({ code: 0, output: { ok: true, data: { rowCount: 1, ref: { kind: "benchmark-index" } } } });
    expect(calls).toHaveLength(3);

    const read = ["observation", "read-current-index-minutes", "--symbol", symbol, "--date", date];
    const closeArgs = ["--daily-revision", benchmark.output.data.ref.revision, "--previous-date", previousDate, "--calendar-revision", "fixture-holiday-calendar"];
    const clock = join(root, "index-preview-clock.cjs");
    await Bun.write(clock, "Date.now = () => " + currentNow);
    const invalidLive = { code: 1, output: { error: { code: "invalid_arguments" } } };
    expect(await runCli(read.concat("--previous-date", previousDate), clock)).toMatchObject(invalidLive);
    expect(await runCli(["observation", "read-current-index-minutes", "--symbol", symbol, "--date", previousDate], clock)).toMatchObject(invalidLive);
    expect(await runCli(read.concat("--daily-revision", "f".repeat(64), "--previous-date", previousDate, "--calendar-revision", "fixture"), clock))
      .toMatchObject({ code: 1, output: { error: { code: "observation_collection_failed" } } });
    const beforeOpen = join(root, "index-preview-before-open.cjs");
    await Bun.write(beforeOpen, "Date.now = () => " + Date.parse(date + "T08:00:00+08:00"));
    expect(await runCli(read, beforeOpen)).toMatchObject({ code: 0, output: { data: {
      status: "before-window", input: { minutes: { requestedWindow: null, rows: [] } },
    } } });
    expect(calls).toHaveLength(3);

    const preview = await runCli(read.concat(closeArgs), clock);
    expect(preview).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "observed", input: {
        minutes: { symbol, tradeDate: date, endpoint: "/v1/klines", finality: "provisional", requestedWindow: { endTime: currentNow },
          rows: [{ sourceTimestamp: minute, closePoints: 3_030, volume: 0, amount: null }] },
        previousClose: { dailyRef: benchmark.output.data.ref, row: { tradeDate: previousDate, closePoints: 3_000 } },
      }, metrics: { producer: "whyj", returnUnit: "fraction", previousClosePoints: 3_000 },
    } } });
    expect(preview.output.data.metrics.points[0]?.returnFraction).toBeCloseTo(0.01, 12);
    expect(calls[3]?.searchParams.get("end_time")).toBe(String(currentNow));
    emptyCurrent = true;
    expect(await runCli(read, clock)).toMatchObject({ code: 0, output: { data: {
      status: "empty", input: { minutes: { rows: [], requestedWindow: { endTime: currentNow } } }, metrics: { points: [] },
    } } });
    expect(calls).toHaveLength(5);
    await server.stop(true);
    stopped = true;

    const captured = minuteCapture.output.data.ref;
    const reference = benchmark.output.data.ref;
    const options = ["--daily-revision", reference.revision, "--previous-date", previousDate, "--date", date, "--calendar-revision", "fixture-holiday-calendar"];
    const replay = await run("observation", "replay-index-minutes", "--revision", captured.revision, ...options);
    expect(replay).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { minutes: { ref: captured, rows: [{ sourceTimestamp: minute, closePoints: 3_030, volume: 0, amount: null }] },
        previousClose: { dailyRef: reference, row: { tradeDate: previousDate, closePoints: 3_000 } } },
      metrics: { producer: "whyj", returnUnit: "fraction", previousClosePoints: 3_000 },
    } } });
    expect(replay.output.data.metrics.points[0]?.returnFraction).toBeCloseTo(0.01, 12);
    const rawOnly = await run("observation", "replay-index-minutes", "--revision", captured.revision);
    expect(rawOnly.output.data.metrics.points).toEqual([{ sourceTimestamp: minute, returnFraction: null }]);
    const emptyReplay = await run("observation", "replay-index-minutes", "--revision", empty.output.data.ref.revision);
    expect(emptyReplay.output.data.input.minutes.rows).toEqual([]);

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run("observation", "collect-index-minutes", "--symbol", "000001.SZ", "--date", date)).toMatchObject(invalid);
    expect(await run("observation", "replay-index-minutes", "--revision", captured.revision, "--date", date)).toMatchObject(invalid);
    expect(await run("observation", "replay-index-minutes", "--revision", "a".repeat(64)))
      .toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    expect(calls).toHaveLength(5);
  } finally {
    if (!stopped) await server.stop(true);
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
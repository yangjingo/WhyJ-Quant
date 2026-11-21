import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const symbol = "000001.SH";
const dates = ["2024-02-23", "2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"];
const close = [101, 102, 103, 104, 105, 106];
const timestamps = dates.map(date => Date.parse(date + "T15:00:00+08:00"));

test("CLI replays exact index daily chart metrics after the capture endpoint closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-index-daily-cli-"));
  const previous = process.env.OHQUANT_DIR;
  let requests = 0;
  let deny = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    const url = new URL(request.url);
    if (deny || url.pathname !== "/v1/klines" || url.searchParams.get("symbol") !== symbol ||
      url.searchParams.get("period") !== "1d" || url.searchParams.get("adjust") !== "none" ||
      request.headers.get("x-api-key") !== "index-daily-cli-fixture") return new Response("", { status: 403 });
    return Response.json({ data: { symbol, timestamp: timestamps, open: close, close, high: close.map(value => value + 1),
      low: close.map(value => value - 1), volume: [0, 11, 12, 13, 14, 15], amount: close.map(() => null) } });
  } });
  let stopped = false;
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "index-daily-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = await run("--help");
    const commands = help.output.data.commands.map((entry: { command: string }) => entry.command);
    expect(commands).toContain("whyj --json observation collect-index-daily");
    expect(commands).toContain("whyj --json observation replay-index-daily");
    const start = dates[0]!, end = dates.at(-1)!;
    const capture = await run("observation", "collect-index-daily", "--symbol", symbol, "--start", start, "--end", end);
    expect(capture).toMatchObject({ code: 0, output: { ok: true, data: { status: "archived", rowCount: 6,
      priceBasis: "index-level", requested: { start, end }, ref: { kind: "dated-index-daily" } } } });
    deny = true;
    expect(await run("observation", "collect-index-daily", "--symbol", symbol, "--start", start, "--end", end))
      .toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    await server.stop(true);
    stopped = true;

    const ref = capture.output.data.ref;
    const display = { start: dates[4]!, end: dates[4]! };
    const replay = await run("observation", "replay-index-daily", "--revision", ref.revision, "--start", display.start, "--end", display.end);
    expect(replay).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { daily: { ref, source: "tickflow", requested: { start, end } } },
      metrics: { producer: "whyj", displayRange: display, calculationWindow: { firstDate: start, lastDate: display.end, rowCount: 5 },
        rows: [{ date: display.end, ma10: null, ma60: null, boll_upper: null, kdj_k: null }] },
    } } });
    expect(replay.output.data.input.daily.rows).toHaveLength(6);
    expect(replay.output.data.input.daily.rows[0]).toMatchObject({ sourceTimestamp: timestamps[0], closePoints: 101, volume: 0, amount: null });
    expect(replay.output.data.metrics.rows[0]?.ma5).toBeCloseTo(103, 12);
    const full = await run("observation", "replay-index-daily", "--revision", ref.revision);
    expect(full.output.data.metrics.rows[4]).toEqual(replay.output.data.metrics.rows[0]);
    expect(full.output.data.metrics.rows[0]?.ma5).toBeNull();
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run("observation", "replay-index-daily", "--revision", ref.revision, "--start", start)).toMatchObject(invalid);
    expect(await run("observation", "collect-index-daily", "--symbol", "000001.SZ", "--start", start, "--end", end)).toMatchObject(invalid);
    expect(await run("observation", "replay-index-daily", "--revision", ref.revision, "--start", start, "--end", "2025-01-01"))
      .toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    expect(await run("observation", "replay-index-daily", "--revision", "a".repeat(64)))
      .toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    expect(requests).toBe(2);
  } finally {
    if (!stopped) await server.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

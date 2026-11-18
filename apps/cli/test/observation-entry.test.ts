import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI collects a bounded TickFlow batch and replays all daily fields after the provider stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-observation-cli-"));
  let calls = 0, stopped = false;
  let deny = true;
  const days: string[] = [];
  for (const date = new Date("2024-01-02"); days.length < 65; date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() % 6 !== 0) days.push(date.toISOString().slice(0, 10));
  }
  const close = days.map((_, index) => 10 + index / 10);
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    calls++;
    expect(new URL(req.url).pathname).toBe("/v1/klines");
    expect(req.headers.get("x-api-key")).toBe("fixture-source-token");
    if (deny) return new Response("fixture-source-token", { status: 403 });
    return Response.json({ data: {
      timestamp: days.map(date => Date.parse(`${date}T00:00:00+08:00`)),
      open: close.map(value => value - 0.2), high: close.map(value => value + 0.25), low: close.map(value => value - 0.3),
      close, volume: days.map(() => 100), amount: days.map(() => null),
    } });
  } });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.preferences.source = "tickflow";
  settings.env = { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-source-token", TICKFLOW_BASE_URL: provider.url.origin };
  writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: process.cwd(), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain("fixture-source-token");
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    const help = await run("--help");
    expect(help.code).toBe(0);
    expect(help.output.data.commands.some((command: { command: string }) => command.command.includes("observation"))).toBe(true);
    const collect = ["observation", "collect-daily", "--symbol", "600000.SH", "--start", days[0]!, "--end", days.at(-1)!];
    const invalid = await run(...collect, "--key", "fixture-source-token");
    expect(invalid).toMatchObject({ code: 1, output: { ok: false, error: { code: "invalid_arguments" } } });
    expect(calls).toBe(0);
    const denied = await run(...collect);
    expect(denied).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    deny = false;
    const collected = await run(...collect);
    expect(collected).toMatchObject({
      code: 0, output: { ok: true, command: "observation", data: { source: "tickflow", endpoint: "/v1/klines",
        status: "archived", rowCount: 65, ref: { version: 2 } } },
    });
    const ref = collected.output.data.ref;
    expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
    await provider.stop(true);
    stopped = true;
    const replay = () => run("observation", "replay-daily", "--revision", ref.revision);
    const one = await replay();
    const two = await replay();
    expect(one).toEqual(two);
    expect(one).toMatchObject({ code: 0, output: { ok: true, data: { archiveRef: ref,
      input: { source: "tickflow", adjustment: "none", firstTradeDate: days[0], lastTradeDate: days.at(-1), finality: "unknown" },
      daily: { producer: "whyj", formula: { id: "tsp_daily_ohlcv", version: 1 } },
      dailySignals: { producer: "whyj", formula: { id: "tsp_daily_signals", version: 1 } } } } });
    const { daily, dailySignals } = one.output.data;
    expect(daily.fields).toHaveLength(37);
    expect(daily.rows).toHaveLength(65);
    expect(Object.keys(daily.rows.at(-1).values).sort()).toEqual([...daily.fields].sort());
    expect(daily.rows.at(-1).values.ma60).toBeCloseTo(13.45, 10);
    expect(dailySignals.fields).toHaveLength(20);
    expect(dailySignals.rows.at(-1).values).toMatchObject({ signal_n_day_high: true, signal_limit_up: null });
    expect(await run("observation", "replay-daily", "--revision", "a".repeat(64))).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    expect(await run("observation", "replay-daily", "--revision", "../private")).toMatchObject({
      code: 1, output: { ok: false, error: { code: "invalid_arguments" } },
    });
    expect(calls).toBe(2);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

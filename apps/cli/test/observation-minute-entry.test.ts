import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("the CLI collects original minutes, then replays all features and crossings offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-minute-"));
  const date = "2024-01-02", symbol = "600000.SH";
  const token = "fixture-minute-credential", fields = ["ts_code", "trade_time", "open", "high", "low", "close", "vol", "amount"];
  let mode: "denied" | "empty" | "rows" = "denied";
  let calls = 0, stopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    calls++;
    expect(await req.json()).toMatchObject({ api_name: "stk_mins", token, params: {
      ts_code: symbol, freq: "1min", start_date: date + " 09:00:00", end_date: date + " 19:00:00",
    } });
    if (mode === "denied") return new Response(token, { status: 403 });
    return Response.json({ code: 0, data: { fields, items: mode === "empty" ? [] : [
      [symbol, date + " 09:30:00", 11, 11, 11, 11, 9000, 99_000],
      [symbol, date + " 09:31:00", 9.8, 9.8, 9.8, 9.8, 100, 980],
      [symbol, date + " 09:32:00", 10.2, 10.2, 10.2, 10.2, 100, 1020],
    ] } });
  } });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.preferences.source = "tushare";
  settings.env = { WHYJ_QUANT_TUSHARE_TOKEN: token, TUSHARE_BASE_URL: provider.url.origin };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: process.cwd(), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation collect-minutes|replay-intraday",
      description: "Collect historical minutes or replay a fixed intraday revision",
    });
    const collect = ["observation", "collect-minutes", "--symbol", symbol, "--start", date, "--end", date];
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run(...collect, "--adjustment", "none")).toMatchObject(invalid);
    expect(await run("observation", "collect-minutes", "--symbol", symbol, "--start", date, "--end", "2024-02-04")).toMatchObject(invalid);
    expect(calls).toBe(0);
    expect(await run(...collect)).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_collection_failed" } },
    });
    mode = "empty";
    expect(await run(...collect)).toMatchObject({ code: 0, output: { ok: true, data: { status: "empty", ref: null, rowCount: 0 } } });
    mode = "rows";
    const receipt = await run(...collect);
    expect(receipt).toMatchObject({ code: 0, output: { ok: true, data: { source: "tushare", endpoint: "stk_mins",
      status: "archived", rowCount: 3, ref: { version: 1, kind: "historical-minute-bars" } } } });
    const ref = receipt.output.data.ref;
    expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);

    await provider.stop(true);
    stopped = true;
    const replay = ["observation", "replay-intraday", "--revision", ref.revision];
    const first = await run(...replay);
    expect(await run(...replay)).toEqual(first);
    expect(first).toMatchObject({ code: 0, output: { ok: true, data: { archiveRef: ref, producer: "whyj",
      formula: { id: "tsp_intraday", version: 1, revision: expect.any(String) },
      input: { source: "tushare", labelConvention: "tushare-stk-mins-end-time-v1", previousClose: null },
      openingBoundaries: [{ tradeTime: date + " 09:30:00", openingBoundary: true }],
    } } });
    const [open, next] = first.output.data.rows;
    expect(Object.keys(open.values)).toHaveLength(11);
    expect(Object.keys(open.signals)).toHaveLength(4);
    expect(open).toMatchObject({ minute: "09:30", originalTradeTime: date + " 09:31:00", values: { vwap: 9.8 } });
    expect(next).toMatchObject({ values: { vwap: 10 }, signals: { signal_intraday_zero_cross_up: null } });

    const oldRoot = process.env.OHQUANT_DIR;
    process.env.OHQUANT_DIR = root;
    const previousClose = await archiveDailyTradingLimits({
      symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt: "2024-01-03T00:00:00.000Z",
      coverage: "unknown", priceUnit: "CNY", requested: { startDate: date, endDate: date },
      rows: [{ tradeDate: date, previousClose: 10, limitUp: 11, limitDown: 9 }],
    }).finally(() => {
      if (oldRoot === undefined) delete process.env.OHQUANT_DIR;
      else process.env.OHQUANT_DIR = oldRoot;
    });
    expect(await run(...replay, "--previous-close-revision", previousClose.revision)).toMatchObject(invalid);
    expect(await run(...replay, "--price-basis", "caller-confirmed-same-basis")).toMatchObject(invalid);
    const paired = await run(...replay, "--previous-close-revision", previousClose.revision, "--price-basis", "caller-confirmed-same-basis");
    expect(paired.output.data.input.previousClose.archiveRef).toEqual(previousClose);
    expect(paired.output.data.rows[1].signals.signal_intraday_zero_cross_up).toBe(true);
    expect(await run("observation", "replay-intraday", "--revision", "../private")).toMatchObject(invalid);
    expect(await run("observation", "replay-intraday", "--revision", "a".repeat(64))).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    expect(calls).toBe(3);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

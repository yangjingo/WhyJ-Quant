import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI collects market environment inputs and replays the derived series offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-environment-"));
  const tradingDate = "2024-08-28", tradeDate = "20240828", stock = "600000.SH", index = "000001.SH";
  const token = "fixture-market-environment-key";
  const calls: { api: string; params: Record<string, string> }[] = [];
  const rows = Array.from({ length: 45 }, (_, offset) => new Date(Date.parse(tradingDate) - offset * 86_400_000))
    .filter(date => date.getUTCDay() % 6 !== 0).map(date => date.toISOString().slice(0, 10)).reverse().slice(-20);
  const table = (fields: string, items: (string | number | null)[][]) =>
    Response.json({ code: 0, data: { fields: fields.split(","), items } });
  let stopped = false, denied = true, emptyRisk = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/klines") {
      expect(request.headers.get("x-api-key")).toBe(token);
      const close = rows.map((_, offset) => offset === rows.length - 1 ? 10.5 : 10);
      calls.push({ api: url.pathname, params: Object.fromEntries(url.searchParams) });
      return Response.json({ data: { timestamp: rows.map(date => Date.parse(date + "T00:00:00+08:00")),
        open: close, high: close, low: close, close, volume: close.map(() => 100), amount: close.map(() => null) } });
    }
    const { api_name: api, token: received, params } = await request.json() as
      { api_name: string; token: string; params: Record<string, string> };
    expect(received).toBe(token);
    calls.push({ api, params });
    switch (api) {
      case "index_daily":
        if (denied) return new Response(token, { status: 403 });
        return table("ts_code,trade_date,close,pre_close,change,pct_chg", [[index, tradeDate, 3045, 3000, 45, 1.5]]);
      case "stk_limit":
        return table("ts_code,trade_date,pre_close,up_limit,down_limit", [[stock, tradeDate, 10, 11, 9]]);
      case "stock_st":
        return table("ts_code,name,trade_date,type,type_name", emptyRisk ? [] : [[stock, "ST Fixture", tradeDate, "ST", "风险警示板"]]);
      case "bak_basic":
        return table("trade_date,ts_code,name,industry,list_date", [[tradeDate, stock, "Fixture", null, null]]);
      case "daily":
        return table("ts_code,trade_date,open,high,low,close,vol,amount,pre_close,change,pct_chg", [
          [stock, tradeDate, 10, 10.5, 10, 10.5, 10, 2, 10, 0.5, 5],
        ]);
      case "daily_basic":
        return table("ts_code,trade_date,close,pe,pe_ttm,pb,total_mv,circ_mv,turnover_rate,turnover_rate_f,volume_ratio,total_share,float_share,free_share", []);
      default: return new Response("Unexpected request", { status: 400 });
    }
  } });
  const configure = (source: "tushare" | "tickflow") => {
    const settings = { ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source }, env: source === "tushare"
      ? { WHYJ_QUANT_TUSHARE_TOKEN: token, TUSHARE_BASE_URL: provider.url.origin }
      : { WHYJ_QUANT_TICKFLOW_API_KEY: token, TICKFLOW_BASE_URL: provider.url.origin } };
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    configure("tushare");
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation collect-benchmark|collect-limits|replay-market-environment",
      description: "Collect benchmark and exchange evidence or replay the fixed market environment",
    });
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation collect-risk-warnings",
      description: "Collect the dated risk-warning list for historical market replay",
    });
    const dates = ["--start", tradingDate, "--end", tradingDate];
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run("observation", "collect-benchmark", "--symbol", stock, ...dates)).toMatchObject(invalid);
    expect(await run("observation", "collect-limits", "--symbol", index, ...dates)).toMatchObject(invalid);
    expect(await run("observation", "collect-risk-warnings", "--date", "2024-02-30")).toMatchObject(invalid);
    expect(calls).toHaveLength(0);
    const collect = () => run("observation", "collect-benchmark", "--symbol", index, ...dates);
    expect(await collect()).toMatchObject({ code: 1, output: { error: { code: "observation_collection_failed" } } });
    denied = false;
    const benchmark = await collect();
    const limits = await run("observation", "collect-limits", "--symbol", stock, ...dates);
    const market = await run("observation", "collect-market", "--date", tradingDate);
    const collectRisk = () => run("observation", "collect-risk-warnings", "--date", tradingDate);
    const flagged = await collectRisk();
    emptyRisk = true;
    const empty = await collectRisk();
    expect(flagged).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "archived", source: "tushare", endpoint: "stock_st", tradeDate: tradingDate, coverage: "unknown", rowCount: 1,
    } } });
    expect(empty).toMatchObject({ code: 0, output: { ok: true, data: { status: "empty", rowCount: 0 } } });
    configure("tickflow");
    expect(await run("observation", "collect-risk-warnings", "--date", tradingDate)).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_collection_failed" } },
    });
    const prices = await run("observation", "collect-daily", "--symbol", stock, "--start", rows[0]!, "--end", tradingDate,
      "--adjustment", "forward");
    for (const capture of [benchmark, limits, market, prices]) {
      expect(capture).toMatchObject({ code: 0, output: { ok: true, data: { status: "archived" } } });
      expect(capture.output.data.ref.revision).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(calls.map(call => call.api)).toEqual(["index_daily", "index_daily", "stk_limit", "bak_basic", "daily", "daily_basic",
      "stock_st", "stock_st", "/v1/klines"]);
    expect(calls[1]?.params).toEqual({ ts_code: index, start_date: tradeDate, end_date: tradeDate });
    expect(calls[2]?.params).toEqual({ ts_code: stock, start_date: tradeDate, end_date: tradeDate });
    expect(calls[6]?.params).toEqual({ trade_date: tradeDate });
    await provider.stop(true);
    stopped = true;

    const revision = (capture: typeof benchmark) => capture.output.data.ref.revision as string;
    const manifest = { sessions: [tradingDate], marketRevisions: [revision(market)], limitRevisions: [revision(limits)],
      priceHistory: [{ tradeDate: tradingDate, priceRevisions: [revision(prices)] }],
      benchmark: { symbol: index, revisions: [revision(benchmark)] } };
    const path = join(root, "environment manifest.json");
    const replay = (input: unknown) => {
      writeFileSync(path, JSON.stringify(input));
      return run("observation", "replay-market-environment", "--manifest", path);
    };
    const causal = await replay(manifest);
    expect(causal).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", phase: { mode: "causal" },
      rows: [{ tradingDate, inputs: { benchmark: { returnPct: 1.5 }, prices: { returnCount: 1, aboveMa20: 1 } },
        regime: { formula: { id: "tsp_market_regime" }, input: { evidence: { indexChangeFraction: { observed: 0.015 } } } },
        phase: { phase: null } }],
    } } });
    expect(await replay(manifest)).toEqual(causal);
    expect(await replay({ ...manifest, phaseMode: "retrospective-tsp" })).toMatchObject({
      code: 0, output: { data: { phase: { mode: "retrospective-tsp" }, rows: [{ phase: { phase: "ice" } }] } },
    });
    expect(causal.output.data.rows[0]?.inputs.riskWarnings).toBeUndefined();
    expect(await replay({ ...manifest, riskWarningRevisions: [revision(flagged)] })).toMatchObject({
      code: 0, output: { data: { universe: "exclude-observed-risk-warnings", rows: [{
        regime: null, ladder: { coverage: { roster: 0 } }, inputs: { riskWarnings: { status: "matched", excludedSymbols: [stock] } },
      }] } },
    });
    expect(await replay({ ...manifest, riskWarningRevisions: [revision(empty)] })).toMatchObject({
      code: 0, output: { data: { rows: [{ ladder: { coverage: { roster: 1 } },
        inputs: { prices: { aboveMa20: 1 }, riskWarnings: { status: "matched", rowCount: 0 } } }] } },
    });
    expect(await replay({ ...manifest, riskWarningRevisions: [] })).toMatchObject({
      code: 0, output: { data: { rows: [{ regime: null, ladder: null, inputs: { riskWarnings: { status: "missing" } } }] } },
    });
    expect(await replay({ ...manifest, riskWarningRevisions: [revision(flagged), revision(flagged)] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, riskWarningRevisions: ["missing"] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, riskWarningRevisions: [revision(market)] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    expect(await replay({ ...manifest, extra: token })).toMatchObject(invalid);
    expect(await replay({ ...manifest, marketRevisions: ["f".repeat(64)] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

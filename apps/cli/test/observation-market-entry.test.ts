import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTradingDateObservations, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI collects exact market days and replays breadth and rolling inputs after the provider stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-market-"));
  const token = "fixture-market-cli-token", selected = "2024-01-05", marketDay = "20240105";
  const previousDays = ["2023-12-28", "2023-12-29", "2024-01-02", "2024-01-03", "2024-01-04"];
  const symbol = "600000.SH";
  const universeFields = "trade_date,ts_code,name,industry,list_date".split(",");
  const barFields = "ts_code,trade_date,open,high,low,close,vol,amount,pre_close,change,pct_chg".split(",");
  const basicFields = "ts_code,trade_date,close,pe,pe_ttm,pb,total_mv,circ_mv,turnover_rate,turnover_rate_f,volume_ratio,total_share,float_share,free_share".split(",");
  const table = (fields: string[], items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });
  const requests: [string, string][] = [];
  let rosterMode: "denied" | "empty" | "available" = "denied", stopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { token: string; api_name: string; params: { trade_date: string } };
    expect(body.token).toBe(token);
    const day = body.params.trade_date;
    requests.push([body.api_name, day]);
    if (body.api_name === "bak_basic") {
      if (rosterMode === "denied") return new Response(token, { status: 403 });
      return table(universeFields, rosterMode === "empty" ? [] : [
        [day, symbol, "Up", "Industry", null], [day, "000001.SZ", "Down", null, null],
        [day, "000002.SZ", "Suspended", null, null], [day, "000003.SZ", "Missing", null, null],
      ]);
    }
    if (body.api_name === "daily") return table(barFields, [
      [symbol, day, 10, 11, 10, 10.3, day === marketDay ? 10 : 2, 1, 10, 0.3, 3],
      ["000001.SZ", day, 10, 10, 9.6, 9.7, day === marketDay ? 1 : 2, 0, 10, -0.3, -3],
      ["000002.SZ", day, 10, 10, 10, 10, 0, null, 10, 0, 0],
      ["300001.SZ", day, 10, 11, 10, 11, 500, 999, 10, 1, 10],
    ]);
    expect(body.api_name).toBe("daily_basic");
    return table(basicFields, [[symbol, day, 10.3, 2, null, 0.4, 120, 95, 7, null, 99, 12, 9.5, null]]);
  } });
  const runEntry = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: process.cwd(), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const run = (...args: string[]) => runEntry("observation", ...args);
  try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.preferences.source = "tushare";
    settings.env = { WHYJ_QUANT_TUSHARE_TOKEN: token, TUSHARE_BASE_URL: provider.url.origin };
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
    const help = await runEntry("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation collect-market|replay-market",
      description: "Collect a dated cross-section or replay fixed market breadth" });
    const collect = (date: string) => run("collect-market", "--date", date);
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await collect("2024-02-30")).toMatchObject(invalid);
    expect(await collect("2099-01-01")).toMatchObject(invalid);
    expect(requests).toEqual([]);
    expect(await collect(selected)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    rosterMode = "empty";
    expect(await collect(selected)).toMatchObject({ code: 0, output: { data: { status: "empty", ref: null, universe: { rowCount: 0 } } } });
    rosterMode = "available";
    const saved = await collect(selected);
    expect(saved).toMatchObject({ code: 0, output: { data: { tradeDate: selected, status: "archived", source: "tushare",
      ref: { kind: "market-cross-section", version: 1 }, counts: { universe: 4, bars: 4, basics: 1 } } } });
    const earlier: string[] = [];
    for (const day of previousDays) {
      const receipt = await collect(day);
      expect(receipt).toMatchObject({ code: 0, output: { data: { tradeDate: day, status: "archived" } } });
      earlier.push(receipt.output.data.ref.revision);
    }
    expect(requests).toEqual([
      ["bak_basic", marketDay], ["bak_basic", marketDay],
      ...[selected, ...previousDays].flatMap(day => ["bak_basic", "daily", "daily_basic"].map((endpoint): [string, string] =>
        [endpoint, day.replaceAll("-", "")])),
    ]);
    await provider.stop(true);
    stopped = true;

    const priceDates = [...previousDays.slice(1), selected];
    const priceRows: StoredTradingDateBarObservation[] = priceDates.map((tradeDate, i) => {
      const close = i === 4 ? 10.3 : 8 + i * 0.5;
      return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate,
        requested: { startDate: priceDates[0]!, endDate: selected }, market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
        source: "tickflow", endpoint: "/v1/klines", sourceTimestamp: Date.parse(tradeDate + "T00:00:00+08:00"),
        observedAt: "2024-01-06T00:00:00Z", interval: "1d", adjustment: "forward", coverage: "unknown", volumeUnit: "unknown", amountUnit: "unknown",
        values: { open: close, high: close, low: close, close, volume: 100, amount: null } };
    });
    const priorRoot = process.env.OHQUANT_DIR;
    process.env.OHQUANT_DIR = root;
    const price = await archiveTradingDateObservations(priceRows).finally(() => {
      if (priorRoot === undefined) delete process.env.OHQUANT_DIR;
      else process.env.OHQUANT_DIR = priorRoot;
    });
    const revision = saved.output.data.ref.revision;
    const replay = (...args: string[]) => run("replay-market", "--revision", revision, ...args);
    const single = await replay();
    expect(single).toMatchObject({ code: 0, output: { data: { archiveRef: saved.output.data.ref, producer: "whyj",
      formula: { id: "tsp_market_breadth", version: 1 }, input: { rollingInputs: "unavailable", bars: { outOfRoster: 1, matched: 3, coverage: "unknown" } },
      metrics: { coverage: { members: 4, observed: 3, missing: 1, eligible: 2, excludedBySuspensionRule: 1 },
        breadth: { strongUp: { count: 1, denominator: 2, fraction: 0.5 } }, amount: { total: 1000, average: 500, denominator: 2 },
        activity: { turnover: { average: 7, denominator: 1 }, volumeRatio: { average: null } }, trend: { aboveMa5: { fraction: null } } },
    } } });
    const flags = ["--price-revisions", price.revision, "--volume-revisions", earlier.join(",")];
    const full = await replay(...flags);
    expect(await replay(...flags)).toEqual(full);
    expect(full).toMatchObject({ code: 0, output: { data: { input: { rollingInputs: { prices: [{ archiveRef: price, comparison: "matched" }] } },
      metrics: { activity: { volumeRatio: { average: 2.75, denominator: 2 } }, trend: { aboveMa5: { count: 1, denominator: 1, fraction: 1 } } },
    } } });
    expect(full.output.data.input.rollingInputs.volumes.map((item: { tradeDate: string }) => item.tradeDate)).toEqual(previousDays);
    const priceFile = join(root, "price revisions.json");
    writeFileSync(priceFile, JSON.stringify([price.revision]));
    expect(await replay("--price-revisions-file", priceFile, "--volume-revisions", earlier.join(","))).toEqual(full);
    expect(await replay("--price-revisions-file", priceFile, "--price-revisions", price.revision)).toMatchObject(invalid);
    writeFileSync(priceFile, JSON.stringify([price.revision, price.revision]));
    expect(await replay("--price-revisions-file", priceFile)).toMatchObject(invalid);
    expect(await replay("--volume-revisions", `${earlier[0]},${earlier[0]}`)).toMatchObject(invalid);
    expect(await replay("--price-revisions", "../private")).toMatchObject(invalid);
    expect(await replay("--volume-revisions", earlier.toReversed().join(","))).toMatchObject({ code: 1,
      output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    expect(await replay("--price-revisions", "a".repeat(64))).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    expect(requests).toHaveLength(20);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

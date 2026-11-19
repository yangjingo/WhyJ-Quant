import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI captures exact Fuyao data and replays WhyJ auction metrics after both providers stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-auction-"));
  const tradeDate = "2025-01-03", previousTradeDate = "2025-01-02", nextTradeDate = "2025-01-06";
  const calendar = { revision: "fixture-calendar", tradeDate, previousTradeDate, nextTradeDate };
  const symbol = "600519.SH";
  const auctionKey = "fixture-auction", marketToken = "fixture-market";
  let stopped = false, deny = true;
  const auctionDates: (string | null)[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/a-share/auction/short-term-benchmark" && req.method === "GET") {
      const date = url.searchParams.get("date");
      auctionDates.push(date);
      if (deny || req.headers.get("X-api-key") !== auctionKey) return new Response(auctionKey, { status: 403 });
      return Response.json({ code: 0, data: {
        date, date_ms: Date.parse(`${date}T00:00:00+08:00`), timestamp: Date.parse(`${date}T09:26:00+08:00`),
        item: [{ thscode: symbol, ticker: "600519", name: "Fixture", auction_pct: 5, tags: ["高开"] }],
      } });
    }
    if (req.method !== "POST") return new Response(null, { status: 400 });
    const query = await req.json() as { api_name: string; token: string; params: { trade_date: string }; fields: string };
    if (query.token !== marketToken) return new Response(marketToken, { status: 403 });
    const day = query.params.trade_date;
    const fields = query.fields.split(",");
    const respond = (row?: Record<string, unknown>) => Response.json({
      code: 0, data: { fields, items: row ? [fields.map(field => row[field] ?? null)] : [] },
    });
    const identity = { ts_code: symbol, trade_date: day };
    if (query.api_name === "bak_basic") return respond({ ...identity, name: "Fixture" });
    if (query.api_name === "daily_basic") return respond();
    if (query.api_name === "daily") {
      const [open, close] = day === "20250102" ? [100, 100] : day === "20250103" ? [105, 110] : [120, 121];
      return respond({ ...identity, open, close, high: Math.max(open, close), low: Math.min(open, close), vol: 1, amount: 1 });
    }
    return new Response(null, { status: 400 });
  } });
  const providerOrigin = provider.url.origin;
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost", WHYJ_QUANT_FUYAO_API_KEY: stopped ? "" : auctionKey,
        FUYAO_BASE_URL: providerOrigin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(auctionKey);
    expect(stdout).not.toContain(marketToken);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
      env: { WHYJ_QUANT_TUSHARE_TOKEN: marketToken, TUSHARE_BASE_URL: providerOrigin },
    }));
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation collect-auction|replay-auction",
      description: "Capture a dated Fuyao watchlist or replay WhyJ auction metrics",
    });
    const capture = (date: string) => run("observation", "collect-auction", "--date", date);
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await capture("2025-02-30")).toMatchObject(invalid);
    expect(await capture(tradeDate)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    deny = false;
    const auction = await capture(tradeDate);
    expect(auction).toMatchObject({ code: 0, output: { ok: true, data: { tradeDate, source: "fuyao", rowCount: 1,
      ref: { version: 1, kind: "auction-benchmark" } } } });
    expect(auctionDates).toEqual([tradeDate, tradeDate]);
    const marketRevisions: string[] = [];
    for (const date of [previousTradeDate, tradeDate, nextTradeDate]) {
      const capture = await run("observation", "collect-market", "--date", date);
      expect(capture).toMatchObject({ code: 0, output: { ok: true, data: { tradeDate: date, ref: { kind: "market-cross-section" } } } });
      marketRevisions.push(capture.output.data.ref.revision);
    }
    await provider.stop(true);
    stopped = true;
    const manifest = join(root, "auction replay.json");
    const replay = () => run("observation", "replay-auction", "--manifest", manifest);
    const request = { auctionRevision: auction.output.data.ref.revision, calendar, marketRevisions };
    writeFileSync(manifest, JSON.stringify(request));
    const result = await replay();
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { auction: { source: "fuyao", tradeDate, rows: [{ symbol, auctionReturnPct: 5 }] } },
      metrics: { producer: "whyj", calendar, rows: [{ symbol, highOpenFlag: true }] },
    } } });
    const row = result.output.data.metrics.rows[0];
    expect(row.openToClose).toBeCloseTo(110 / 105 - 1, 12);
    expect(row.previousCloseToClose).toBeCloseTo(0.1, 12);
    expect(row.closeToNextClose).toBeCloseTo(0.1, 12);
    writeFileSync(manifest, JSON.stringify({ ...request, marketRevisions: [marketRevisions[0], marketRevisions[0]] }));
    expect(await replay()).toMatchObject(invalid);
    writeFileSync(manifest, JSON.stringify({ ...request, auctionRevision: "f".repeat(64) }));
    expect(await replay()).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } });
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

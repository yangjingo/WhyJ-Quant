import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, archiveTradingDateObservations, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI collects separate financial evidence and replays the complete fixed analytics offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-analytics-"));
  const symbol = "600000.SH", period = "2024-12-31", token = "fixture-financial-cli-token";
  const report = ["observation", "collect-financial-indicators", "--symbol", symbol, "--start", period, "--end", period];
  const disclosure = ["observation", "collect-disclosure-dates", "--symbol", symbol, "--period", period];
  const reportFields = ["ts_code", "end_date", "ann_date", "update_flag", "bps", "roe", "grossprofit_margin", "netprofit_margin",
    "or_yoy", "tr_yoy", "netprofit_yoy", "debt_to_assets"];
  const disclosureFields = ["ts_code", "end_date", "ann_date", "pre_date", "actual_date", "modify_date"];
  let reportMode: "denied" | "empty" | "available" = "denied";
  let calls = 0, stopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const body = await request.json() as { token: string; api_name: string; params: unknown };
    expect(body.token).toBe(token);
    if (body.api_name === "fina_indicator") {
      expect(body.params).toEqual({ ts_code: symbol, start_date: "20241231", end_date: "20241231" });
      if (reportMode === "denied") return new Response(token, { status: 403 });
      return Response.json({ code: 0, data: { fields: reportFields,
        items: reportMode === "empty" ? [] : [[symbol, "20241231", "20250428", "1", 6, 8, 0, null, 11, 14, -3, 62]] } });
    }
    expect(body.api_name).toBe("disclosure_date");
    expect(body.params).toEqual({ ts_code: symbol, end_date: "20241231" });
    return Response.json({ code: 0, data: { fields: disclosureFields,
      items: [[symbol, "20241231", "20250301", "20250425", "20250428", "20250425,20250428"]] } });
  } });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: process.cwd(), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.preferences.source = "tushare";
    settings.env = { WHYJ_QUANT_TUSHARE_TOKEN: token, TUSHARE_BASE_URL: provider.url.origin };
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-analytics",
      description: "Replay fixed daily research factors and chart levels" });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run("observation", "collect-financial-indicators", "--symbol", symbol, "--start", "2024-02-30", "--end", period)).toMatchObject(invalid);
    expect(await run("observation", "collect-disclosure-dates", "--symbol", "AAPL", "--period", period)).toMatchObject(invalid);
    expect(calls).toBe(0);

    expect(await run(...report)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    reportMode = "empty";
    expect(await run(...report)).toMatchObject({ code: 0, output: { data: { status: "empty", rowCount: 0, ref: { kind: "report-financial-indicators" } } } });
    reportMode = "available";
    const capturedReport = (await run(...report)).output.data;
    const capturedDisclosure = (await run(...disclosure)).output.data;
    expect(capturedReport).toMatchObject({ status: "archived", rowCount: 1, endpoint: "fina_indicator", source: "tushare" });
    expect(capturedDisclosure).toMatchObject({ status: "archived", rowCount: 1, endpoint: "disclosure_date", source: "tushare" });
    await provider.stop(true);
    stopped = true;

    const instant = Math.max(Date.parse(capturedReport.observedAt), Date.parse(capturedDisclosure.observedAt));
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
    // The fixture supplies a second synthetic session after both independently captured responses.
    const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const bar = (tradeDate: string): StoredTradingDateBarObservation => ({
      schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, requested: { startDate: tradeDate, endDate: tradeDate },
      market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tushare", endpoint: "daily",
      observedAt: `${tradeDate}T09:00:00Z`, interval: "1d", adjustment: "none", coverage: "unknown",
      volumeUnit: "hand", amountUnit: "CNY-thousand", sourceTimestamp: null,
      values: { open: 11.9, high: 12.2, low: 11.8, close: 12, volume: 100, amount: 120 },
    });
    const priorRoot = process.env.OHQUANT_DIR;
    process.env.OHQUANT_DIR = root;
    let early, eligible, turnover;
    try {
      early = await archiveTradingDateObservations([bar(day)]);
      eligible = await archiveTradingDateObservations([bar(next)]);
      const metadata = { tradeDate: next, observedAt: `${next}T10:00:00Z`, coverage: "unknown" } as const;
      turnover = await archiveMarketCrossSection({
        source: "tushare", market: "A", tradeDate: next,
        universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [] },
        bars: { ...metadata, endpoint: "daily", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", adjustment: "none", rows: [] },
        basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand",
          rows: [{ symbol, close: 12, turnoverPct: 2.5, freeFloatTurnoverPct: null, providerVolumeRatio: null, totalShares: null,
            floatShares: null, freeFloatShares: null, pe: null, peTtm: null, pb: null, totalMarketValue: null, circulatingMarketValue: null }] },
      });
    } finally {
      if (priorRoot === undefined) delete process.env.OHQUANT_DIR;
      else process.env.OHQUANT_DIR = priorRoot;
    }

    const evidence = ["--financial-report-revisions", capturedReport.ref.revision, "--financial-disclosure-revisions", capturedDisclosure.ref.revision];
    const replay = (revision: string, ...flags: string[]) => run("observation", "replay-analytics", "--revision", revision, ...flags);
    expect(await replay(early.revision, ...evidence)).toMatchObject({ code: 0, output: { data: {
      input: { financialInput: { status: "unavailable" } }, researchFactors: { values: { roe_latest: null } },
    } } });
    const flags = [...evidence, "--turnover-revisions", turnover.revision];
    const first = await replay(eligible.revision, ...flags);
    expect(await replay(eligible.revision, ...flags)).toEqual(first);
    expect(first).toMatchObject({ code: 0, output: { data: {
      input: { financialInput: { status: "available", reportEvidence: [{ ref: capturedReport.ref }],
        disclosureEvidence: [{ ref: capturedDisclosure.ref }] } },
      researchFactors: { producer: "whyj", asOf: next, values: { roe_latest: 8, gross_margin_latest: 0, net_margin_latest: null,
        revenue_yoy_latest: 11, net_income_yoy_latest: -3, debt_ratio_latest: 62, pb_latest: null, turnover_rate: 2.5 } },
    } } });
    expect(Object.keys(first.output.data.researchFactors.values)).toHaveLength(77);
    expect(Object.keys(first.output.data.priceLevels.levels)).toHaveLength(11);
    const confirmation = `${capturedReport.ref.revision},${period}`;
    expect(await replay(eligible.revision, ...flags, "--confirm-unadjusted-cny-book-value", confirmation)).toMatchObject({
      code: 0, output: { data: { researchFactors: { values: { pb_latest: 2 } } } },
    });
    expect(await replay(eligible.revision, "--confirm-unadjusted-cny-book-value", confirmation)).toMatchObject(invalid);
    expect(await replay(eligible.revision, "--financial-report-revisions", "../private")).toMatchObject(invalid);
    expect(await replay(eligible.revision, "--turnover-revisions", `${turnover.revision},${turnover.revision}`)).toMatchObject(invalid);
    expect(await replay(eligible.revision, "--financial-report-revisions", "a".repeat(64))).toMatchObject({ code: 1,
      output: { ok: false, error: { code: "observation_archive_unavailable" } } });
    expect(calls).toBe(4);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

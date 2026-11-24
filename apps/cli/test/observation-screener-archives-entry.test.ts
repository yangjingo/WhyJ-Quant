import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveFinancialObservations, archiveMarketCrossSection, archiveTradingDateObservations, loadMarketCrossSectionArchive,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";

test("CLI reconstructs scored daily candidates from exact local archive revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-screener-archives-cli-"));
  const manifest = join(root, "scope.json");
  const prior = process.env.OHQUANT_DIR;
  const symbol = "600001.SH", tradeDate = "2024-01-15", observedAt = "2024-01-16T03:00:00Z";
  const emptySymbol = "600002.SH";
  const sessions = ["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", tradeDate];
  const metadata = { tradeDate, observedAt, coverage: "unknown" } as const;
  const snapshot: StoredMarketCrossSection = {
    market: "A", source: "tushare", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "fixture", listedOn: null, industry: null },
        { symbol: emptySymbol, name: "missing observations", listedOn: null, industry: null }] },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol, open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: null,
        returnPct: null, changeCny: null, volume: 10, amount: 125 }] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  process.env.OHQUANT_DIR = root;
  try {
    const [marketRef, dailyRef] = await Promise.all([
      archiveMarketCrossSection(snapshot),
      archiveTradingDateObservations(sessions.map((date): StoredTradingDateBarObservation => ({
        schemaVersion: 2, kind: "trading_date_daily_bar", interval: "1d", symbol, tradeDate: date,
        market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
        sourceTimestamp: Date.parse(date + "T15:00:00+08:00"), requested: { startDate: sessions[0]!, endDate: tradeDate },
        observedAt, adjustment: "forward", volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
        values: { open: 10, high: 10, low: 10, close: 10, volume: date === tradeDate ? 300 : 100, amount: null },
      }))),
    ]);
    const input = {
      version: 1, marketRevision: marketRef.revision, adjustment: "forward",
      strategy: { id: "volume-surge", revision: "a".repeat(64) },
      histories: [{ symbol, dailyRevision: dailyRef.revision }],
      signalGate: { mode: "all", signals: ["signal_volume_surge"] },
      weights: [{ field: "amount", weight: 1 }],
    };
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command)).toEqual(expect.arrayContaining([
      "whyj --json observation replay-screener-archives", "whyj --json observation replay-screener-union",
      "whyj --json observation replay-list-rows",
    ]));
    const command = ["observation", "replay-screener-archives", "--manifest", manifest];
    const original = JSON.stringify(input);
    writeFileSync(manifest, original);
    const result = await run(...command);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      market: { ref: marketRef, tradeDate, source: "tushare" },
      candidateSymbols: [symbol], coverage: { matched: 1, unavailable: 0 },
      evaluated: [{ daily: { ref: dailyRef, source: "tickflow" }, status: "matched" }],
      ranking: { producer: "whyj", selected: [{ symbol, score: 50, position: 1 }] },
    } } });
    expect(await run(...command)).toEqual(result);
    expect(readFileSync(manifest, "utf8")).toBe(original);
    expect(await loadMarketCrossSectionArchive(marketRef)).toEqual(snapshot);

    writeFileSync(manifest, JSON.stringify({ ...input, version: 2 }));
    expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    writeFileSync(manifest, JSON.stringify({ ...input, adjustment: "none" }));
    expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });

    const { strategy, weights, signalGate, ...scope } = input;
    const union = { ...scope, strategies: [
      { strategy, weights: [], signalGate },
      { strategy: { id: "liquidity", revision: "b".repeat(64) }, weights },
    ] };
    const unionCommand = ["observation", "replay-screener-union", "--manifest", manifest];
    writeFileSync(manifest, JSON.stringify(union));
    expect(await run(...unionCommand)).toMatchObject({ code: 0, output: { ok: true, data: {
      market: { ref: marketRef, tradeDate },
      rows: [{ symbol, score: null, scoreStrategyId: strategy.id,
        hits: [{ strategyId: strategy.id, score: null }, { strategyId: "liquidity", score: 50 }] }],
      replays: [
        { evaluated: [{ daily: { ref: dailyRef } }], ranking: { strategy } },
        { ranking: { strategy: union.strategies[1]!.strategy } },
      ],
    } } });
    const first = union.strategies[0]!;
    for (const strategies of [[], [first, first], [{ ...first, displayLimit: 1 }],
      [{ ...first, strategy: { ...strategy, revision: "invalid" } }]]) {
      writeFileSync(manifest, JSON.stringify({ ...union, strategies }));
      expect(await run(...unionCommand)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    }
    writeFileSync(manifest, JSON.stringify({ ...union, marketRevision: "0".repeat(64) }));
    expect(await run(...unionCommand)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });

    const { histories, ...listScope } = scope;
    const list = { ...listScope, stocks: [{ symbol: emptySymbol }, ...histories] };
    const listCommand = ["observation", "replay-list-rows", "--manifest", manifest];
    writeFileSync(manifest, JSON.stringify(list));
    expect(await run(...listCommand)).toMatchObject({ code: 0, output: { ok: true, data: {
      marketRef, tradeDate, source: "tushare",
      observations: { daily: { volumeUnit: "hand", amountUnit: "CNY-thousand" } },
      rows: [{
        instrument: { symbol: emptySymbol },
        observations: { bar: null, basic: null },
        metrics: { daily: null, history: null, signals: null },
      }, {
        instrument: { symbol },
        observations: { bar: { close: 10, amount: 125 }, quantities: { volumeShares: 1_000, amountCny: 125_000 } },
        metrics: { daily: { producer: "whyj", date: tradeDate },
          history: { ref: dailyRef, source: "tickflow" },
          signals: { values: { signal_volume_surge: true } } },
      }],
    } } });

    const periodEnd = "2023-09-30", actualDisclosureDate = "2023-10-20";
    const provider = { symbol, coverage: "unknown", market: "A", source: "tushare" } as const;
    const financeObservedAt = "2023-10-21T02:00:00Z";
    const reportRef = await archiveFinancialObservations({
      ...provider, endpoint: "fina_indicator", observedAt: financeObservedAt,
      requested: { startPeriod: periodEnd, endPeriod: periodEnd }, rows: [{
        periodEnd, announcementDate: actualDisclosureDate, updateFlag: null,
        basicEarningsPerShare: 0, earningsPerShareCurrency: "unknown",
        bookValuePerShare: 10, bookValueCurrency: "unknown", roe: null, grossProfitMargin: null, netProfitMargin: null,
        operatingRevenueYoyPct: 10, totalOperatingRevenueYoyPct: null, parentNetProfitYoyPct: null,
        debtToAssets: 25, ratioUnit: "provider-native",
      }],
    });
    const disclosureRef = await archiveFinancialObservations({
      ...provider, endpoint: "disclosure_date", observedAt: financeObservedAt,
      requested: { periodEnd }, rows: [{
        periodEnd, actualDisclosureDate, planAnnouncementDate: null, plannedDisclosureDate: null, modificationRecord: null,
      }],
    });
    const financial = {
      symbol, financialReportRevisions: [reportRef.revision], financialDisclosureRevisions: [disclosureRef.revision],
    };
    writeFileSync(manifest, JSON.stringify({ ...list, stocks: [financial, { symbol: emptySymbol }] }));
    const replay = await run(...listCommand);
    expect(replay).toMatchObject({ code: 0, output: { ok: true, data: { rows: [{
      instrument: { symbol }, metrics: { history: null },
      observations: { financial: { status: "available", tradingDate: tradeDate, periodEnd, actualDisclosureDate,
        report: { basicEarningsPerShare: 0, earningsPerShareCurrency: "unknown", roe: null },
        reportEvidence: [{ ref: reportRef, observedAt: financeObservedAt }],
        disclosureEvidence: [{ ref: disclosureRef, observedAt: financeObservedAt }] } },
    }, { instrument: { symbol: emptySymbol } }] } } });
    expect(replay.output.data.rows[1].observations).not.toHaveProperty("financial");
    expect(await run("observation", "read-list-quotes", "--manifest", manifest)).toMatchObject({
      code: 0, output: { ok: true, data: { fixed: replay.output.data, quotes: { status: "outside-current-day" } } },
    });
    writeFileSync(manifest, JSON.stringify({ ...list, stocks: [{ ...financial, dailyRevision: dailyRef.revision }] }));
    expect(await run(...listCommand)).toMatchObject({ code: 0, output: { ok: true, data: { rows: [{
      metrics: { history: { ref: dailyRef } }, observations: { financial: { status: "available" } },
    }] } } });
    for (const stock of [
      { ...financial, financialReportRevisions: ["../private"] },
      { ...financial, financialDisclosureRevisions: [reportRef.revision] },
      { ...financial, financialReportRevisions: [reportRef.revision, reportRef.revision] },
      { ...financial, limitsRevision: "0".repeat(64) },
    ]) {
      writeFileSync(manifest, JSON.stringify({ ...list, stocks: [stock] }));
      expect(await run(...listCommand)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    }
    writeFileSync(manifest, JSON.stringify({ ...list, stocks: [{ ...financial, financialReportRevisions: ["0".repeat(64)] }] }));
    expect(await run(...listCommand)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });

    writeFileSync(manifest, JSON.stringify({ ...list, stocks: [{ symbol, limitsRevision: "0".repeat(64) }] }));
    expect(await run(...listCommand)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    for (const stocks of [[{ symbol }, { symbol }], [{ symbol: "600003.SH" }],
      [{ symbol, dailyRevision: "0".repeat(64) }]]) {
      writeFileSync(manifest, JSON.stringify({ ...list, stocks }));
      expect(await run(...listCommand)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    }
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

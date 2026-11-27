import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveDatedStockMinutes, archiveFinancialObservations, archiveMarketCrossSection, archiveTradingDateObservations,
  loadMarketCrossSectionArchive, loadPanelPortfolio, loadTradingDateArchive, savePanelPortfolio, saveSettings } from "../../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { ObservationListRowsRequest } from "../../../types/workbench.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

test("authenticated workbench reads bounded stock rows and exact archive evidence offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-list-rows-"));
  const previous = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  const symbol = "600000.SH", empty = "600001.SH", tradeDate = "2024-03-04";
  const observedAt = "2024-03-05T02:00:00Z";
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  const requested = { startDate: tradeDate, endDate: tradeDate };
  const providerCalls: string[] = [];
  const timestamp = Date.now();
  let failQuotes = false;
  let reported: { turnover_rate?: number; change_amount?: number; change_pct?: number; amplitude?: number } = {
    turnover_rate: 0.01, change_amount: -0.5, change_pct: -0.05, amplitude: 0.3,
  };
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    providerCalls.push(url.pathname + "?" + url.searchParams.get("symbols"));
    if (failQuotes) return new Response("fixture unavailable", { status: 403 });
    return Response.json({ data: [{ symbol, region: "CN", timestamp, last_price: 12, prev_close: 10,
      open: 10, high: 12, low: 9, volume: 0, amount: null, ext: reported }] });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-tickflow", TICKFLOW_BASE_URL: provider.url.origin } });
  const host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const [marketRef, ref, tradingLimitArchiveRef] = await Promise.all([
      archiveMarketCrossSection({
        market: "A", source: "tushare", tradeDate,
        universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
          members: [symbol, empty].map(code => ({ symbol: code, name: code, listedOn: null, industry: null })) },
        bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
          amountUnit: "CNY-thousand", rows: [
            { symbol, open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: 9.09, returnPct: 10,
              changeCny: 0.91, volume: 12, amount: 1.2 },
          ] },
        basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
          marketValueUnit: "CNY-ten-thousand", rows: [] },
      }),
      archiveTradingDateObservations([{
        ...meta, schemaVersion: 2, kind: "trading_date_daily_bar", symbol, market: "A", assetType: "stock",
        interval: "1d", calendarTimeZone: "Asia/Shanghai", source: "tushare", endpoint: "daily", sourceTimestamp: null,
        requested, adjustment: "none", volumeUnit: "hand", amountUnit: "CNY-thousand",
        values: { open: 10, high: 10, low: 10, close: 10, volume: 12, amount: 1.2 },
      }]),
      archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
        priceUnit: "CNY", coverage: "unknown", requested,
        rows: [{ tradeDate, previousClose: 9.09, limitUp: 10, limitDown: 8.18 }] }),
    ]);
    const baseUrl = host.server.url.origin;
    const { token } = await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string };
    const send = (arg: unknown, authenticated = true, method = "readObservationListRows") => fetch(baseUrl + "/api/workbench/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { "x-workbench-token": token } : {}) },
      body: JSON.stringify({ method, args: [arg] }),
    });
    const stock = { symbol, history: { ref, exchange: { tradingLimitArchiveRef } } };
    const request: ObservationListRowsRequest = { marketRef, adjustment: "none", stocks: [{ symbol: empty }, stock] };
    expect((await send(request, false)).status).toBe(401);
    const client = createHostClient({ baseUrl });
    const result = await client.readObservationListRows!(request);
    expect(result).toMatchObject({ marketRef, tradeDate, source: "tushare", rows: [
      { instrument: { symbol: empty }, observations: { bar: null, basic: null }, metrics: { daily: null, signals: null } },
      { instrument: { symbol }, observations: { bar: { returnPct: 10 }, quantities: { volumeShares: 1_200, amountCny: 1_200 } },
        metrics: { history: { ref }, daily: { producer: "whyj", date: tradeDate },
          signals: { producer: "whyj", values: { signal_limit_up: true },
            exchangeInputs: { raw: { ref }, limits: { ref: tradingLimitArchiveRef } } } } },
    ] });
    expect(await client.readObservationListRows!(request)).toEqual(result);
    expect(result.rows.every(row => !Object.hasOwn(row.observations, "financial"))).toBe(true);
    const siblingRef = await archiveTradingDateObservations((await loadTradingDateArchive(ref)).map(row => ({ ...row, symbol: empty })));
    const screener = {
      histories: [{ symbol: empty, ref: siblingRef }, { symbol, ref, exchange: { tradingLimitArchiveRef } }],
      strategies: [{ strategy: { id: "no-score", revision: "1".repeat(64) }, weights: [] },
        { strategy: { id: "amount", revision: "2".repeat(64) }, weights: [{ field: "amount", weight: 1 }],
          signalGate: { mode: "all" as const, signals: ["signal_limit_up"] } }],
    };
    const scoredRequest = { ...request, stocks: [{ symbol }], screener };
    expect((await send(scoredRequest, false)).status).toBe(401);
    const scored = await client.readObservationListRows!(scoredRequest);
    expect(scored.screener).toMatchObject({ scoped: 2, matched: 2, strategies: [
      { strategy: screener.strategies[0]!.strategy, formula: { id: "tsp_screener_score", version: 1 },
        candidateRevision: expect.stringMatching(/^[a-f0-9]{64}$/), coverage: { scoped: 2, matched: 2 } },
      { strategy: screener.strategies[1]!.strategy, fieldSources: { amount: { producer: "tushare", nativeUnit: "CNY-thousand" } } },
    ] });
    expect(scored.rows).toMatchObject([{ instrument: { symbol }, observations: { bar: { close: 10, amount: 1.2 } }, metrics: {
      screener: { producer: "whyj", position: 2, score: null, scoreStrategyId: "no-score",
        hits: [{ strategyId: "no-score", score: null }, { strategyId: "amount", score: 50 }],
        evaluations: [{ strategyId: "no-score", status: "matched" }, { strategyId: "amount", status: "matched" }],
      },
    } }]);
    expect(await client.readObservationListQuotes!(scoredRequest)).toEqual({ fixed: scored, quotes: { status: "outside-current-day" } });
    expect(result).not.toHaveProperty("screener");
    expect(result.rows.every(row => !Object.hasOwn(row.metrics, "screener"))).toBe(true);
    for (const [scope, status, code] of [
      [{ ...screener, histories: [screener.histories[0], screener.histories[0]] }, 400, "INPUT_INVALID"],
      [{ ...screener, strategies: [screener.strategies[0], screener.strategies[0]] }, 400, "INPUT_INVALID"],
      [{ ...screener, strategies: [{ ...screener.strategies[0], signalGate: { mode: "all", signals: ["invented"] } }] }, 400, "INPUT_INVALID"],
      [{ ...screener, histories: [{ symbol, ref: { ...ref, revision: "f".repeat(64) } }] }, 404, "OBSERVATION_ARCHIVE_UNAVAILABLE"],
      [{ ...screener, histories: [{ symbol: empty, ref }] }, 404, "OBSERVATION_ARCHIVE_UNAVAILABLE"],
    ] as const) {
      for (const method of ["readObservationListRows", "readObservationListQuotes"]) {
        const response = await send({ ...scoredRequest, screener: scope }, true, method);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
    }
    const saved = loadPanelPortfolio();
    saved.symbols = [{ code: "600000", name: "fixture", added: tradeDate }, { code: empty, name: "no history", added: "" }];
    savePanelPortfolio(saved);
    const watchlistHistoryRef = await archiveTradingDateObservations([{
      ...meta, schemaVersion: 2, kind: "trading_date_daily_bar", symbol, market: "A", assetType: "stock",
      interval: "1d", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
      sourceTimestamp: Date.parse(tradeDate + "T15:00:00+08:00"),
      requested, adjustment: "forward", volumeUnit: "unknown", amountUnit: "unknown",
      values: { open: 9, high: 9, low: 9, close: 9, volume: 0, amount: null },
    }]);
    const withWatchlist = { ...request, watchlistMembershipRevision: saved.revision!, stocks: [
      { symbol, watchlistHistoryRef }, { symbol: empty },
    ] };
    expect((await send(withWatchlist, false)).status).toBe(401);
    const watchlist = await client.readObservationListRows!(withWatchlist);
    expect(watchlist.rows[0]).toMatchObject({
      membership: { producer: "workspace", revision: saved.revision, code: "600000", addedAt: tradeDate },
      observations: { bar: { close: 10, returnPct: 10 } },
      metrics: { watchlistReturn: {
        producer: "whyj", formulaVersion: "tsp-watchlist-return-v1", pctSinceAdded: 0,
        baseline: { tradeDate, close: 9 }, latest: { tradeDate, close: 9 },
        history: { ref: watchlistHistoryRef, source: "tickflow", adjustment: "forward" },
      } },
    });
    expect(watchlist.rows[1]).toMatchObject({ membership: { code: empty, addedAt: null }, metrics: { watchlistReturn: null } });
    expect(await client.readObservationListQuotes!(withWatchlist)).toEqual({ fixed: watchlist, quotes: { status: "outside-current-day" } });
    expect(result.rows.every(row => !Object.hasOwn(row, "membership") && !Object.hasOwn(row.metrics, "watchlistReturn"))).toBe(true);
    for (const [input, status, code] of [
      [{ ...withWatchlist, watchlistMembershipRevision: "../private" }, 400, "INPUT_INVALID"],
      [{ ...withWatchlist, watchlistMembershipRevision: undefined }, 400, "INPUT_INVALID"],
      [{ ...withWatchlist, stocks: [{ symbol, watchlistHistoryRef: { ...watchlistHistoryRef, version: 1 } }] }, 400, "INPUT_INVALID"],
      [{ ...withWatchlist, watchlistMembershipRevision: "f".repeat(64) }, 404, "OBSERVATION_ARCHIVE_UNAVAILABLE"],
      [{ ...withWatchlist, stocks: [{ symbol: empty, watchlistHistoryRef }] }, 404, "OBSERVATION_ARCHIVE_UNAVAILABLE"],
    ] as const) {
      for (const method of ["readObservationListRows", "readObservationListQuotes"]) {
        const response = await send(input, true, method);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
    }
    const withCandles = { ...request, stocks: [{ ...stock, history: { ...stock.history, candleBars: 5 } }] };
    expect((await send(withCandles, false)).status).toBe(401);
    const candles = await client.readObservationListRows!(withCandles);
    expect(candles.rows[0]?.observations.dailyCandles).toMatchObject({
      ref, source: "tushare", endpoint: "daily", observedAt, requestedBars: 5, adjustment: "none",
      volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [{
        tradeDate, sourceTimestamp: null, open: 10, high: 10, low: 10, close: 10, volume: 12, amount: 1.2,
      }],
    });
    expect(await client.readObservationListQuotes!(withCandles)).toEqual({ fixed: candles, quotes: { status: "outside-current-day" } });
    expect(result.rows.every(row => !Object.hasOwn(row.observations, "dailyCandles"))).toBe(true);
    const sourceTimestamp = Date.parse(`${tradeDate}T09:31:00+08:00`);
    const bars = [{ sourceTimestamp, open: 9, high: 10, low: 9, close: 10, volume: 0, amount: null }];
    const minuteRef = await archiveDatedStockMinutes({
      source: "tickflow", endpoint: "/v1/klines", market: "A", symbol, assetType: "stock", ...meta,
      interval: "1m", adjustment: "none", priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native",
      timeZone: "Asia/Shanghai", timestampLabel: "provider-native", finality: "unknown", rows: bars,
    });
    const intraday = {
      ref: minuteRef,
      interpretation: { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "hand" },
    } as const;
    const withIntraday = { ...request, stocks: [{ symbol, intraday }] };
    expect((await send(withIntraday, false)).status).toBe(401);
    const minutes = await client.readObservationListRows!(withIntraday);
    expect(minutes.rows[0]?.observations).toMatchObject({ intraday: {
      ref: minuteRef, source: "tickflow", endpoint: "/v1/klines", timestampLabel: "provider-native",
      volumeUnit: "provider-native", rows: bars, interpretation: { ...intraday.interpretation, amountUnit: "unknown" }, previousClose: null,
    } });
    expect(minutes.rows[0]?.metrics).toMatchObject({ intraday: {
      producer: "whyj", formula: { id: "tsp_list_intraday", version: 1 }, tradeDate, latestReturnFraction: null,
      plotBaseline: { kind: "first-observed-open", value: 9 },
      points: [{ minute: "09:30", sourceTimestamp, close: 10, averageClose: 10, previousCloseReturnFraction: null }],
    } });
    expect(await client.readObservationListQuotes!(withIntraday)).toEqual({ fixed: minutes, quotes: { status: "outside-current-day" } });
    const withPreviousClose = await client.readObservationListRows!({ ...request, stocks: [{ symbol, intraday: {
      ...intraday, previousClose: { ref: tradingLimitArchiveRef, priceBasis: "caller-confirmed-same-basis" },
    } }] });
    expect(withPreviousClose.rows[0]?.observations).toMatchObject({ intraday: {
      previousClose: { archiveRef: tradingLimitArchiveRef, rows: [{ tradeDate, price: 9.09 }] },
    } });
    expect(withPreviousClose.rows[0]?.metrics).toMatchObject({ intraday: {
      latestReturnFraction: 10 / 9.09 - 1, plotBaseline: { kind: "previous-close", value: 9.09 },
    } });
    expect(result.rows.every(row => !Object.hasOwn(row.observations, "intraday") && !Object.hasOwn(row.metrics, "intraday"))).toBe(true);
    for (const [stocks, status, code] of [
      [[{ symbol, intraday: { ...intraday, interpretation: { ...intraday.interpretation, timestampLabel: "guess" } } }], 400, "INPUT_INVALID"],
      [[{ symbol, intraday: { ...intraday, ref: tradingLimitArchiveRef } }], 400, "INPUT_INVALID"],
      [[{ symbol, intraday: { ...intraday, previousClose: { ref: tradingLimitArchiveRef, priceBasis: "guess" } } }], 400, "INPUT_INVALID"],
      [[{ symbol, intraday: { ...intraday, ref: { ...minuteRef, revision: "f".repeat(64) } } }], 404, "OBSERVATION_ARCHIVE_UNAVAILABLE"],
      [[{ symbol: empty, intraday }], 404, "OBSERVATION_ARCHIVE_UNAVAILABLE"],
    ] as const) {
      for (const method of ["readObservationListRows", "readObservationListQuotes"]) {
        const response = await send({ ...request, stocks }, true, method);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
    }
    expect(result.limitCalendar).toBeUndefined();
    const limitCalendar = { revision: "fixture-list-sessions", sessions: [tradeDate] };
    const withExchange = { ...request, limitCalendar };
    expect((await send(withExchange, false)).status).toBe(401);
    const exchange = await client.readObservationListRows!(withExchange);
    const providerPrices = { ref: tradingLimitArchiveRef, symbol, source: "tushare", endpoint: "stk_limit", priceUnit: "CNY",
      observedAt, row: { tradeDate, previousClose: 9.09, limitUp: 10, limitDown: 8.18 } };
    expect(exchange.limitCalendar).toEqual({ ...limitCalendar, zone: "Asia/Shanghai" });
    expect(exchange.rows[1]?.observations.tradingLimits).toMatchObject(providerPrices);
    expect(exchange.rows[1]?.metrics.limitStreaks).toMatchObject({ producer: "whyj", formula: { id: "tsp_limit_streaks", version: 1 },
      consecutiveLimitUps: null, consecutiveLimitDowns: 0 });
    const sourceOnly = await client.readObservationListRows!({ ...withExchange, stocks: [{ symbol, tradingLimitsRef: tradingLimitArchiveRef }] });
    expect(sourceOnly.rows[0]?.observations.tradingLimits).toMatchObject(providerPrices);
    expect(sourceOnly.rows[0]?.metrics.limitStreaks).toMatchObject({ consecutiveLimitUps: null, consecutiveLimitDowns: null });
    const periodEnd = "2023-12-31", actualDisclosureDate = "2024-02-26";
    const capturedAt = "2024-03-01T02:00:00Z";
    const financeScope = { symbol, source: "tushare", market: "A", coverage: "unknown", observedAt: capturedAt } as const;
    const reportRef = await archiveFinancialObservations({
      ...financeScope, endpoint: "fina_indicator", requested: { startPeriod: periodEnd, endPeriod: periodEnd }, rows: [{
        periodEnd, announcementDate: actualDisclosureDate, updateFlag: null,
        basicEarningsPerShare: 0, earningsPerShareCurrency: "unknown", bookValuePerShare: 12, bookValueCurrency: "unknown",
        roe: -2, grossProfitMargin: null, netProfitMargin: null, operatingRevenueYoyPct: null,
        totalOperatingRevenueYoyPct: null, parentNetProfitYoyPct: null, debtToAssets: 42, ratioUnit: "provider-native",
      }],
    });
    const disclosureRef = await archiveFinancialObservations({
      ...financeScope, endpoint: "disclosure_date", requested: { periodEnd }, rows: [{
        periodEnd, actualDisclosureDate, plannedDisclosureDate: null, planAnnouncementDate: null, modificationRecord: null,
      }],
    });
    const financialArchives = [reportRef, disclosureRef];
    const withFinance = { ...request, stocks: [{ symbol: empty }, { ...stock, financialArchives }] };
    expect((await send(withFinance, false)).status).toBe(401);
    const financial = await client.readObservationListRows!(withFinance);
    expect(financial.rows[1]!.observations.financial).toMatchObject({
      tradingDate: tradeDate, status: "available", periodEnd, actualDisclosureDate,
      report: { basicEarningsPerShare: 0, roe: -2, ratioUnit: "provider-native" },
      reportEvidence: [{ ref: reportRef, observedAt: capturedAt }],
      disclosureEvidence: [{ ref: disclosureRef, observedAt: capturedAt }],
    });
    expect(financial.rows[0]).toEqual(result.rows[0]);
    expect(await client.readObservationListQuotes!(withFinance)).toEqual({
      fixed: financial, quotes: { status: "outside-current-day" },
    });
    for (const invalid of [
      { ...request, marketRef: { ...marketRef, revision: "../private" } },
      { ...request, stocks: [{ symbol, history: { candleBars: 5 } }] },
      { ...request, stocks: [{ symbol, history: { ref, candleBars: 61 } }] },
      { ...request, stocks: [stock, stock] },
      { ...request, stocks: Array.from({ length: 101 }, (_, i) => ({ symbol: `600${String(i).padStart(3, "0")}.SH` })) },
      { ...request, stocks: [{ ...stock, history: { ref, exchange: { rawArchiveRef: ref } } }] },
      { ...request, stocks: [{ symbol, financialArchives: [{ ...reportRef, revision: "../private" }] }] },
      { ...request, stocks: [{ symbol, financialArchives: [tradingLimitArchiveRef] }] },
      { ...request, stocks: [{ symbol, financialArchives: [reportRef, reportRef] }] },
      { ...withExchange, limitCalendar: { ...limitCalendar, sessions: [tradeDate, tradeDate] } },
      { ...withExchange, limitCalendar: { ...limitCalendar, inferred: true } },
      { ...withExchange, stocks: [{ ...stock, tradingLimitsRef: tradingLimitArchiveRef }] },
      { ...withExchange, stocks: [{ symbol, tradingLimitsRef: { ...tradingLimitArchiveRef, revision: "../private" } }] },
    ]) {
      const response = await send(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INPUT_INVALID" } });
    }
    const missing = { ...request, marketRef: { ...marketRef, revision: "f".repeat(64) } };
    const unavailable = await send(missing);
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({ error: { code: "OBSERVATION_ARCHIVE_UNAVAILABLE" } });
    await expect(client.readObservationListRows!(missing)).rejects.toMatchObject({ code: "OBSERVATION_ARCHIVE_UNAVAILABLE" });
    await expect(client.readObservationListRows!({
      ...request, stocks: [{ symbol, financialArchives: [{ ...reportRef, revision: "f".repeat(64) }] }],
    })).rejects.toMatchObject({ code: "OBSERVATION_ARCHIVE_UNAVAILABLE" });
    await expect(client.readObservationListRows!({
      ...request, stocks: [{ symbol: empty, financialArchives }],
    })).rejects.toMatchObject({ code: "OBSERVATION_ARCHIVE_UNAVAILABLE" });
    await expect(client.readObservationListRows!({
      ...withExchange, stocks: [{ symbol: empty, tradingLimitsRef: tradingLimitArchiveRef }],
    })).rejects.toMatchObject({ code: "OBSERVATION_ARCHIVE_UNAVAILABLE" });
    await expect(client.readObservationListRows!({
      ...withExchange, stocks: [{ symbol, tradingLimitsRef: { ...tradingLimitArchiveRef, revision: "f".repeat(64) } }],
    })).rejects.toMatchObject({ code: "OBSERVATION_ARCHIVE_UNAVAILABLE" });
    await expect(client.readObservationListRows!({ ...request, stocks: [stock, stock] })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(providerCalls).toEqual([]);

    const market = await loadMarketCrossSectionArchive(marketRef);
    const current = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(timestamp);
    const currentFields = { tradeDate: current, observedAt: new Date().toISOString() };
    const currentRef = await archiveMarketCrossSection({
      ...market, tradeDate: current,
      universe: { ...market.universe, ...currentFields }, bars: { ...market.bars, ...currentFields },
      basics: { ...market.basics, ...currentFields },
    });
    const currentLimitRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit",
      observedAt: currentFields.observedAt, priceUnit: "CNY", coverage: "unknown", requested: { startDate: current, endDate: current },
      rows: [{ tradeDate: current, previousClose: 10, limitUp: 11, limitDown: 9 }],
    });
    const requestNow = { ...request, marketRef: currentRef, limitCalendar: { ...limitCalendar, sessions: [current] },
      stocks: [{ symbol: empty }, { symbol, financialArchives, tradingLimitsRef: currentLimitRef }] };
    expect((await send(requestNow, false, "readObservationListQuotes")).status).toBe(401);
    await expect(client.readObservationListQuotes!({ ...requestNow, stocks: [{ symbol }, { symbol }] }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(await client.readObservationListQuotes!(request)).toEqual({ fixed: result, quotes: { status: "outside-current-day" } });
    const fixedNow = await client.readObservationListRows!(requestNow);
    expect(fixedNow.rows[1]!.observations.financial).toMatchObject({ status: "available", tradingDate: current });
    expect(fixedNow.rows[1]!.observations.tradingLimits).toMatchObject({ ref: currentLimitRef, row: { tradeDate: current, limitUp: 11, limitDown: 9 } });
    expect(providerCalls).toEqual([]);
    const quoteResponse = await client.readObservationListQuotes!(requestNow);
    expect(quoteResponse.fixed).toEqual(fixedNow);
    expect(quoteResponse.quotes).toMatchObject({
      status: "observed", source: "tickflow", endpoint: "/v1/quotes", units: "unknown", rows: [
        { symbol: empty, status: "missing" },
        { symbol, status: "available", sourceTimestamp: timestamp,
          snapshot: { lastPrice: 12, volume: 0, reportedTurnoverFraction: 0.01,
            reportedChangeAmount: -0.5, reportedChangeFraction: -0.05, reportedAmplitudeFraction: 0.3 },
          change: { producer: "whyj", changeAmount: 2, changeFraction: 0.2 } },
      ],
    });
    expect(providerCalls).toEqual(["/v1/quotes?" + empty + "," + symbol]);
    for (const expected of [0, undefined]) {
      reported = { turnover_rate: expected, change_amount: expected, change_pct: expected, amplitude: expected };
      const { quotes } = await client.readObservationListQuotes!(requestNow);
      const quotedRow = quotes.status === "observed" ? quotes.rows.find(row => row.symbol === symbol) : undefined;
      if (quotedRow?.status !== "available") throw new Error("Expected an available quote");
      for (const field of ["reportedTurnoverFraction", "reportedChangeAmount", "reportedChangeFraction", "reportedAmplitudeFraction"] as const) {
        expect(quotedRow.snapshot[field]).toBe(expected);
        expect(Object.hasOwn(quotedRow.snapshot, field)).toBe(expected !== undefined);
      }
      expect(quotedRow.change).toEqual({ producer: "whyj", changeAmount: 2, changeFraction: 0.2 });
    }
    failQuotes = true;
    expect(await client.readObservationListQuotes!(requestNow)).toEqual({ fixed: fixedNow, quotes: { status: "unavailable" } });
    expect(providerCalls).toHaveLength(4);
  } finally {
    await host.close();
    await provider.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

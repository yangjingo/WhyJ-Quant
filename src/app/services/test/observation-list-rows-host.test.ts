import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveFinancialObservations, archiveMarketCrossSection, archiveTradingDateObservations,
  loadMarketCrossSectionArchive, saveSettings } from "../../../storage/index.ts";
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

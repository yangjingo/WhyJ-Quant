import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFinancialObservations, archiveMarketCrossSection, archiveTradingDateObservations, loadPanelPortfolio, savePanelPortfolio,
  type StoredMarketCrossSection, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspListLiquidity } from "../data/list-liquidity.ts";
import { replayTspListRows, replayTspListRowsWithLiveQuotes } from "../data/list-rows.ts";
import { replayTspWatchlistReturn } from "../data/watchlist-return.ts";

test("replays one dated stock with distinct Tushare and WhyJ evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-liquidity-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const symbol = "600519.SH", tradeDate = "2024-03-04";
  const metadata = { tradeDate, observedAt: "2024-03-05T03:00:00Z", coverage: "unknown" } as const;
  const snapshot: StoredMarketCrossSection = {
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [
      { symbol: "600000.SH", name: "no observations", industry: null, listedOn: null },
      { symbol, name: "fixture", industry: null, listedOn: null },
    ] },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
      amountUnit: "CNY-thousand", rows: [
        { symbol, open: 10, high: 11, low: 10, close: 10.5, exRightsPreviousClose: 10,
          changeCny: 0.5, returnPct: 5, volume: 750, amount: 125 },
      ] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [
        { symbol, close: 10.4, turnoverPct: 4, freeFloatTurnoverPct: 7, providerVolumeRatio: null,
          totalShares: 400, floatShares: 250, freeFloatShares: 100, pe: null, peTtm: 18, pb: 2,
          totalMarketValue: null, circulatingMarketValue: 2_600 },
      ] },
  };
  const priorDay = "2024-03-01";
  function history(dates: string[], adjustment: "none" | "forward" = "forward") {
    return archiveTradingDateObservations(dates.map((day, index): StoredTradingDateBarObservation => {
      const close = 8 + index;
      return {
        schemaVersion: 2, kind: "trading_date_daily_bar", interval: "1d", symbol, tradeDate: day,
        market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
        sourceTimestamp: Date.parse(day + "T15:00:00+08:00"), requested: { startDate: dates[0]!, endDate: dates.at(-1)! },
        observedAt: metadata.observedAt, adjustment, volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
        values: { open: close, high: close, low: close, close, volume: 100, amount: null },
      };
    }));
  }
  try {
    const ref = await archiveMarketCrossSection(snapshot);
    expect(await replayTspListLiquidity(ref, symbol)).toMatchObject({
      archiveRef: ref, symbol, tradeDate, market: "A",
      observations: {
        producer: "tushare",
        daily: { endpoint: "daily", adjustment: "none", volumeUnit: "hand", row: { close: 10.5, volume: 750 } },
        dailyBasic: { endpoint: "daily_basic", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand",
          row: { close: 10.4, turnoverPct: 4, circulatingMarketValue: 2_600 } },
      },
      metrics: { producer: "whyj", formula: { id: "tsp_list_liquidity", version: 1 },
        floatValueCny: 26_250_000, turnoverPct: 3 },
    });
    expect(await replayTspListLiquidity(ref, "600000.SH")).toMatchObject({
      observations: { daily: { row: null }, dailyBasic: { row: null } },
      metrics: { floatValueCny: null, turnoverPct: null },
    });
    snapshot.bars.rows[0]!.volume = 0;
    const corrected = await archiveMarketCrossSection(snapshot);
    expect((await replayTspListLiquidity(corrected, symbol)).metrics.turnoverPct).toBe(0);
    expect((await replayTspListLiquidity(ref, symbol)).metrics.turnoverPct).toBe(3);
    await expect(replayTspListLiquidity(ref, "600001.SH")).rejects.toThrow("absent from the archived roster");
    await expect(replayTspListLiquidity({ ...ref, revision: "invalid" }, symbol)).rejects.toThrow();
    await expect(replayTspListLiquidity(ref, symbol, AbortSignal.abort())).rejects.toThrow();

    const [dailyRef, staleRef, futureRef] = await Promise.all([
      history([priorDay, tradeDate]), history([priorDay]), history([priorDay, tradeDate, "2024-03-05"]),
    ]);
    const listRequest = { marketRef: ref, adjustment: "forward" as const, stocks: [
      { symbol, history: { ref: dailyRef } }, { symbol: "600000.SH" },
    ] };
    const result = await replayTspListRows(listRequest);
    expect(result).toMatchObject({
      marketRef: ref, tradeDate, source: "tushare", adjustment: "forward",
      observations: { roster: { endpoint: "bak_basic" }, daily: { endpoint: "daily", volumeUnit: "hand", amountUnit: "CNY-thousand" },
        dailyBasic: { endpoint: "daily_basic", observedAt: metadata.observedAt } },
      rows: [{
        instrument: { symbol, name: "fixture" },
        observations: {
          bar: { close: 10.5, exRightsPreviousClose: 10, returnPct: 5, changeCny: 0.5 },
          basic: { peTtm: 18, pb: 2, turnoverPct: 4 },
          quantities: { volumeShares: 75_000, amountCny: 125_000 },
        },
        metrics: {
          liquidity: { producer: "whyj", turnoverPct: 3, floatValueCny: 26_250_000 },
          history: { ref: dailyRef, source: "tickflow", adjustment: "forward" },
          daily: { producer: "whyj", date: tradeDate, values: { prev_close: 8, change_pct: 0.125, change_amount: 1 } },
          signals: { producer: "whyj", date: tradeDate, exchangeInputs: null },
        },
      }, {
        instrument: { symbol: "600000.SH" },
        observations: { bar: null, basic: null, quantities: { volumeShares: null, amountCny: null } },
        metrics: { daily: null, signals: null, history: null },
      }],
    });
    expect(await replayTspListRows(listRequest)).toEqual(result);

    const addedAt = "2024-03-01T17:00:00Z";
    const portfolio = loadPanelPortfolio();
    portfolio.symbols = [{ code: "600519", name: "fixture", added: addedAt },
      { code: "600000.SH", name: "no observations", added: tradeDate }];
    savePanelPortfolio(portfolio);
    const membershipRevision = portfolio.revision!;
    const withWatchlist = { ...listRequest, watchlistMembershipRevision: membershipRevision, stocks: [
      { ...listRequest.stocks[0]!, watchlistHistoryRef: dailyRef }, listRequest.stocks[1]!,
    ] };
    const standalone = await replayTspWatchlistReturn({ ref: dailyRef, asOf: tradeDate, membershipRevision });
    const watchlist = await replayTspListRows(withWatchlist);
    expect(watchlist.rows[0]?.membership).toEqual({ producer: "workspace", revision: membershipRevision, code: "600519", addedAt });
    expect(watchlist.rows[0]?.metrics.watchlistReturn).toEqual({ ...standalone.metrics, history: standalone.input.history });
    expect(watchlist.rows[0]?.metrics.watchlistReturn).toMatchObject({
      addedDate: "2024-03-02", pctSinceAdded: 0.125,
      baseline: { tradeDate: priorDay, close: 8 }, latest: { tradeDate, close: 9 },
    });
    expect(watchlist.rows[0]?.observations).toEqual(result.rows[0]?.observations);
    expect(watchlist.rows[1]?.membership).toMatchObject({ code: "600000.SH", addedAt: tradeDate });
    expect(watchlist.rows[1]?.metrics.watchlistReturn).toBeNull();
    expect(await replayTspListRowsWithLiveQuotes(withWatchlist)).toEqual({ fixed: watchlist, quotes: { status: "outside-current-day" } });
    expect(await replayTspListRows(listRequest)).toEqual(result);
    const onlyReturn = { ...withWatchlist, adjustment: "none" as const, stocks: [{ symbol, watchlistHistoryRef: dailyRef }] };
    expect((await replayTspListRows(onlyReturn)).rows[0]?.metrics.watchlistReturn).toEqual(watchlist.rows[0]?.metrics.watchlistReturn);
    const shortHistory = await history([tradeDate]);
    const unadjusted = await history([priorDay, tradeDate], "none");
    const withReturnRef = (watchlistHistoryRef: typeof dailyRef) => ({ ...onlyReturn, stocks: [{ symbol, watchlistHistoryRef }] });
    expect((await replayTspListRows(withReturnRef(futureRef))).rows[0]?.metrics.watchlistReturn)
      .toMatchObject({ latest: { tradeDate, close: 9 }, pctSinceAdded: 0.125 });
    expect((await replayTspListRows(withReturnRef(shortHistory))).rows[0]?.metrics.watchlistReturn)
      .toMatchObject({ status: "missing-baseline", pctSinceAdded: null });
    await expect(replayTspListRows(withReturnRef(staleRef))).rejects.toThrow("covering the requested cutoff");
    await expect(replayTspListRows(withReturnRef(unadjusted))).rejects.toThrow("forward-adjusted");
    await expect(replayTspListRows({ ...onlyReturn, stocks: [{ symbol: "600000.SH", watchlistHistoryRef: dailyRef }] }))
      .rejects.toThrow("does not match");
    await expect(replayTspListRows({ ...onlyReturn, watchlistMembershipRevision: undefined })).rejects.toThrow("membership revision");
    portfolio.symbols = [{ code: symbol, name: "fixture", added: tradeDate }];
    savePanelPortfolio(portfolio);
    await expect(replayTspListRows(onlyReturn)).rejects.toThrow("revision changed");
    expect((await replayTspListRows({ ...onlyReturn, watchlistMembershipRevision: portfolio.revision })).rows[0]?.metrics.watchlistReturn)
      .toMatchObject({ status: "available", pctSinceAdded: 0 });
    await expect(replayTspListRows({ ...withWatchlist, watchlistMembershipRevision: portfolio.revision })).rejects.toThrow("absent");

    expect(result.rows.every(row => !Object.hasOwn(row.observations, "financial"))).toBe(true);

    const periodEnd = "2023-12-31";
    const actualDisclosureDate = "2024-02-26";
    const reportObservedAt = "2024-03-01T02:00:00Z";
    const reportRow = {
      periodEnd, announcementDate: actualDisclosureDate, updateFlag: null,
      bookValuePerShare: 8, bookValueCurrency: "unknown", roe: 0, grossProfitMargin: 44,
      netProfitMargin: null, operatingRevenueYoyPct: 2, totalOperatingRevenueYoyPct: 3, parentNetProfitYoyPct: -4,
      debtToAssets: 32, ratioUnit: "provider-native",
    } as const;
    const reportBatch = {
      market: "A", source: "tushare", symbol, coverage: "unknown", endpoint: "fina_indicator",
      observedAt: reportObservedAt, requested: { startPeriod: periodEnd, endPeriod: periodEnd },
      rows: [{ ...reportRow, basicEarningsPerShare: -0.5, earningsPerShareCurrency: "unknown" }],
    } as const;
    const reportRef = await archiveFinancialObservations({ ...reportBatch, rows: [...reportBatch.rows] });
    const legacyReportRef = await archiveFinancialObservations({ ...reportBatch, rows: [reportRow] });
    const sameDayReportRef = await archiveFinancialObservations({
      ...reportBatch, observedAt: "2024-03-03T17:00:00Z", rows: [{ ...reportBatch.rows[0], basicEarningsPerShare: 7 }],
    });
    const otherReportRef = await archiveFinancialObservations({
      ...reportBatch, symbol: "600000.SH", rows: [...reportBatch.rows],
    });
    const disclosureObservedAt = "2024-03-01T02:30:00Z";
    const disclosureRef = await archiveFinancialObservations({
      market: "A", source: "tushare", symbol, coverage: "unknown", endpoint: "disclosure_date",
      observedAt: disclosureObservedAt, requested: { periodEnd }, rows: [{
        periodEnd, actualDisclosureDate, planAnnouncementDate: null, plannedDisclosureDate: null, modificationRecord: null,
      }],
    });
    const financialArchives = [sameDayReportRef, disclosureRef, reportRef];
    const financialRequest = { ...listRequest, stocks: [{ ...listRequest.stocks[0]!, financialArchives }, listRequest.stocks[1]!] };
    const withFinance = await replayTspListRows(financialRequest);
    expect(withFinance.rows[0]!.observations.financial).toEqual({
      status: "available", tradingDate: tradeDate, periodEnd, actualDisclosureDate, report: reportBatch.rows[0],
      reportEvidence: [{ ref: reportRef, observedAt: reportObservedAt }],
      disclosureEvidence: [{ ref: disclosureRef, observedAt: disclosureObservedAt }],
    });
    expect(withFinance.rows[0]!.observations.basic).toEqual(result.rows[0]!.observations.basic);
    expect(withFinance.rows[0]!.metrics).toEqual(result.rows[0]!.metrics);
    expect(withFinance.rows[1]).toEqual(result.rows[1]);
    expect(await replayTspListRows(financialRequest)).toEqual(withFinance);
    const oneStock = (...references: typeof financialArchives) => replayTspListRows({
      ...listRequest, stocks: [{ symbol, financialArchives: references }],
    });
    expect((await oneStock(legacyReportRef, disclosureRef)).rows[0]!.observations.financial)
      .toMatchObject({ status: "available", report: reportRow });
    expect((await oneStock(reportRef)).rows[0]!.observations.financial).toEqual({
      tradingDate: tradeDate, status: "unavailable", reason: "missing-disclosure",
    });
    expect((await oneStock(sameDayReportRef, disclosureRef)).rows[0]!.observations.financial).toEqual({
      tradingDate: tradeDate, status: "unavailable", reason: "missing-report",
    });
    await expect(oneStock(otherReportRef)).rejects.toThrow("archive symbol does not match");
    await expect(oneStock(reportRef, reportRef)).rejects.toThrow("Duplicate financial research archive revision");

    const stale = await replayTspListRows({ ...listRequest, stocks: [{ symbol, history: { ref: staleRef } }] });
    expect(stale.rows[0]).toMatchObject({ metrics: { daily: null, signals: null, history: { lastTradeDate: priorDay } } });
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol }, { symbol }] })).rejects.toThrow("Duplicate");
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol: "600001.SH" }] })).rejects.toThrow("absent");
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol: "600000.SH", history: { ref: dailyRef } }] }))
      .rejects.toThrow("mismatched symbol");
    await expect(replayTspListRows({ ...listRequest, stocks: [{ symbol, history: { ref: futureRef } }] }))
      .rejects.toThrow("future trade date");
    await expect(replayTspListRows({ ...listRequest, adjustment: "none" })).rejects.toThrow("price basis");
    await expect(replayTspListRows(listRequest, AbortSignal.abort())).rejects.toThrow();
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveTspArchiveAnalytics } from "../../../runtime/data/archive-analytics.ts";
import { archiveFinancialObservations, archiveMarketCrossSection, archiveTradingDateObservations,
  saveSettings, type StoredTradingDateBarObservation } from "../../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

test("authenticated research analytics replay all archived fields after Host restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-archive-analytics-"));
  const before = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const dates = Array.from({ length: 65 }, (_, index) => new Date(Date.UTC(2024, 0, 2 + index)).toISOString().slice(0, 10));
  const first = dates[0]!, asOf = dates.at(-1)!;
  const rows: StoredTradingDateBarObservation[] = dates.map((tradeDate, index) => {
    const close = 10 + index / 10;
    return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol: "600000.SH", tradeDate,
      sourceTimestamp: null, requested: { startDate: first, endDate: asOf },
      market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tushare", endpoint: "daily",
      observedAt: "2024-04-01T00:00:00Z", interval: "1d", adjustment: "none", coverage: "unknown",
      volumeUnit: "hand", amountUnit: "CNY-thousand",
      values: { open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, amount: 200 },
    };
  });
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  const secret = "fixture-archive-credential";
  let calls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    return new Response(secret, { status: 403 });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: secret, TUSHARE_BASE_URL: provider.url.origin } });
  let host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const ref = await archiveTradingDateObservations(rows);
    const connect = async () => {
      const baseUrl = host.server.url.origin;
      const token = (await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string }).token;
      return {
        client: createHostClient({ baseUrl }),
        send: (arg: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", { method: "POST",
          headers: { "Content-Type": "application/json", ...(authenticated ? { "x-workbench-token": token } : {}) },
          body: JSON.stringify({ method: "readObservationAnalytics", args: [arg] }) }),
      };
    };
    const initial = await connect();
    expect((await initial.send(ref, false)).status).toBe(401);
    const result = await initial.client.readObservationAnalytics!(ref);
    expect(result.archiveRef).toEqual(ref);
    expect(result.input).toMatchObject({ source: "tushare", endpoint: "daily", amountUnit: "CNY-thousand",
      usableCnyAmounts: 65, adjustment: "none", firstTradeDate: first, lastTradeDate: asOf });
    expect(result.researchFactors.asOf).toBe(asOf);
    expect(result.researchFactors.producer).toBe("whyj");
    expect(result.researchFactors.formula.id).toBe("tsp_research_factors");
    expect(Object.keys(result.researchFactors.values)).toHaveLength(77);
    expect(result.researchFactors.values.log_amount).toBeCloseTo(Math.log1p(200_000));
    expect(result.researchFactors.values.roe_latest).toBeNull();
    expect(result.priceLevels.asOf).toBe(asOf);
    expect(result.priceLevels.formula.id).toBe("tsp_price_levels");
    expect(result.priceLevels.volumeProfileBasis).toBe("volume-only");
    expect(Object.keys(result.priceLevels.levels)).toHaveLength(11);
    expect(result.priceLevels.levels.pivot?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(secret);

    const periodEnd = "2023-12-31", actualDisclosureDate = "2024-02-26", capturedAt = "2024-03-01T02:00:00Z";
    const symbol = rows[0]!.symbol;
    const finance = { market: "A", source: "tushare", symbol, coverage: "unknown", observedAt: capturedAt } as const;
    const report = {
      ...finance, endpoint: "fina_indicator", requested: { startPeriod: periodEnd, endPeriod: periodEnd }, rows: [{
        periodEnd, announcementDate: actualDisclosureDate, updateFlag: null,
        bookValuePerShare: 8.2, bookValueCurrency: "unknown", roe: -2, grossProfitMargin: 0, netProfitMargin: null,
        operatingRevenueYoyPct: 12, totalOperatingRevenueYoyPct: null, parentNetProfitYoyPct: null, debtToAssets: 40,
        ratioUnit: "provider-native",
      }],
    } as const;
    const reportRef = await archiveFinancialObservations({ ...report, rows: [...report.rows] });
    const disclosureRef = await archiveFinancialObservations({
      ...finance, endpoint: "disclosure_date", requested: { periodEnd }, rows: [{
        periodEnd, actualDisclosureDate, planAnnouncementDate: null, plannedDisclosureDate: null, modificationRecord: null,
      }],
    });
    const marketMeta = { tradeDate: asOf, observedAt: "2024-04-01T00:00:00Z", coverage: "unknown" } as const;
    const turnoverRef = await archiveMarketCrossSection({
      market: "A", source: "tushare", tradeDate: asOf,
      universe: { ...marketMeta, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [] },
      bars: { ...marketMeta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
        amountUnit: "CNY-thousand", rows: [] },
      basics: { ...marketMeta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
        marketValueUnit: "CNY-ten-thousand", rows: [{
          symbol, close: rows.at(-1)!.values.close, turnoverPct: 2.5, freeFloatTurnoverPct: null, providerVolumeRatio: null,
          totalShares: null, floatShares: null, freeFloatShares: null, pe: null, peTtm: null, pb: null,
          totalMarketValue: null, circulatingMarketValue: null,
        }] },
    });
    const supplements = {
      financialArchives: [reportRef, disclosureRef], turnoverArchives: [turnoverRef],
      bookValueBasis: { reportRevision: reportRef.revision, periodEnd, basis: "caller-confirmed-unadjusted-CNY" },
    } as const;
    const detailedRequest = { archiveRef: ref, ...supplements };
    expect((await initial.send(detailedRequest, false)).status).toBe(401);
    const detailed = await initial.client.readObservationAnalytics!(detailedRequest);
    expect(detailed).toEqual(await deriveTspArchiveAnalytics(ref, undefined, supplements));
    expect(detailed.input).toMatchObject({
      financialInput: { status: "available", periodEnd, actualDisclosureDate,
        reportEvidence: [{ ref: reportRef, observedAt: capturedAt }],
        disclosureEvidence: [{ ref: disclosureRef, observedAt: capturedAt }],
        bookValueBasis: { ...supplements.bookValueBasis, compatible: true } },
      turnoverInputs: [{ archiveRef: turnoverRef, tradeDate: asOf, source: "tushare", endpoint: "daily_basic",
        unit: "percentage-point", value: 2.5, availability: "reported" }],
    });
    expect(detailed.researchFactors.values).toMatchObject({
      roe_latest: -2, gross_margin_latest: 0, net_margin_latest: null, pb_latest: 2, turnover_rate: 2.5,
    });
    expect(Object.keys(detailed.researchFactors.values)).toHaveLength(77);
    expect(Object.keys(detailed.priceLevels.levels)).toHaveLength(11);
    expect(JSON.stringify(detailed)).not.toContain(secret);

    await host.close();
    host = startWorkbenchServer({ port: 0, assetsRoot });
    const restarted = await connect();
    expect(await restarted.client.readObservationAnalytics!(ref)).toEqual(result);
    expect(await restarted.client.readObservationAnalytics!({ archiveRef: ref })).toEqual(result);
    expect(await restarted.client.readObservationAnalytics!(detailedRequest)).toEqual(detailed);
    const legacy = await restarted.client.readObservationIndicators!(ref);
    expect(legacy.archiveRef).toEqual(ref);
    expect(legacy.daily?.fields).toHaveLength(37);
    for (const bad of [
      { ...ref, revision: "../private" }, { ...ref, path: "private" }, { ...ref, version: 1 }, null,
      { ...detailedRequest, financialArchives: [{ ...reportRef, revision: "invalid" }] },
      { ...detailedRequest, financialArchives: [reportRef, reportRef] },
      { ...detailedRequest, turnoverArchives: [reportRef] },
      { ...detailedRequest, turnoverArchives: [turnoverRef, turnoverRef] },
      { ...detailedRequest, bookValueBasis: { ...supplements.bookValueBasis, periodEnd: "2024-02-30" } },
      { ...detailedRequest, bookValueBasis: { ...supplements.bookValueBasis, reportRevision: disclosureRef.revision } },
      { ...detailedRequest, unexpected: true },
    ]) {
      const response = await restarted.send(bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INPUT_INVALID" } });
    }
    const missing = await restarted.send({ ...ref, revision: "f".repeat(64) });
    expect(missing.status).toBe(404);
    const failure = await missing.text();
    expect(JSON.parse(failure)).toMatchObject({ error: { code: "OBSERVATION_ARCHIVE_UNAVAILABLE" } });
    const missingSupplement = await restarted.send({
      ...detailedRequest, turnoverArchives: [{ ...turnoverRef, revision: "f".repeat(64) }],
    });
    expect(missingSupplement.status).toBe(404);
    expect(await missingSupplement.json()).toMatchObject({ error: { code: "OBSERVATION_ARCHIVE_UNAVAILABLE" } });
    const foreignReport = await archiveFinancialObservations({ ...report, symbol: "600001.SH", rows: [...report.rows] });
    const mismatched = await restarted.send({ archiveRef: ref, financialArchives: [foreignReport, disclosureRef] });
    expect(mismatched.status).toBe(404);
    expect(await mismatched.json()).toMatchObject({ error: { code: "OBSERVATION_ARCHIVE_UNAVAILABLE" } });
    writeFileSync(join(root, "data", "observation-archives-v2", ref.revision + ".json"), secret);
    const damaged = await restarted.send(ref);
    expect(damaged.status).toBe(404);
    expect(await damaged.text()).toBe(failure);
    expect(calls).toBe(0);
  } finally {
    await host.close();
    await provider.stop(true);
    if (before === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveTradingDateObservations, saveSettings } from "../../../storage/index.ts";
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
  let providerCalls = 0;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    providerCalls++;
    return new Response(null, { status: 403 });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "fixture-token", TUSHARE_BASE_URL: provider.url.origin } });
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
    const send = (arg: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { "x-workbench-token": token } : {}) },
      body: JSON.stringify({ method: "readObservationListRows", args: [arg] }),
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
    for (const invalid of [
      { ...request, marketRef: { ...marketRef, revision: "../private" } },
      { ...request, stocks: [stock, stock] },
      { ...request, stocks: Array.from({ length: 101 }, (_, i) => ({ symbol: `600${String(i).padStart(3, "0")}.SH` })) },
      { ...request, stocks: [{ ...stock, history: { ref, exchange: { rawArchiveRef: ref } } }] },
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
    await expect(client.readObservationListRows!({ ...request, stocks: [stock, stock] })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(providerCalls).toBe(0);
  } finally {
    await host.close();
    await provider.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

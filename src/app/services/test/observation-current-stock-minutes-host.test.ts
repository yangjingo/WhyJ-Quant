import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, saveSettings } from "../../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { ObservationCurrentStockMinutesRequest } from "../../../types/workbench.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

const date = "2024-04-08";
const stamp = (time: string) => Date.parse(date + "T" + time + "+08:00");

test("authenticated Host reads the selected TickFlow stock minute batch and keeps provisional WHYJ charts separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-current-stock-minutes-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const clock = spyOn(Date, "now").mockReturnValue(stamp("10:00:00"));
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  const symbol = "600001.SH", missing = "000001.SZ", empty = "830799.BJ";
  const requests: URL[] = [];
  let online = true;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    requests.push(new URL(request.url));
    if (!online || request.headers.get("x-api-key") !== "current-stock-host-fixture")
      return new Response("current-stock-host-fixture", { status: 403 });
    const prices = [10, 11];
    return Response.json({ data: {
      [symbol]: { timestamp: [stamp("09:31:00"), stamp("09:32:00")], open: prices, high: prices, low: prices,
        close: prices, volume: [0, 2], amount: [0, 22] },
      [empty]: { timestamp: [], open: [], high: [], low: [], close: [], volume: [], amount: [] },
    } });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "current-stock-host-fixture", TICKFLOW_BASE_URL: provider.url.origin } });
  const host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const baseUrl = host.server.url.origin;
    const { token } = await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string };
    const client = createHostClient({ baseUrl });
    const send = (argument: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated && { "x-workbench-token": token }) },
      body: JSON.stringify({ method: "readObservationCurrentStockMinutes", args: [argument] }),
    });
    const ref = await archiveDailyTradingLimits({
      symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt: "2024-04-08T01:25:00Z",
      priceUnit: "CNY", coverage: "unknown", requested: { startDate: date, endDate: date },
      rows: [{ tradeDate: date, previousClose: 10, limitUp: 11, limitDown: 9 }],
    });
    const raw: ObservationCurrentStockMinutesRequest = { tradeDate: date, stocks: [symbol, missing, empty].map(symbol => ({ symbol })) };
    const previousClose = { ref, priceBasis: "caller-confirmed-same-basis" } as const;
    const interpreted: ObservationCurrentStockMinutesRequest = { ...raw,
      stocks: [{ symbol, previousClose }, ...raw.stocks.slice(1)],
      interpretation: { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY" } };
    expect((await send(raw, false)).status).toBe(401);
    for (const invalid of [
      { ...raw, tradeDate: "2024-04-09" },
      { ...raw, stocks: [] },
      { ...raw, stocks: Array.from({ length: 101 }, (_, i) => ({ symbol: (600100 + i) + ".SH" })) },
      { ...raw, stocks: [{ symbol }, { symbol: " 600001.sh " }] },
      { ...raw, stocks: [{ symbol: "000001.SH" }] },
      { ...raw, stocks: [{ symbol, previousClose }] },
      { ...interpreted, interpretation: { ...interpreted.interpretation, priceBasis: "provider-native" } },
      { ...interpreted, stocks: [{ symbol, previousClose: { ...previousClose, ref: { ...ref, revision: "../invalid" } } }] },
      { ...raw, key: "injected" },
    ]) {
      const response = await send(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    }
    await expect(client.readObservationCurrentStockMinutes!({ ...raw, stocks: [] })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(client.readObservationCurrentStockMinutes!({ ...interpreted, stocks: [{ symbol: missing, previousClose }] }))
      .rejects.toMatchObject({ code: "OBSERVATION_COLLECTION_FAILED" });
    expect(requests).toHaveLength(0);

    const result = await client.readObservationCurrentStockMinutes!(raw);
    expect(result.input).toMatchObject({ interpretation: null, minutes: { source: "tickflow", finality: "provisional",
      adjustment: "unknown", requestedSymbols: [symbol, missing, empty], frames: [
        { symbol, status: "observed", rows: [{ sourceTimestamp: stamp("09:31:00"), volume: 0, amount: 0 }, { close: 11 }] },
        { symbol: missing, status: "missing", rows: [] }, { symbol: empty, status: "empty", rows: [] },
      ] } });
    expect(result.rows.map(row => row.metrics)).toEqual([null, null, null]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/klines/intraday/batch");
    expect(requests[0]!.searchParams.get("symbols")).toBe([symbol, missing, empty].join(","));
    const chart = await client.readObservationCurrentStockMinutes!(interpreted);
    expect(chart.rows[0]).toMatchObject({ previousClose: { archiveRef: ref, rows: [{ tradeDate: date, price: 10 }] },
      metrics: { producer: "whyj", finality: "provisional", latestReturnFraction: 11 / 10 - 1, points: [
        { minute: "09:30", close: 10, averageClose: 10, previousCloseReturnFraction: 0 },
        { minute: "09:31", close: 11, averageClose: 10.5 },
      ] } });
    expect(chart.rows.slice(1).map(({ status, metrics }) => [status, metrics])).toEqual([["missing", null], ["empty", null]]);
    expect(requests).toHaveLength(2);

    online = false;
    const response = await send(raw);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain("current-stock-host-fixture");
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: { code: "OBSERVATION_COLLECTION_FAILED" } });
    expect(requests).toHaveLength(3);
  } finally {
    await host.close();
    await provider.stop(true);
    clock.mockRestore();
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

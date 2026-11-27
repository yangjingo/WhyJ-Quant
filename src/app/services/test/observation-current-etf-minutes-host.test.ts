import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedEtfDailyBars, saveSettings } from "../../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { ObservationCurrentEtfMinutesRequest } from "../../../types/workbench.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

test("authenticated Host reads provisional ETF chart indicators with native provider observations", async () => {
  const date = "2024-04-08", previous = "2024-04-03";
  const stamp = (day: string, time: string) => Date.parse(day + "T" + time + "+08:00");
  const root = mkdtempSync(join(tmpdir(), "whyj-host-current-etf-minutes-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const clock = spyOn(Date, "now").mockReturnValue(stamp(date, "10:00:00"));
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  const symbol = "510300.SH", noClose = "159915.SZ", missing = "588000.SH", empty = "159919.SZ";
  const requests: URL[] = [];
  let online = true;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    requests.push(new URL(request.url));
    if (!online || request.headers.get("x-api-key") !== "current-etf-host-fixture") return new Response("current-etf-host-fixture", { status: 403 });
    const raw = (close: number[]) => ({ timestamp: close.map(() => stamp(date, "09:31:00")),
      open: close, high: close, low: close, close, volume: close.map(() => 0), amount: close.map(() => 0) });
    return Response.json({ data: { [symbol]: raw([10]), [noClose]: raw([8]), [empty]: raw([]) } });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "current-etf-host-fixture", TICKFLOW_BASE_URL: provider.url.origin } });
  const host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const baseUrl = host.server.url.origin;
    const { token } = await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string };
    const client = createHostClient({ baseUrl });
    const send = (argument: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated && { "x-workbench-token": token }) },
      body: JSON.stringify({ method: "readObservationCurrentEtfMinutes", args: [argument] }),
    });
    const dailyRef = await archiveDatedEtfDailyBars({ symbol, market: "A", assetType: "etf", source: "tickflow", endpoint: "/v1/klines",
      observedAt: "2024-04-08T01:00:00Z", requested: { start: previous, end: previous }, coverage: "unknown",
      interval: "1d", adjustment: "none", priceUnit: "unknown", volumeUnit: "unknown", amountUnit: "unknown", timeZone: "Asia/Shanghai",
      rows: [{ tradeDate: previous, sourceTimestamp: stamp(previous, "15:00:00"), open: 10, high: 10, low: 10, close: 10, volume: 100, amount: null }],
    });
    const previousClose = { dailyRef, calendar: { revision: "fixture-calendar", previousTradeDate: previous, tradeDate: date },
      priceBasis: "caller-confirmed-same-basis" } as const;
    const raw = { tradeDate: date, etfs: [{ symbol: " 510300.sh " }, { symbol: noClose }, { symbol: missing }, { symbol: empty }] };
    const interpreted: ObservationCurrentEtfMinutesRequest = { ...raw, etfs: [{ symbol, previousClose }, ...raw.etfs.slice(1)],
      interpretation: { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY" } };
    expect((await send(raw, false)).status).toBe(401);
    for (const bad of [{ ...raw, tradeDate: previous }, { ...raw, etfs: [{ symbol: "600000.SH" }] },
      { ...raw, etfs: [...raw.etfs, { symbol }] }, { ...interpreted, interpretation: undefined },
      { ...interpreted, etfs: [{ symbol, previousClose: { ...previousClose, dailyRef: { ...dailyRef, revision: "../invalid" } } }] },
      { ...interpreted, etfs: [{ symbol, previousClose: { ...previousClose,
        calendar: { ...previousClose.calendar, previousTradeDate: date } } }] },
    ]) {
      const response = await send(bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    }
    await expect(client.readObservationCurrentEtfMinutes!({ ...interpreted, etfs: [{ symbol: noClose, previousClose }] }))
      .rejects.toMatchObject({ code: "OBSERVATION_COLLECTION_FAILED" });
    expect(requests).toHaveLength(0);

    const observed = await client.readObservationCurrentEtfMinutes!(raw);
    expect(observed.input).toMatchObject({ interpretation: null, minutes: { source: "tickflow", assetType: "etf", finality: "provisional",
      frames: [{ symbol, status: "observed", rows: [{ close: 10, volume: 0, amount: 0 }] }, { symbol: noClose, status: "observed" },
        { symbol: missing, status: "missing" }, { symbol: empty, status: "empty" }] } });
    expect(observed.rows.every(row => row.metrics === null)).toBe(true);
    const chart = await client.readObservationCurrentEtfMinutes!(interpreted);
    expect(chart.rows[0]).toMatchObject({ previousClose: { dailyRef, row: { tradeDate: previous, close: 10 } },
      metrics: { producer: "whyj", finality: "provisional", latestReturnFraction: 0 } });
    expect(chart.rows[1]?.metrics?.latestReturnFraction).toBeNull();
    expect(chart.rows.slice(2).map(row => [row.status, row.metrics])).toEqual([["missing", null], ["empty", null]]);
    online = false;
    const denied = await send(raw);
    expect(denied.status).toBe(502);
    const body = await denied.text();
    expect(body).not.toContain("current-etf-host-fixture");
    expect(JSON.parse(body)).toMatchObject({ error: { code: "OBSERVATION_COLLECTION_FAILED" } });
    expect(requests.map(url => [url.pathname, url.searchParams.get("symbols")])).toEqual(
      Array(3).fill(["/v1/klines/intraday/batch", [symbol, noClose, missing, empty].join(",")]),
    );
  } finally {
    await host.close();
    await provider.stop(true);
    clock.mockRestore();
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

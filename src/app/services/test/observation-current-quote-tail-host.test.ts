import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSettings } from "../../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { ObservationCurrentEtfMinutesPreview, ObservationCurrentStockMinutesPreview } from "../../../types/workbench.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

test("authenticated current stock and ETF previews expose a distinct WHYJ quote-tail projection", async () => {
  const tradeDate = "2024-04-08";
  const stamp = (time: string) => Date.parse(tradeDate + "T" + time + "+08:00");
  let now = stamp("09:31:20");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const root = mkdtempSync(join(tmpdir(), "whyj-host-current-quote-tail-"));
  const previousRoot = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  const key = "current-quote-tail-host-fixture";
  const minutePath = "/v1/klines/intraday/batch", quotePath = "/v1/quotes";
  const requests: [string, string][] = [];
  let quoteStatus: "fresh" | "stale" | "unavailable" = "fresh";
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (request.headers.get("x-api-key") !== key) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbols") ?? "";
    requests.push([url.pathname, symbol]);
    if (url.pathname === minutePath) {
      now = stamp("09:31:20");
      return Response.json({ data: { [symbol]: {
        timestamp: [stamp("09:31:00")], open: [10], high: [11], low: [10], close: [11], volume: [0], amount: [0],
      } } });
    }
    now = stamp("09:31:55");
    if (url.pathname !== quotePath || quoteStatus === "unavailable") return new Response(key, { status: 403 });
    return Response.json({ data: [{
      symbol, region: "CN", timestamp: stamp(quoteStatus === "fresh" ? "09:31:45" : "09:31:22"),
      last_price: 12, prev_close: 10, open: 10, high: 12, low: 10, volume: 100, amount: 1200,
    }] });
  } });
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: key, TICKFLOW_BASE_URL: provider.url.origin } });
  const host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const baseUrl = host.server.url.origin;
    const { token } = await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string };
    const send = (method: string, argument: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated && { "x-workbench-token": token }) },
      body: JSON.stringify({ method, args: [argument] }),
    });
    const preview = async (response: Response) => (await response.json() as {
      result: ObservationCurrentStockMinutesPreview | ObservationCurrentEtfMinutesPreview;
    }).result;
    const quoteTail = { maxAgeMs: 15_000, priceBasis: "caller-confirmed-same-basis" };
    const interpretation = { timestampLabel: "minute-start", priceBasis: "caller-confirmed-unadjusted-CNY" };
    for (const [method, field, symbol] of [
      ["readObservationCurrentStockMinutes", "stocks", "600001.SH"],
      ["readObservationCurrentEtfMinutes", "etfs", "510300.SH"],
    ]) {
      requests.length = 0;
      const input = { tradeDate, [field]: [{ symbol }], interpretation };
      const enabled = { ...input, quoteTail };
      expect((await send(method, enabled, false)).status).toBe(401);
      for (const bad of [
        { ...enabled, interpretation: undefined },
        { ...enabled, quoteTail: null },
        { ...enabled, quoteTail: { ...quoteTail, maxAgeMs: -1 } },
        { ...enabled, quoteTail: { ...quoteTail, maxAgeMs: 1.5 } },
        { ...enabled, quoteTail: { ...quoteTail, priceBasis: "unknown" } },
        { ...enabled, quoteTail: { ...quoteTail, extra: true } },
      ]) {
        const response = await send(method, bad);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
      }
      expect(requests).toEqual([]);
      const baseline = await send(method, input);
      expect(baseline.status).toBe(200);
      const base = await preview(baseline);
      expect(base.input).not.toHaveProperty("quoteTail");
      expect(base.rows[0]).not.toHaveProperty("quoteTail");
      expect(requests).toEqual([[minutePath, symbol]]);

      quoteStatus = "fresh";
      const fresh = await send(method, enabled);
      expect(fresh.status).toBe(200);
      expect(await preview(fresh)).toMatchObject({
        input: { minutes: base.input.minutes, quoteTail: { status: "observed", source: "tickflow",
          data: [{ symbol, lastPrice: 12, volume: 100, amount: 1200, timestamp: stamp("09:31:45") }] } },
        rows: [{ quoteTail: { producer: "whyj", status: "updated", applied: { finality: "provisional" } },
          metrics: { points: [{ close: 12, priceSource: "quote" }] } }],
      });

      quoteStatus = "stale";
      const stale = await send(method, enabled);
      expect(stale.status).toBe(200);
      expect((await preview(stale)).rows).toMatchObject([{ quoteTail: { status: "unchanged", reason: "stale-quote" },
        metrics: base.rows[0].metrics }]);
      quoteStatus = "unavailable";
      const unavailable = await send(method, enabled);
      expect(unavailable.status).toBe(200);
      const body = await unavailable.text();
      expect(body).not.toContain(key);
      expect(JSON.parse(body).result).toMatchObject({ input: { quoteTail: { status: "unavailable" } },
        rows: [{ metrics: base.rows[0].metrics }] });
      const paths = [minutePath, minutePath, quotePath, minutePath, quotePath, minutePath, quotePath];
      expect(requests).toEqual(paths.map((path): [string, string] => [path, symbol]));
    }
  } finally {
    await host.close();
    await provider.stop(true);
    clock.mockRestore();
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

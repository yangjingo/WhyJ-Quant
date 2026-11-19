import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import { saveSettings } from "../../../storage/index.ts";
import type { ObservationJobView } from "../../../types/workbench.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

test("the authenticated Host collects a past minute window and replays one day after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-intraday-"));
  const previous = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const symbol = "600000.SH", tradeDate = "2024-01-02", secret = "fixture-minute-secret";
  let calls = 0, mode: "empty" | "denied" | "rows" = "empty";
  let providerStopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    calls++;
    const body = await req.json() as { api_name: string; token: string; params: unknown };
    expect(body.token).toBe(secret);
    if (body.api_name === "stk_limit") {
      return Response.json({ code: 0, data: { fields: ["ts_code", "trade_date", "pre_close", "up_limit", "down_limit"],
        items: [[symbol, "20240102", 10, 11, 9]] } });
    }
    expect(body.api_name).toBe("stk_mins");
    expect(body.params).toEqual({
      ts_code: symbol, freq: "1min", start_date: "2024-01-02 09:00:00", end_date: "2024-01-04 19:00:00",
    });
    if (mode === "denied") return new Response(secret, { status: 403 });
    const items = mode === "empty" ? [] : [
      [symbol, "2024-01-02 09:30:00", 11, 11, 11, 11, 90, 990],
      [symbol, "2024-01-02 09:31:00", 9.8, 9.8, 9.8, 9.8, 100, 980],
      [symbol, "2024-01-02 09:32:00", 10.2, 10.2, 10.2, 10.2, 100, 1020],
      [symbol, "2024-01-03 09:31:00", 11, 11, 11, 11, 0, 0],
    ];
    return Response.json({ code: 0, data: { fields: ["ts_code", "trade_time", "open", "high", "low", "close", "vol", "amount"], items } });
  } });
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: secret, TUSHARE_BASE_URL: provider.url.origin } });
  let host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const connect = async () => {
      const baseUrl = host.server.url.origin;
      const token = (await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string }).token;
      return {
        client: createHostClient({ baseUrl }),
        send: (method: string, arg: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", { method: "POST",
          headers: { "Content-Type": "application/json", ...(authenticated ? { "x-workbench-token": token } : {}) },
          body: JSON.stringify({ method, args: [arg] }) }),
      };
    };
    const { send, client } = await connect();
    const request = { dataset: "historical-minute-bars", symbol, startDate: tradeDate, endDate: "2024-01-04" } as const;
    expect((await send("startObservationJob", request, false)).status).toBe(401);
    for (const invalid of [{ ...request, token: "private" }, { ...request, endDate: "2024-02-20" }, { ...request, endDate: "2099-01-01" }]) {
      const reply = await send("startObservationJob", invalid);
      expect(reply.status).toBe(400);
      expect(await reply.json()).toMatchObject({ error: { code: "INPUT_INVALID" } });
    }
    expect(calls).toBe(0);
    const finish = async (started: ObservationJobView) => {
      let job = started;
      for (let i = 0; i < 100 && job.status === "running"; i++) {
        await Bun.sleep(20);
        job = await client.readObservationJob!(started.id);
      }
      expect(JSON.stringify(job)).not.toContain(secret);
      return job;
    };
    expect(await finish(await client.startObservationJob!(request))).toMatchObject({ status: "empty", receipt: { rowCount: 0, ref: null } });
    mode = "denied";
    expect(await finish(await client.startObservationJob!(request))).toMatchObject({ status: "failed", error: "COLLECTION_FAILED", receipt: null });
    mode = "rows";
    const minute = await finish(await client.startObservationJob!(request));
    expect(minute).toMatchObject({ status: "archived", receipt: { source: "tushare", endpoint: "stk_mins", rowCount: 4 } });
    const archiveRef = minute.receipt?.ref;
    if (!archiveRef || !("kind" in archiveRef) || archiveRef.kind !== "historical-minute-bars") throw new Error("Missing minute archive");
    const limit = await finish(await client.startObservationJob!({ dataset: "daily-trading-limits", symbol, startDate: tradeDate, endDate: tradeDate }));
    const previousRef = limit.receipt?.ref;
    if (!previousRef || !("kind" in previousRef) || previousRef.kind !== "daily-trading-limits") throw new Error("Missing previous close archive");
    const previewRequest = { archiveRef, tradeDate };
    const paired = { ...previewRequest, previousClose: { ref: previousRef, priceBasis: "caller-confirmed-same-basis" as const } };
    expect((await send("readObservationIntraday", paired, false)).status).toBe(401);
    const baseline = await client.readObservationIntraday!(paired);
    expect(baseline.archiveRef).toEqual(archiveRef);
    expect(baseline.input.previousClose?.archiveRef).toEqual(previousRef);
    expect(baseline.rows.map(row => row.minute)).toEqual(["09:30", "09:31"]);
    expect(Object.keys(baseline.rows[0]!.values)).toHaveLength(11);
    expect(Object.keys(baseline.rows[0]!.signals)).toHaveLength(4);
    expect(baseline.rows[0]).toMatchObject({ originalTradeTime: "2024-01-02 09:31:00", values: { vwap: 9.8, pct_from_open: 0 } });
    expect(baseline.rows[1]!.signals.signal_intraday_zero_cross_up).toBe(true);
    expect(baseline.openingBoundaries.map(row => row.tradeTime)).toEqual(["2024-01-02 09:30:00"]);

    await provider.stop(true);
    providerStopped = true;
    await host.close();
    host = startWorkbenchServer({ port: 0, assetsRoot });
    const restarted = await connect();
    expect(await restarted.client.readObservationIntraday!(paired)).toEqual(baseline);
    const nextDay = await restarted.client.readObservationIntraday!({ ...previewRequest, tradeDate: "2024-01-03" });
    expect(nextDay.openingBoundaries).toEqual([]);
    expect(nextDay.rows[0]?.values.vwap).toBeNull();
    const empty = await restarted.client.readObservationIntraday!({ ...previewRequest, tradeDate: "2024-01-04" });
    expect(empty.rows).toEqual([]);
    expect(empty.input.coverage).toBe("unknown");
    for (const invalid of [{ ...previewRequest, tradeDate: "2024-02-31" }, { ...previewRequest, tradeDate: "2024-01-05" },
      { ...previewRequest, archiveRef: previousRef }, { ...previewRequest, previousClose: { ref: previousRef } },
      { ...previewRequest, archiveRef: { ...archiveRef, revision: "../private" } }]) {
      const reply = await restarted.send("readObservationIntraday", invalid);
      expect(reply.status).toBe(400);
      expect(await reply.json()).toMatchObject({ error: { code: "INPUT_INVALID" } });
    }
    const missing = await restarted.send("readObservationIntraday", { ...previewRequest, archiveRef: { ...archiveRef, revision: "f".repeat(64) } });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    expect(JSON.parse(missingBody)).toMatchObject({ error: { code: "OBSERVATION_ARCHIVE_UNAVAILABLE" } });
    writeFileSync(join(root, "data", "historical-minute-archives-v1", archiveRef.revision + ".json"), secret);
    const damaged = await restarted.send("readObservationIntraday", previewRequest);
    expect(damaged.status).toBe(404);
    expect(await damaged.text()).toBe(missingBody);
    expect(calls).toBe(4);
  } finally {
    await host.close();
    if (!providerStopped) await provider.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

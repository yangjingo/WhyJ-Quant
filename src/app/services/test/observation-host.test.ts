import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import { saveSettings, loadObservationArchive, loadTradingDateArchive } from "../../../storage/index.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";
import type { ObservationJobView } from "../../../types/workbench.ts";

test("authenticated RPC collects a selected TickFlow observation and preserves its committed reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-observation-"));
  const previous = process.env.OHQUANT_DIR; process.env.OHQUANT_DIR = root;
  const stamp = Date.parse("2026-11-12T00:00:00+08:00"); let calls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    calls++; expect(req.headers.get("x-api-key")).toBe("synthetic-key");
    if (new URL(req.url).pathname.endsWith("ex-factors")) return Response.json({ data: { "600000.SH": [{ timestamp: stamp, ex_factor: 1.25 }] } });
    return Response.json({ data: { timestamp: [stamp], open: [10], high: [12], low: [9], close: [11], volume: [100], amount: [null] } });
  } });
  mkdirSync(join(root, "assets")); writeFileSync(join(root, "assets", "index.html"), "<html><head></head></html>");
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" }, env: { WHYJ_QUANT_TICKFLOW_API_KEY: "synthetic-key", TICKFLOW_BASE_URL: provider.url.origin } });
  const host = startWorkbenchServer({ port: 0, assetsRoot: join(root, "assets") });
  try {
    const url = host.server.url.origin, token = (await (await fetch(url + "/api/workbench/bootstrap")).json() as { token: string }).token;
    const send = (method: string, arg: unknown, auth = true) => fetch(url + "/api/workbench/rpc", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { "x-workbench-token": token } : {}) }, body: JSON.stringify({ method, args: [arg] }) });
    const request = { dataset: "daily", symbol: "600000.SH", startTime: stamp, endTime: stamp, adjustment: "none" };
    expect((await send("startObservationJob", request, false)).status).toBe(401);
    expect((await send("startObservationJob", { ...request, key: "secret" })).status).toBe(400);
    expect(calls).toBe(0);
    for (const [input, expected] of [[request, "daily_bar"], [{ ...request, dataset: "minute", interval: "1m" }, "minute_bar"],
      [{ dataset: "factor", symbol: request.symbol, startTime: stamp, endTime: stamp }, "adjustment_factor"]] as const) {
      const startedResponse = await send("startObservationJob", input); expect(startedResponse.status).toBe(200);
      const started = (await startedResponse.json() as { result: ObservationJobView }).result;
      let result = started;
      for (let i = 0; i < 100 && result.status === "running"; i++) {
        await Bun.sleep(20);
        const response = await send("readObservationJob", started.id); const text = await response.text();
        expect(text).not.toContain("synthetic-key"); result = (JSON.parse(text) as { result: ObservationJobView }).result;
      }
      expect(result).toMatchObject({ status: "archived", receipt: { rowCount: 1, source: "tickflow" } });
      const ref = result.receipt?.ref; if (!ref || ref.version !== 1) throw new Error("missing v1 reference");
      expect(await loadObservationArchive(ref)).toMatchObject([{ symbol: "600000.SH", timestamp: stamp, kind: expected }]);
    }
    const dated = { dataset: "daily", timeMode: "trading-date", symbol: "600000.SH", startDate: "2026-11-12", endDate: "2026-11-12", adjustment: "none" };
    expect((await send("startObservationJob", dated, false)).status).toBe(401);
    expect((await send("startObservationJob", { ...dated, key: "secret" })).status).toBe(400);
    const response = await send("startObservationJob", dated); expect(response.status).toBe(200);
    const started = (await response.json() as { result: ObservationJobView }).result; let result = started;
    for (let i = 0; i < 100 && result.status === "running"; i++) {
      await Bun.sleep(20); const reply = await send("readObservationJob", started.id); const text = await reply.text();
      expect(text).not.toContain("synthetic-key"); result = (JSON.parse(text) as { result: ObservationJobView }).result;
    }
    expect(result).toMatchObject({ status: "archived", receipt: { rowCount: 1, source: "tickflow" } });
    const ref = result.receipt?.ref; if (!ref || ref.version !== 2) throw new Error("missing v2 reference");
    expect(await loadTradingDateArchive(ref)).toMatchObject([{ symbol: "600000.SH", tradeDate: "2026-11-12", sourceTimestamp: stamp }]);
    expect(calls).toBe(4);
  } finally { await host.close(); await provider.stop(true); if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});

test("authenticated date job uses the selected Tushare provider and preserves null source time", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-dated-"));
  const previous = process.env.OHQUANT_DIR; process.env.OHQUANT_DIR = root; let calls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    calls++; const body = await req.json() as { api_name: string; token: string }; expect(body.api_name).toBe("daily"); expect(body.token).toBe("synthetic-key");
    return Response.json({ code: 0, data: { fields: ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"], items: [["600000.SH", "20240102", 10, 12, 9, 11, 100, null]] } });
  } });
  mkdirSync(join(root, "assets")); writeFileSync(join(root, "assets", "index.html"), "<html><head></head></html>");
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" }, env: { WHYJ_QUANT_TUSHARE_TOKEN: "synthetic-key", TUSHARE_BASE_URL: provider.url.origin } });
  const host = startWorkbenchServer({ port: 0, assetsRoot: join(root, "assets") });
  try {
    const url = host.server.url.origin, token = (await (await fetch(url + "/api/workbench/bootstrap")).json() as { token: string }).token;
    const send = (method: string, arg: unknown) => fetch(url + "/api/workbench/rpc", { method: "POST", headers: { "Content-Type": "application/json", "x-workbench-token": token }, body: JSON.stringify({ method, args: [arg] }) });
    const response = await send("startObservationJob", { dataset: "daily", timeMode: "trading-date", symbol: "600000.SH", startDate: "2024-01-02", endDate: "2024-01-02", adjustment: "none" });
    expect(response.status).toBe(200); const started = (await response.json() as { result: ObservationJobView }).result; let result = started;
    for (let i = 0; i < 100 && result.status === "running"; i++) {
      await Bun.sleep(20); const reply = await send("readObservationJob", started.id); const text = await reply.text();
      expect(text).not.toContain("synthetic-key"); result = (JSON.parse(text) as { result: ObservationJobView }).result;
    }
    expect(result).toMatchObject({ status: "archived", receipt: { source: "tushare", rowCount: 1 } });
    const ref = result.receipt?.ref; if (!ref || ref.version !== 2) throw new Error("missing v2 reference");
    expect(await loadTradingDateArchive(ref)).toMatchObject([{ tradeDate: "2024-01-02", sourceTimestamp: null, volumeUnit: "hand" }]);
    expect(calls).toBe(1);
  } finally { await host.close(); await provider.stop(true); if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});

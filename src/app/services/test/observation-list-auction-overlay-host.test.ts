import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_MAX_REQUEST_BYTES } from "../../../types/workbench-host.ts";
import type { ObservationListAuctionOverlayRequest } from "../../../types/workbench.ts";
import { createHostClient } from "../../host/client.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";

test("authenticated Host returns the aligned auction overlay and independent TSP source receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-host-auction-overlay-"));
  const assetsRoot = join(root, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "<html><head></head></html>");
  const symbol = "600000.SH", missing = "000001.SZ", date = "2025-06-18";
  const fixtureToken = "tsp_auction_host_fixture";
  const input: ObservationListAuctionOverlayRequest = { datasetId: "auction_demo", date, symbols: [symbol, missing],
    fields: { price: "open_price", matchedQuantity: "match", unmatchedQuantity: "unmatch" },
    timeBasis: "caller-confirmed-shanghai-wall-clock" };
  const requests: URL[] = [];
  let online = true;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    requests.push(url);
    if (!online || request.headers.get("authorization") !== "Bearer " + fixtureToken) return new Response(fixtureToken, { status: 403 });
    const field = url.searchParams.get("field");
    const items = field === "open_price" ? { [symbol]: [["09:15", 10], ["09:16:00", 11]], [missing]: [] }
      : field === "match" ? { [symbol]: [["09:15:00", 0], ["09:16", 2], ["09:16:00", 3]] }
        : { [symbol]: [["09:15", -2], ["09:16", 0]] };
    return Response.json({ config_id: input.datasetId, field, date, granularity: "intraday", items });
  } });
  const env = { OHQUANT_DIR: root, WHYJ_QUANT_TSP_BASE_URL: provider.url.origin, WHYJ_QUANT_TSP_READ_EXT_TOKEN: fixtureToken };
  const before = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  const host = startWorkbenchServer({ port: 0, assetsRoot });
  try {
    const baseUrl = host.server.url.origin;
    const { token } = await (await fetch(baseUrl + "/api/workbench/bootstrap")).json() as { token: string };
    const client = createHostClient({ baseUrl });
    const send = (argument: unknown, authenticated = true) => fetch(baseUrl + "/api/workbench/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated && { "x-workbench-token": token }) },
      body: JSON.stringify({ method: "readObservationListAuctionOverlay", args: [argument] }),
    });
    expect((await send(input, false)).status).toBe(401);
    expect((await send({ ...input, ignored: "x".repeat(HOST_MAX_REQUEST_BYTES) })).status).toBe(413);
    for (const bad of [{ ...input, date: "2025-02-30" }, { ...input, symbols: [symbol, symbol] },
      { ...input, timeBasis: null }, { ...input, fields: { price: "bad,name" } },
      { ...input, fields: { ...input.fields, unmatchedQuantity: "match" } }, { ...input, baseUrl: "http://ignored.invalid/" },
    ]) {
      const response = await send(bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    }
    expect(requests).toHaveLength(0);

    const result = await client.readObservationListAuctionOverlay!(input);
    expect(result.input).toMatchObject({ datasetId: input.datasetId, timeBasis: input.timeBasis,
      price: { source: "tsp", originalPublisher: "unknown", field: "open_price", valueUnit: "unknown",
        series: [{ symbol, status: "observed", pointCount: 2 }, { symbol: missing, status: "empty", pointCount: 0 }] },
      matchedQuantity: { field: "match", series: [{ symbol, status: "observed", pointCount: 3 }, { symbol: missing, status: "missing", pointCount: 0 }] },
      unmatchedQuantity: { field: "unmatch" },
    });
    expect(new Set([result.input.price, result.input.matchedQuantity, result.input.unmatchedQuantity].map(receipt => receipt?.revision)).size).toBe(3);
    expect(result.overlay).toEqual({ version: 1, producer: "whyj", tradeDate: date, rows: [
      { symbol, status: "observed", ambiguous: [{ role: "matchedQuantity", time: "09:16:00" }], points: [
        { time: "09:15:00", price: 10, matchedQuantity: 0, unmatchedQuantity: -2, unmatchedSide: "sell" },
        { time: "09:16:00", price: 11, matchedQuantity: null, unmatchedQuantity: 0, unmatchedSide: "balanced" },
      ] },
      { symbol: missing, status: "unavailable-price", ambiguous: [], points: [] },
    ] });
    expect(requests.map(url => url.searchParams.get("field")).sort()).toEqual(["match", "open_price", "unmatch"]);
    expect(requests.every(url => url.pathname === "/api/ext-data/auction_demo/series" && url.searchParams.get("date") === date)).toBe(true);
    online = false;
    const denied = await send({ ...input, fields: { price: "open_price" } });
    expect(denied.status).toBe(502);
    const body = await denied.text();
    expect(body).not.toContain(fixtureToken);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "OBSERVATION_COLLECTION_FAILED" } });
    expect(requests).toHaveLength(4);
  } finally {
    await host.close();
    await provider.stop(true);
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

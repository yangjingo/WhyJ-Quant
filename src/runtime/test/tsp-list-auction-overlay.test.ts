import { expect, test } from "bun:test";
import { readTspListAuctionOverlay, type TspListAuctionOverlayRequest } from "../data/tsp-list-auction-overlay.ts";

test("binds one TSP auction mapping to exact Shanghai timestamps and retains independent reads", async () => {
  const symbol = "600000.SH", missingPrice = "000001.SZ";
  const date = "2025-06-18";
  const request: TspListAuctionOverlayRequest = { datasetId: "auction_demo", date, symbols: [symbol, missingPrice],
    fields: { price: "auction_price", matchedQuantity: "match", unmatchedQuantity: "unmatch" },
    timeBasis: "caller-confirmed-shanghai-wall-clock" };
  const readings: Record<string, Record<string, [string, number][]>> = {
    auction_price: { [symbol]: [["09:14:59", 10], ["9:15", 10.1], ["09:16:00", 10.2], ["09:25:00", 10], ["09:25:01", 10.3]] },
    match: { [symbol]: [["09:15:00", 0], ["09:16", 2], ["09:16:00", 3]], [missingPrice]: [["09:15", 5]] },
    unmatch: { [symbol]: [["09:15:00", -3], ["09:16", 0], ["09:18", 5]] },
  };
  const calls: URL[] = [];
  const fixtureToken = "tsp_auction_overlay_fixture";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    const field = url.searchParams.get("field");
    if (req.headers.get("authorization") !== "Bearer " + fixtureToken || !field || !readings[field]) return new Response(null, { status: 403 });
    calls.push(url);
    return Response.json({ config_id: request.datasetId, field, date, granularity: "intraday", items: readings[field] });
  } });
  const key = "WHYJ_QUANT_TSP_READ_EXT_TOKEN", base = "WHYJ_QUANT_TSP_BASE_URL";
  const priorToken = process.env[key], priorBase = process.env[base];
  process.env[key] = fixtureToken;
  process.env[base] = provider.url.origin;
  try {
    await expect(readTspListAuctionOverlay({ ...request, timeBasis: null! })).rejects.toThrow("Shanghai");
    await expect(readTspListAuctionOverlay({ ...request, fields: { ...request.fields, unmatchedQuantity: "match" } })).rejects.toThrow("mapping");
    await expect(readTspListAuctionOverlay({ ...request, fields: { ...request.fields, matchedQuantity: "," } })).rejects.toThrow("mapping");
    await expect(readTspListAuctionOverlay(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);

    const capture = await readTspListAuctionOverlay(request);
    expect(calls.map(url => url.searchParams.get("field")).sort()).toEqual(["auction_price", "match", "unmatch"]);
    for (const url of calls) {
      expect(url.pathname).toBe("/api/ext-data/auction_demo/series");
      expect(url.searchParams.get("date")).toBe(date);
      expect(url.searchParams.get("symbols")).toBe([symbol, missingPrice].join(","));
      expect(url.searchParams.get("granularity")).toBe("intraday");
    }
    expect(capture.input.price.series[0]?.points?.[0]).toEqual({ time: "09:14:59", value: 10 });
    expect(capture.input.matchedQuantity?.series[0]?.points).toHaveLength(3);
    expect([capture.input.price, capture.input.matchedQuantity, capture.input.unmatchedQuantity]
      .every(source => source?.originalPublisher === "unknown" && source.valueUnit === "unknown")).toBe(true);
    expect(new Set([capture.input.price, capture.input.matchedQuantity, capture.input.unmatchedQuantity].map(source => source?.revision)).size).toBe(3);
    expect(capture.overlay).toEqual({ producer: "whyj", version: 1, tradeDate: date, rows: [
      { symbol, status: "observed", ambiguous: [{ role: "matchedQuantity", time: "09:16:00" }], points: [
        { time: "09:15:00", price: 10.1, matchedQuantity: 0, unmatchedQuantity: -3, unmatchedSide: "sell" },
        { time: "09:16:00", price: 10.2, matchedQuantity: null, unmatchedQuantity: 0, unmatchedSide: "balanced" },
        { time: "09:18:00", price: null, matchedQuantity: null, unmatchedQuantity: 5, unmatchedSide: "buy" },
        { time: "09:25:00", price: 10, matchedQuantity: null, unmatchedQuantity: null, unmatchedSide: null },
      ] },
      { symbol: missingPrice, status: "unavailable-price", ambiguous: [], points: [
        { time: "09:15:00", price: null, matchedQuantity: 5, unmatchedQuantity: null, unmatchedSide: null },
      ] },
    ] });
    const priceOnly = await readTspListAuctionOverlay({ ...request, fields: { price: "auction_price" } });
    expect(calls).toHaveLength(4);
    expect(priceOnly.input.matchedQuantity).toBeNull();
    expect(priceOnly.input.unmatchedQuantity).toBeNull();
    expect(priceOnly.overlay.rows[0]?.points[0]).toMatchObject({ price: 10.1, matchedQuantity: null, unmatchedSide: null });
  } finally {
    if (priorToken === undefined) delete process.env[key]; else process.env[key] = priorToken;
    if (priorBase === undefined) delete process.env[base]; else process.env[base] = priorBase;
    await provider.stop(true);
  }
});

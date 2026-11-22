import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { replayTspListRows, replayTspListRowsWithLiveQuotes } from "../data/list-rows.ts";

const symbols = ["600000.SH", "600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH"];
function archive(tradeDate: string) {
  const metadata = { tradeDate, observedAt: new Date().toISOString(), coverage: "unknown" } as const;
  return archiveMarketCrossSection({
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, listedOn: null, industry: null })) },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: [{ symbol: symbols[0]!, open: 9, high: 9, low: 9, close: 9, exRightsPreviousClose: 8,
        returnPct: 12.5, changeCny: 1, volume: 5, amount: 4.5 }] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

test("same-day quote reads preserve the fixed output and keep raw quantity and timestamp evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-quotes-"));
  const previous = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const timestamp = Date.now();
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(timestamp);
  const dayStart = Date.parse(date + "T00:00:00+08:00");
  const future = timestamp + 60_000;
  const controller = new AbortController();
  const abortReason = new Error("fixture caller cancelled");
  const requests: string[] = [];
  let failProvider = false, cancelOnRequest = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + "?" + url.searchParams.get("symbols"));
    if (cancelOnRequest) controller.abort(abortReason);
    if (failProvider) return new Response("mock-provider-response", { status: 403 });
    const quote = (index: number, sourceTime: number, last = 11, previousClose = 10) => ({
      symbol: symbols[index], region: "CN", timestamp: sourceTime,
      last_price: last, prev_close: previousClose, open: 10, high: 11, low: 9, volume: 0, amount: null,
    });
    return Response.json({ data: [
      quote(0, timestamp), quote(1, dayStart - 1), quote(2, future),
      quote(4, timestamp, 0), quote(5, timestamp, 11, 0),
    ] });
  } });
  const settings = { ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" as const },
    env: { WHYJ_QUANT_TICKFLOW_API_KEY: "list-quote-fixture", TICKFLOW_BASE_URL: provider.url.origin } };
  try {
    saveSettings(settings);
    const marketRef = await archive(date);
    const stocks = [...symbols].reverse().map(symbol => ({ symbol }));
    const request = { marketRef, adjustment: "none" as const, stocks };
    const fixed = await replayTspListRows(request);
    const priorDay = await archive("2024-03-04");
    expect((await replayTspListRowsWithLiveQuotes({ ...request, marketRef: priorDay })).quotes.status).toBe("outside-current-day");
    expect((await replayTspListRowsWithLiveQuotes({ ...request, stocks: [] })).quotes.status).toBe("empty");
    await expect(replayTspListRowsWithLiveQuotes({ ...request, stocks: Array.from({ length: 101 }, () => stocks[0]!) }))
      .rejects.toThrow("one provider batch");
    expect(requests).toEqual([]);
    expect(await replayTspListRowsWithLiveQuotes(request)).toMatchObject({
      fixed,
      quotes: { status: "observed", source: "tickflow", endpoint: "/v1/quotes", units: "unknown", rows: [
        { symbol: symbols[5], status: "available", sourceTimestamp: timestamp, change: { changeAmount: null, changeFraction: null } },
        { symbol: symbols[4], status: "missing-price", sourceTimestamp: timestamp },
        { symbol: symbols[3], status: "missing", sourceTimestamp: null },
        { symbol: symbols[2], status: "future-timestamp", sourceTimestamp: future },
        { symbol: symbols[1], status: "different-session", sourceTimestamp: dayStart - 1 },
        { symbol: symbols[0], status: "available", sourceTimestamp: timestamp,
          snapshot: { lastPrice: 11, previousClose: 10, timestamp, volume: 0, amount: null },
          change: { producer: "whyj", changeAmount: 1, changeFraction: 0.1 } },
      ] },
    });
    expect(requests).toEqual(["/v1/quotes?" + stocks.map(stock => stock.symbol).join(",")]);
    expect(fixed.rows.at(-1)?.observations.bar?.close).toBe(9);
    failProvider = true;
    expect(await replayTspListRowsWithLiveQuotes(request)).toEqual({ fixed, quotes: { status: "unavailable" } });
    failProvider = false;
    cancelOnRequest = true;
    await expect(replayTspListRowsWithLiveQuotes(request, { signal: controller.signal })).rejects.toBe(abortReason);
    expect(requests).toHaveLength(3);
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tushare" } });
    expect(await replayTspListRowsWithLiveQuotes(request)).toEqual({ fixed, quotes: { status: "unavailable" } });
    expect(requests).toHaveLength(3);
  } finally {
    await provider.stop(true);
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

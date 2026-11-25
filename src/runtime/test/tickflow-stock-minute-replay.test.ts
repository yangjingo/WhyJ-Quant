import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDatedEtfDailyBars, archiveDatedStockMinutes, archiveDailyTradingLimits, archiveMarketCrossSection, loadDatedStockMinuteArchive, saveSettings,
  type StoredDatedEtfDailyBatch, type StoredDatedStockMinuteBatch } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { replayTspListRows, replayTspListRowsWithLiveQuotes } from "../data/list-rows.ts";
import { replayTspIntradayMonitorAlerts, type IntradayMonitorAlertReplayRequest } from "../data/intraday-monitor-alert-replay.ts";
import { collectDatedTickFlowStockMinutes, previewCurrentTspEtfIntraday, previewCurrentTspListIntraday, replayTspTickFlowStockMinutes,
  type TickFlowStockMinuteInterpretation } from "../data/tickflow-stock-minute-replay.ts";

const symbol = "600001.SH", first = "2024-04-08", second = "2024-04-09", observedAt = "2024-04-10T01:00:00Z";
const stamp = (date: string, time: string) => Date.parse(`${date}T${time}+08:00`);
const interpretation: TickFlowStockMinuteInterpretation = {
  timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
};

function batch(tradeDate: string, marks: readonly (readonly [string, number])[], code = symbol): StoredDatedStockMinuteBatch {
  return { source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: code, assetType: "stock", tradeDate, observedAt,
    coverage: "unknown", interval: "1m", adjustment: "none", priceUnit: "provider-native", volumeUnit: "provider-native",
    amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native", finality: "unknown",
    rows: marks.map(([time, close]) => ({ sourceTimestamp: stamp(tradeDate, time), open: close, high: close,
      low: close, close, volume: 1, amount: close / 10 })),
  };
}

let root: string;
let prior: string | undefined;
beforeEach(() => {
  prior = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-tickflow-stock-replay-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

test("previews a mixed current stock batch using declared labels and optional prior-close evidence", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(stamp(first, "10:00:00"));
  const secondStock = "000001.SZ", missing = "830799.BJ", empty = "000002.SZ", stale = "600010.SH";
  const symbols = [symbol, secondStock, missing, empty, stale];
  const raw = batch(first, [["09:30:00", 9], ["09:30:59.123", 10], ["09:31:00", 10], ["09:32:00", 11]]).rows;
  raw[2]!.volume = 0;
  raw[2]!.amount = 0;
  const compact = (rows: StoredDatedStockMinuteBatch["rows"]) => ({
    timestamp: rows.map(row => row.sourceTimestamp), open: rows.map(row => row.open), high: rows.map(row => row.high),
    low: rows.map(row => row.low), close: rows.map(row => row.close), volume: rows.map(row => row.volume), amount: rows.map(row => row.amount),
  });
  const requests: URL[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("x-api-key") !== "current-list-preview-fixture") return new Response(null, { status: 403 });
    requests.push(new URL(request.url));
    return Response.json({ data: { [symbol]: compact(raw), [secondStock]: compact(raw.slice(2)), [empty]: compact([]),
      [stale]: compact(batch("2024-04-03", [["09:31:00", 12]], stale).rows) } });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "current-list-preview-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const ref = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
      priceUnit: "CNY", coverage: "unknown", requested: { startDate: first, endDate: first },
      rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const previousClose = { ref, priceBasis: "caller-confirmed-same-basis" } as const;
    const stocks = symbols.map((code, index) => ({ symbol: code, ...(index === 0 && { previousClose }) }));
    const request = { tradeDate: first, stocks, interpretation };
    await expect(previewCurrentTspListIntraday({ ...request, stocks: [{ symbol: secondStock, previousClose }] }))
      .rejects.toThrow("does not match the TickFlow stock");
    await expect(previewCurrentTspListIntraday({ ...request, interpretation: undefined })).rejects.toThrow("interpretation");
    await expect(previewCurrentTspListIntraday(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);

    const preview = await previewCurrentTspListIntraday(request);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/klines/intraday/batch");
    expect(requests[0]!.searchParams.get("symbols")).toBe(symbols.join(","));
    expect(preview.input.minutes).toMatchObject({ finality: "provisional", tradeDate: first, requestedSymbols: symbols, adjustment: "unknown",
      frames: [{ symbol, status: "observed", rows: raw }, { symbol: secondStock, status: "observed", rows: raw.slice(2) },
        { symbol: missing, status: "missing", rows: [] }, { symbol: empty, status: "empty", rows: [] },
        { symbol: stale, status: "different-session", sourceTradeDate: "2024-04-03", rows: [] }],
    });
    expect(preview.rows[0]).toMatchObject({ status: "observed", previousClose: { archiveRef: ref, rows: [{ tradeDate: first, price: 10 }] },
      metrics: { producer: "whyj", finality: "provisional", plotBaseline: { kind: "previous-close", value: 10 },
        points: [{ sourceTimestamp: raw[2]!.sourceTimestamp, minute: "09:30", close: 10, averageClose: 10, previousCloseReturnFraction: 0 },
          { sourceTimestamp: raw[3]!.sourceTimestamp, minute: "09:31", close: 11, averageClose: 10.5 }] },
      excluded: [{ sourceTimestamp: raw[0]!.sourceTimestamp, reason: "opening-boundary" },
        { sourceTimestamp: raw[1]!.sourceTimestamp, reason: "unaligned" }],
    });
    expect(preview.rows[0]?.metrics?.latestReturnFraction).toBeCloseTo(0.1, 12);
    expect(preview.rows[1]).toMatchObject({ previousClose: null, metrics: { latestReturnFraction: null,
      plotBaseline: { kind: "first-observed-open", value: 10 } } });
    expect(preview.rows.slice(2).map(row => [row.status, row.metrics])).toEqual([
      ["missing", null], ["empty", null], ["different-session", null],
    ]);

    const left = await previewCurrentTspListIntraday({ ...request, interpretation: { ...interpretation, timestampLabel: "minute-start" } });
    expect(left.rows[0]?.metrics?.points.map(point => point.minute)).toEqual(["09:30", "09:31", "09:32"]);
    const rawOnly = await previewCurrentTspListIntraday({ tradeDate: first, stocks: symbols.map(symbol => ({ symbol })) });
    expect(rawOnly.input.interpretation).toBeNull();
    expect(rawOnly.input.minutes.frames[0]?.rows).toEqual(raw);
    expect(rawOnly.rows.every(row => row.metrics === null)).toBe(true);
    expect(existsSync(join(root, "data", "dated-stock-minute-archives-v1"))).toBe(false);
    expect(requests).toHaveLength(3);
  } finally { await server.stop(true); clock.mockRestore(); }
});

test("binds current ETF charts to same-provider daily close evidence for the declared previous session", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(stamp(first, "10:00:00"));
  const etf = "510300.SH", noClose = "159915.SZ", missing = "588000.SH", oldDay = "2024-04-03";
  const symbols = [etf, noClose, missing];
  const requests: URL[] = [];
  const pack = (close: number[]) => ({
    timestamp: close.map((_, index) => stamp(first, "09:3" + (index + 1) + ":00")),
    open: close, high: close, low: close, close, volume: close.map(() => 0), amount: close.map(() => 0),
  });
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (request.headers.get("x-api-key") !== "etf-current-preview-fixture") return new Response(null, { status: 403 });
    requests.push(new URL(request.url));
    return Response.json({ data: { [etf]: pack([10, 11]), [noClose]: pack([8]) } });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "etf-current-preview-fixture", TICKFLOW_BASE_URL: provider.url.origin } });
    const row = { tradeDate: oldDay, sourceTimestamp: stamp(oldDay, "15:00:00"), open: 10, high: 10, low: 10, close: 10, volume: 1, amount: null };
    const daily: StoredDatedEtfDailyBatch = { symbol: etf, market: "A", assetType: "etf", source: "tickflow", endpoint: "/v1/klines",
      requested: { start: oldDay, end: oldDay }, observedAt: "2024-04-08T01:00:00Z", coverage: "unknown", interval: "1d",
      adjustment: "none", priceUnit: "unknown", volumeUnit: "unknown", amountUnit: "unknown", timeZone: "Asia/Shanghai", rows: [row] };
    const dailyRef = await archiveDatedEtfDailyBars(daily);
    const noCloseRef = await archiveDatedEtfDailyBars({ ...daily, symbol: noClose, rows: [] });
    const incompatible = await archiveDatedEtfDailyBars({ ...daily, source: "tushare", endpoint: "fund_daily",
      priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [{ ...row, sourceTimestamp: null }] });
    const previousClose = { dailyRef, priceBasis: "caller-confirmed-same-basis",
      calendar: { revision: "fixture-shanghai-session", previousTradeDate: oldDay, tradeDate: first } } as const;
    const etfs = [{ symbol: " 510300.sh ", previousClose }, { symbol: noClose, previousClose: { ...previousClose, dailyRef: noCloseRef } },
      { symbol: missing }];
    const choice = { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY" } as const;
    const request = { tradeDate: first, etfs, interpretation: choice };
    await expect(previewCurrentTspEtfIntraday({ ...request, etfs: [{ symbol }] })).rejects.toThrow("symbols");
    await expect(previewCurrentTspEtfIntraday({ ...request, interpretation: undefined })).rejects.toThrow("interpretation");
    for (const prior of [dailyRef, incompatible]) {
      await expect(previewCurrentTspEtfIntraday({ ...request, etfs: [{ symbol: prior === dailyRef ? noClose : etf,
        previousClose: { ...previousClose, dailyRef: prior } }] })).rejects.toThrow("archive");
    }
    for (const previousTradeDate of [first, "2024-04-02"]) {
      await expect(previewCurrentTspEtfIntraday({ ...request, etfs: [{ symbol: etf,
        previousClose: { ...previousClose, calendar: { ...previousClose.calendar, previousTradeDate } } }] })).rejects.toThrow();
    }
    expect(requests).toHaveLength(0);
    const preview = await previewCurrentTspEtfIntraday(request);
    expect(preview.input.minutes).toMatchObject({ assetType: "etf", source: "tickflow", finality: "provisional", adjustment: "unknown",
      requestedSymbols: symbols, frames: [{ symbol: etf, status: "observed" }, { symbol: noClose, status: "observed" },
        { symbol: missing, status: "missing", rows: [] }] });
    expect(preview.rows[0]).toMatchObject({ previousClose: { dailyRef, row, priceUnit: "unknown" },
      metrics: { producer: "whyj", finality: "provisional", latestReturnFraction: 11 / 10 - 1, points: [
        { minute: "09:30", averageClose: 10, previousCloseReturnFraction: 0 },
        { minute: "09:31", averageClose: 10.5, previousCloseReturnFraction: 11 / 10 - 1 },
      ] } });
    expect(preview.rows[1]).toMatchObject({ previousClose: { row: null }, metrics: { latestReturnFraction: null } });
    expect(preview.rows[2]).toMatchObject({ status: "missing", metrics: null });
    const raw = await previewCurrentTspEtfIntraday({ tradeDate: first, etfs: symbols.map(symbol => ({ symbol })) });
    expect(raw.input.interpretation).toBeNull();
    expect(raw.rows.every(row => row.metrics === null)).toBe(true);
    expect(requests.map(url => [url.pathname, url.searchParams.get("symbols")])).toEqual([
      ["/v1/klines/intraday/batch", symbols.join(",")], ["/v1/klines/intraday/batch", symbols.join(",")],
    ]);
  } finally { await provider.stop(true); clock.mockRestore(); }
});

test("reads one optional later quote batch and keeps both stock and ETF minute evidence intact", async () => {
  let time = stamp(first, "09:31:20");
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const etf = "510300.SH", stale = "000001.SZ";
  const providerCalls: URL[] = [];
  let failQuotes = false;
  let omitSecondQuote = false;
  const minuteEpoch = stamp(first, "09:31:00");
  const ticks = { [symbol]: stamp(first, "09:31:45"), [etf]: stamp(first, "09:32:20"), [stale]: stamp(first, "09:31:10") };
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("x-api-key") !== "tsp-tail-runtime-fixture") return new Response(null, { status: 403 });
    const url = new URL(request.url);
    providerCalls.push(url);
    const symbols = url.searchParams.get("symbols")!.split(",");
    if (url.pathname === "/v1/klines/intraday/batch") {
      time = stamp(first, "09:31:20");
      return Response.json({ data: Object.fromEntries(symbols.map(symbol => [symbol, {
        timestamp: [minuteEpoch], open: [10], high: [11], low: [10], close: [11], volume: [0], amount: [0],
      }])) });
    }
    expect(url.pathname).toBe("/v1/quotes");
    time = symbols.includes(etf) ? stamp(first, "09:32:25") : stamp(first, "09:31:55");
    if (failQuotes) return new Response("fixture unavailable", { status: 403 });
    const quotedSymbols = omitSecondQuote ? symbols.slice(0, 1) : symbols;
    return Response.json({ data: quotedSymbols.map(symbol => ({ symbol, region: "CN", timestamp: ticks[symbol as keyof typeof ticks],
      last_price: 12, prev_close: 10, open: 10, high: 12, low: 10, volume: 300, amount: 3_000 })) });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "tsp-tail-runtime-fixture", TICKFLOW_BASE_URL: source.url.origin } });
    const quoteTail = { maxAgeMs: 60_000, priceBasis: "caller-confirmed-same-basis" } as const;
    const stockRequest = { tradeDate: first, stocks: [{ symbol }, { symbol: stale }],
      interpretation: { timestampLabel: "minute-start", priceBasis: "caller-confirmed-unadjusted-CNY" } } as const;
    await expect(previewCurrentTspListIntraday({ ...stockRequest, quoteTail, interpretation: undefined })).rejects.toThrow("price basis");
    await expect(previewCurrentTspListIntraday({ ...stockRequest, quoteTail: { ...quoteTail, maxAgeMs: -1 } })).rejects.toThrow("quote age");
    expect(providerCalls).toHaveLength(0);
    const baseStock = await previewCurrentTspListIntraday(stockRequest);
    expect(providerCalls.map(url => url.pathname)).toEqual(["/v1/klines/intraday/batch"]);
    expect(baseStock.input).not.toHaveProperty("quoteTail");

    const stock = await previewCurrentTspListIntraday({ ...stockRequest, quoteTail });
    expect(stock.input.minutes.frames).toEqual(baseStock.input.minutes.frames);
    expect(stock.input.quoteTail).toMatchObject({ status: "observed", source: "tickflow", units: "unknown",
      data: [{ symbol, timestamp: ticks[symbol], lastPrice: 12, volume: 300, amount: 3_000 }, { symbol: stale }] });
    expect(stock.rows[0]).toMatchObject({ quoteTail: { producer: "whyj", status: "updated", applied: { price: 12, finality: "provisional" } },
      metrics: { points: [{ minute: "09:31", close: 12, averageClose: 12, sourceTimestamp: ticks[symbol], priceSource: "quote" }] } });
    expect(stock.rows[1]).toMatchObject({ quoteTail: { status: "unchanged", reason: "covered" }, metrics: { points: [{ close: 11 }] } });

    const fund = await previewCurrentTspEtfIntraday({ tradeDate: first, etfs: [{ symbol: etf }], quoteTail,
      interpretation: { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY" } });
    expect(fund.input.minutes).toMatchObject({ assetType: "etf", frames: [{ symbol: etf, rows: [{ close: 11, volume: 0, amount: 0 }] }] });
    expect(fund.rows[0]).toMatchObject({ quoteTail: { status: "appended", applied: { price: 12, finality: "provisional" } },
      metrics: { points: [
        { minute: "09:30", close: 11, sourceTimestamp: minuteEpoch },
        { minute: "09:32", close: 12, averageClose: 11.5, sourceTimestamp: ticks[etf], priceSource: "quote" },
      ] } });

    omitSecondQuote = true;
    const oldOrMissing = await previewCurrentTspListIntraday({ ...stockRequest, quoteTail: { ...quoteTail, maxAgeMs: 5_000 } });
    expect(oldOrMissing.input.quoteTail).toMatchObject({ status: "observed", missingSymbols: [stale] });
    expect(oldOrMissing.rows[0]?.quoteTail).toMatchObject({ status: "unchanged", reason: "stale-quote" });
    expect(oldOrMissing.rows[1]?.quoteTail).toMatchObject({ status: "unchanged", reason: "missing-quote" });
    expect(oldOrMissing.rows.map(row => row.metrics)).toEqual(baseStock.rows.map(row => row.metrics));

    failQuotes = true;
    const degraded = await previewCurrentTspListIntraday({ ...stockRequest, quoteTail });
    expect(degraded.input.quoteTail).toMatchObject({ status: "unavailable" });
    expect(degraded.rows[0]?.metrics).toEqual(baseStock.rows[0]?.metrics);
    expect(providerCalls.slice(1).map(url => url.pathname)).toEqual(
      Array.from({ length: 4 }).flatMap(() => ["/v1/klines/intraday/batch", "/v1/quotes"]),
    );
    expect(providerCalls[2]!.searchParams.get("symbols")).toBe([symbol, stale].join(","));
    expect(providerCalls[4]!.searchParams.get("symbols")).toBe(etf);
  } finally { await source.stop(true); clock.mockRestore(); }
});

test("collects native TickFlow minute bars and archives a valid empty response with the same scope", async () => {
  const count = { calls: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/klines");
    expect(url.searchParams.get("symbol")).toBe(symbol);
    expect(url.searchParams.get("adjust")).toBe("none");
    expect(request.headers.get("x-api-key")).toBe("stock-minute-fixture");
    return Response.json({ data: count.calls++ === 0 ? { symbol, timestamp: [stamp(first, "09:31:00")],
      open: [10], high: [11], low: [9], close: [10], volume: [0], amount: [0] }
      : { symbol, timestamp: [], open: [], high: [], low: [], close: [], volume: [] } });
  } });
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "stock-minute-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const collected = await collectDatedTickFlowStockMinutes({ symbol, tradeDate: first });
    const empty = await collectDatedTickFlowStockMinutes({ symbol, tradeDate: second });
    expect(count.calls).toBe(2);
    expect(collected).toMatchObject({ symbol, tradeDate: first, status: "archived", rowCount: 1, ref: { kind: "dated-stock-minute" } });
    expect(empty).toMatchObject({ symbol, tradeDate: second, status: "empty", rowCount: 0, ref: { kind: "dated-stock-minute" } });
    expect(await loadDatedStockMinuteArchive(collected.ref)).toMatchObject({
      volumeUnit: "provider-native", finality: "unknown", rows: [{ sourceTimestamp: stamp(first, "09:31:00"), volume: 0, amount: 0 }],
    });
    expect(await loadDatedStockMinuteArchive(empty.ref)).toMatchObject({ symbol, tradeDate: second, rows: [] });
    expect(await replayTspTickFlowStockMinutes({ refs: [empty.ref], interpretation })).toMatchObject({ rows: [], excluded: [] });
    await expect(collectDatedTickFlowStockMinutes({ symbol, tradeDate: first }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(count.calls).toBe(2);
  } finally { await server.stop(true); }
});

test("reconstructs aligned TickFlow features and alerts with their native epochs and explicit price and unit basis", async () => {
  const raw = batch(first, [["09:30:00", 99], ["09:30:59.123", 88], ["09:31:00", 9], ["09:32:00", 11], ["13:00:00", 80], ["15:00:00", 12]]);
  const ref = await archiveDatedStockMinutes(raw);
  const next = await archiveDatedStockMinutes(batch(second, [["09:31:00", 10], ["09:32:00", 11]]));
  const previousRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
    priceUnit: "CNY", coverage: "unknown", requested: { startDate: first, endDate: second },
    rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }] });
  const previousClose = { ref: previousRef, priceBasis: "caller-confirmed-same-basis" } as const;
  const history = { refs: [ref, next], interpretation, previousClose };
  const preview = await replayTspTickFlowStockMinutes(history);
  expect(preview).toMatchObject({ producer: "whyj", input: { symbol, source: "tickflow", interpretation,
    archives: [{ ref, rowCount: 6 }, { ref: next, rowCount: 2 }],
    previousClose: { archiveRef: previousRef, source: "tushare", rows: [{ tradeDate: first, price: 10 }, { tradeDate: second, price: null }] },
  } });
  expect(preview.rows.map(row => [row.tradingDate, row.minute])).toEqual([
    [first, "09:30"], [first, "09:31"], [first, "14:59"], [second, "09:30"], [second, "09:31"],
  ]);
  expect(preview.excluded).toEqual([
    { tradeDate: first, sourceTimestamp: stamp(first, "09:30:00"), reason: "opening-boundary" },
    { tradeDate: first, sourceTimestamp: stamp(first, "09:30:59.123"), reason: "unaligned" },
    { tradeDate: first, sourceTimestamp: stamp(first, "13:00:00"), reason: "outside-session" },
  ]);
  expect(preview.rows[1]).toMatchObject({ sourceTimestamp: stamp(first, "09:32:00"), values: { price: 11, vwap: 10 },
    signals: { signal_intraday_zero_cross_up: true, signal_intraday_avg_cross_up: true } });
  expect(preview.rows[4]?.values.pct_vs_prev_close).toBeNull();
  expect(await loadDatedStockMinuteArchive(ref)).toEqual(raw);

  const rule: IntradayMonitorAlertReplayRequest["rule"] = { id: "tickflow_cross", revision: "v1", type: "signal", assetType: "stock",
    scope: { kind: "all" }, logic: "and", cooldownMs: 0, severity: "warn", conditions: [
      { field: "signal_intraday_zero_cross_up", op: "truth" }, { field: "csgi_cross_ten", op: "truth" },
      { field: "volume", op: ">=", unit: "share", value: 100 },
    ] };
  const request: IntradayMonitorAlertReplayRequest = { rule, histories: [{ symbol, ...history }], roster: [symbol],
    slots: ["09:30", "09:31", "09:32"].map(minute => ({ tradeDate: first, minute })),
    customSignals: [{ id: "cross_ten", conditions: [{ left: "price", op: "cross_up", right: 10 }] }] };
  const report = await replayTspIntradayMonitorAlerts(request);
  expect(report.evaluations.map(row => row.events.length)).toEqual([0, 1, 0]);
  const event = report.evaluations[1]?.events[0];
  expect(event).toMatchObject({ symbol, sourceTimestamp: stamp(first, "09:32:00"),
    operands: { volume: 100, signal_intraday_zero_cross_up: true, csgi_cross_ten: true },
    eventId: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(await replayTspIntradayMonitorAlerts(request)).toEqual(report);
  const leftEdge = await replayTspIntradayMonitorAlerts({ ...request,
    histories: [{ symbol, ...history, interpretation: { ...interpretation, timestampLabel: "minute-start" } }] });
  expect(leftEdge.evaluations.map(row => row.events.length)).toEqual([0, 0, 1]);
  expect(leftEdge.evaluations[2]?.events[0]?.eventId).not.toBe(event?.eventId);

  const unknown = { timestampLabel: "minute-end", priceBasis: interpretation.priceBasis } as const;
  expect((await replayTspTickFlowStockMinutes({ ...history, interpretation: unknown })).rows[1]?.values)
    .toMatchObject({ price: 11, vwap: null, vol_ratio_1m_today: null });
  expect((await replayTspIntradayMonitorAlerts({ ...request, histories: [{ symbol, ...history, interpretation: unknown }] }))
    .evaluations[1]?.events).toEqual([]);
  await expect(replayTspTickFlowStockMinutes({ ...history, refs: [next, ref] })).rejects.toThrow("strictly increasing dates");
  const foreign = await archiveDatedStockMinutes(batch(second, [], "600002.SH"));
  await expect(replayTspTickFlowStockMinutes({ ...history, refs: [ref, foreign] })).rejects.toThrow("one stock");
  await expect(replayTspTickFlowStockMinutes({ ...history, refs: [ref, ref] })).rejects.toThrow("references or interpretation");
  await expect(replayTspTickFlowStockMinutes(history, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("binds stock-list intraday charts to the exact minute and previous-close archives", async () => {
  const meta = { tradeDate: first, observedAt, coverage: "unknown" } as const;
  const marketRef = await archiveMarketCrossSection({
    market: "A", source: "tushare", tradeDate: first,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "Fixture", listedOn: null, industry: null }] },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
      amountUnit: "CNY-thousand", rows: [] },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const raw = batch(first, [["09:30:00", 99], ["09:30:59.123", 88], ["09:31:00", 9], ["09:33:00", 10]]);
  raw.rows[2]!.volume = 0;
  raw.rows[2]!.amount = null;
  const ref = await archiveDatedStockMinutes(raw);
  const priorRef = await archiveDailyTradingLimits({
    symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt,
    coverage: "unknown", priceUnit: "CNY", requested: { startDate: first, endDate: first },
    rows: [{ tradeDate: first, previousClose: 10, limitUp: 11, limitDown: 9 }],
  });
  const withoutUnits = { timestampLabel: "minute-end", priceBasis: interpretation.priceBasis } as const;
  const request = {
    marketRef, adjustment: "forward" as const, stocks: [{ symbol, intraday: { ref, interpretation: withoutUnits,
      previousClose: { ref: priorRef, priceBasis: "caller-confirmed-same-basis" as const } } }],
  };
  const chart = await replayTspListRows(request);
  expect(chart.rows[0]?.observations.intraday).toMatchObject({
    ...raw, ref, interpretation: { ...withoutUnits, volumeUnit: "unknown", amountUnit: "unknown" },
    previousClose: { archiveRef: priorRef, rows: [{ tradeDate: first, price: 10 }] },
    excluded: [
      { tradeDate: first, sourceTimestamp: stamp(first, "09:30:00"), reason: "opening-boundary" },
      { tradeDate: first, sourceTimestamp: stamp(first, "09:30:59.123"), reason: "unaligned" },
    ],
  });
  expect(chart.rows[0]?.metrics.intraday).toMatchObject({
    producer: "whyj", formula: { id: "tsp_list_intraday", version: 1 }, plotBaseline: { kind: "previous-close", value: 10 },
    latestReturnFraction: 0, points: [
      { minute: "09:30", sourceTimestamp: stamp(first, "09:31:00"), close: 9, averageClose: 9, previousCloseReturnFraction: 9 / 10 - 1 },
      { minute: "09:32", sourceTimestamp: stamp(first, "09:33:00"), close: 10, averageClose: 9.5, previousCloseReturnFraction: 0 },
    ],
  });
  expect(await replayTspListRowsWithLiveQuotes(request)).toEqual({ fixed: chart, quotes: { status: "outside-current-day" } });

  const read = (revision: typeof ref) => replayTspListRows({ ...request, stocks: [{
    symbol, intraday: { ref: revision, interpretation: withoutUnits },
  }] });
  const missingPrior = await read(ref);
  expect(missingPrior.rows[0]?.metrics.intraday).toMatchObject({
    plotBaseline: { kind: "first-observed-open", value: 9 }, latestReturnFraction: null,
  });
  const empty = await read(await archiveDatedStockMinutes(batch(first, [])));
  expect(empty.rows[0]?.observations.intraday).toMatchObject({ rows: [], rowCount: 0 });
  expect(empty.rows[0]?.metrics.intraday).toMatchObject({ plotBaseline: null, points: [] });

  const legacy = await replayTspListRows({ ...request, stocks: [{ symbol }] });
  expect(legacy.rows[0]?.observations).not.toHaveProperty("intraday");
  expect(legacy.rows[0]?.metrics).not.toHaveProperty("intraday");
  await expect(read(await archiveDatedStockMinutes(batch(second, [])))).rejects.toThrow("symbol or trading date");
  await expect(read(await archiveDatedStockMinutes(batch(first, [], "600002.SH")))).rejects.toThrow("symbol or trading date");
  await expect(replayTspListRows(request, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ObservationCurrentStockMinutesPreview } from "../src/client/contract";
import { CurrentMinuteResult, currentMinutesManifest, ObservationCurrentMinutes } from "../src/components/ObservationCurrentStockMinutes";

const tradeDate = "2024-04-08", symbol = "600001.SH";
const revision = "b".repeat(64);
const timestamp = Date.parse("2024-04-08T09:31:00+08:00");
const interpretation = { timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY" } as const;

test("reads the exact CLI manifest and adapts prior-close evidence for the Host", () => {
  const clock = spyOn(Date, "now").mockReturnValue(timestamp);
  try {
    const raw = { version: 1, tradeDate, stocks: [{ symbol: " 600001.sh " }, { symbol: "000001.SZ" }] };
    const previousClose = { revision, priceBasis: "caller-confirmed-same-basis" };
    expect(currentMinutesManifest(raw)).toEqual({ tradeDate, stocks: [{ symbol }, { symbol: "000001.SZ" }] });
    const withClose = { ...raw, interpretation, stocks: [{ symbol, previousClose }] };
    expect(currentMinutesManifest(withClose)).toEqual({ tradeDate, interpretation, stocks: [{
      symbol, previousClose: { ref: { version: 1, kind: "daily-trading-limits", revision }, priceBasis: "caller-confirmed-same-basis" },
    }] });
    for (const invalid of [
      { ...raw, tradeDate: "2024-04-09" }, { ...raw, stocks: [] },
      { ...raw, stocks: [raw.stocks[0], { symbol }] }, { ...withClose, interpretation: undefined },
      { ...withClose, stocks: [{ symbol, previousClose: { ...previousClose, revision: "../invalid" } }] },
      { ...withClose, interpretation: { ...interpretation, amountUnit: "CNY" } },
      { ...raw, source: "tickflow" },
    ]) expect(() => currentMinutesManifest(invalid)).toThrow("清单需要");
  } finally { clock.mockRestore(); }
});

test("adapts the current ETF CLI manifest to the ETF Host method", () => {
  const clock = spyOn(Date, "now").mockReturnValue(timestamp);
  try {
    const etf = "510300.SH";
    const raw = { version: 1, tradeDate, etfs: [{ symbol: " 510300.sh " }, { symbol: "159915.SZ" }] };
    expect(currentMinutesManifest(raw)).toEqual({ tradeDate, etfs: [{ symbol: etf }, { symbol: "159915.SZ" }] });
    const calendar = { revision: "fixture-calendar", previousTradeDate: "2024-04-03", tradeDate };
    const previousClose = { dailyRevision: revision, calendar, priceBasis: "caller-confirmed-same-basis" } as const;
    const chart = { ...raw, interpretation, etfs: [{ symbol: etf, previousClose }] };
    expect(currentMinutesManifest(chart)).toEqual({ tradeDate, interpretation, etfs: [{
      symbol: etf, previousClose: { dailyRef: { version: 1, kind: "dated-etf-daily", revision }, calendar, priceBasis: previousClose.priceBasis },
    }] });
    for (const invalid of [
      { ...raw, stocks: [{ symbol }] }, { ...raw, etfs: [{ symbol }] }, { ...raw, etfs: [{ symbol: "159900.SZ" }] },
      { ...raw, etfs: [...raw.etfs, { symbol: etf }] }, { ...chart, interpretation: undefined },
      { ...chart, etfs: [{ symbol: etf, previousClose: { ...previousClose, calendar: { ...calendar, previousTradeDate: "2024-02-31" } } }] },
    ]) expect(() => currentMinutesManifest(invalid)).toThrow("清单需要");
  } finally { clock.mockRestore(); }
});

test("validates quote-tail opt-in for both stock and ETF manifests before dispatch", () => {
  const clock = spyOn(Date, "now").mockReturnValue(timestamp);
  try {
    const quoteTail = { maxAgeMs: 0, priceBasis: "caller-confirmed-same-basis" } as const;
    for (const target of [{ stocks: [{ symbol }] }, { etfs: [{ symbol: "510300.SH" }] }]) {
      const manifest = { version: 1, tradeDate, ...target, interpretation, quoteTail };
      expect(currentMinutesManifest(manifest)).toEqual({ tradeDate, ...target, interpretation, quoteTail });
      for (const invalid of [
        { ...manifest, interpretation: undefined },
        { ...manifest, quoteTail: null },
        { ...manifest, quoteTail: { ...quoteTail, maxAgeMs: -1 } },
        { ...manifest, quoteTail: { ...quoteTail, maxAgeMs: 1.5 } },
        { ...manifest, quoteTail: { ...quoteTail, priceBasis: "unknown" } },
        { ...manifest, quoteTail: { ...quoteTail, extra: true } },
      ]) expect(() => currentMinutesManifest(invalid)).toThrow("报价续写配置");
    }
  } finally { clock.mockRestore(); }
});

test("displays native frames and provisional chart evidence, including a zero return", () => {
  const missing = "000001.SZ", empty = "830799.BJ";
  const result: ObservationCurrentStockMinutesPreview = {
    input: { interpretation, minutes: { source: "tickflow", endpoint: "/v1/klines/intraday/batch", market: "A", observedAt: "2024-04-08T02:00:00Z",
      assetType: "stock", tradeDate, interval: "1m", adjustment: "unknown", finality: "provisional", coverage: "unknown",
      priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native", timestampLabel: "provider-native", timeZone: "Asia/Shanghai",
      requestedSymbols: [symbol, missing, empty], rowLimitPerSymbol: 300, frames: [
        { symbol, status: "observed", sourceTradeDate: tradeDate,
          rows: [{sourceTimestamp: timestamp, open: 10, high: 10, low: 10, close: 10, volume: 0, amount: 0}] },
        { symbol: missing, status: "missing", sourceTradeDate: null, rows: [] },
        { symbol: empty, status: "empty", sourceTradeDate: null, rows: [] },
      ] } },
    rows: [{ symbol, status: "observed", previousClose: null, excluded: [], metrics: {
      producer: "whyj", finality: "provisional", tradeDate, formula: { id: "tsp_list_intraday", version: 1, revision },
      latestReturnFraction: 0, plotBaseline: { kind: "previous-close", value: 10 },
      points: [{ minute: "09:30", sourceTimestamp: timestamp, close: 10, averageClose: 10, previousCloseReturnFraction: 0 }],
    } }, { symbol: missing, status: "missing", previousClose: null, excluded: [], metrics: null },
    { symbol: empty, status: "empty", previousClose: null, excluded: [], metrics: null }],
  };
  const markup = renderToStaticMarkup(<CurrentMinuteResult result={result} />);
  for (const text of ["TickFlow 原始分钟帧", "供应商返回空帧", "供应商未返回该标的", "供应商单位",
    "WHYJ 临时分时指标", "WHYJ 分时收盘和累计均价", "0%", "累计均价", "tsp_list_intraday"]) expect(markup).toContain(text);
  expect(markup).not.toContain("暂无昨收收益");
  expect(markup).not.toContain("TickFlow 报价观测");
  const age = { maxAgeMs: 60_000, priceBasis: "caller-confirmed-same-basis", asOf: timestamp + 45_000 } as const;
  const price = { symbol, timestamp: timestamp + 30_000, lastPrice: 12, previousClose: 10, open: 10, high: 12, low: 10, volume: 123, amount: 1300 };
  const receipt = { ...age, status: "observed", source: "tickflow", endpoint: "/v1/quotes", units: "unknown",
    observedAt: "2024-04-08T01:31:45Z", data: [price], missingSymbols: [missing, empty] } as const;
  const projection = { producer: "whyj", formula: { id: "tsp_list_quote_tail", version: 1, revision }, symbol, tradeDate,
    frameObservedAt: timestamp, asOf: age.asOf } as const;
  const row = result.rows[0]!;
  const chart = row.metrics!;
  const withReceipt = { ...result.input, quoteTail: { ...receipt, data: [price], missingSymbols: [missing, empty] } };
  const fresh = renderToStaticMarkup(<CurrentMinuteResult result={{
    input: withReceipt, rows: [{
      ...row,
      quoteTail: { ...projection, status: "appended", applied: {
        quoteTimestamp: price.timestamp, price: price.lastPrice, minute: "09:31", finality: "provisional",
      } },
      metrics: { ...chart, points: [...chart.points, { minute: "09:31", sourceTimestamp: price.timestamp, priceSource: "quote",
        close: 12, averageClose: 11, previousCloseReturnFraction: 0.2 }] },
    }, ...result.rows.slice(1)],
  }} />);
  for (const text of ["TickFlow 原始分钟帧", "TickFlow 报价观测", "累计成交量 123", "收盘 12", "报价临时续写"]) {
    expect(fresh).toContain(text);
  }
  const stale = renderToStaticMarkup(<CurrentMinuteResult result={{
    input: withReceipt, rows: [{ ...row, quoteTail: { ...projection, status: "unchanged", reason: "stale-quote", applied: null } },
      ...result.rows.slice(1)],
  }} />);
  expect(stale).toContain("报价已过期，沿用原始分钟帧");
  expect(stale).toContain("收盘 10");
  expect(stale).not.toContain("报价临时续写");
  for (const quoteTail of [
    { ...age, status: "unavailable" as const }, { ...withReceipt.quoteTail, status: "empty" as const, data: [] },
  ]) {
    const fallback = renderToStaticMarkup(<CurrentMinuteResult result={{ ...result, input: { ...result.input, quoteTail } }} />);
    expect(fallback).toContain(quoteTail.status === "unavailable" ? "暂不可用" : "该标的无报价");
    expect(fallback).toContain("WHYJ 临时分时指标");
    expect(fallback).not.toContain("报价临时续写");
  }
  const rawOnly = renderToStaticMarkup(<CurrentMinuteResult result={{ ...result, input: { ...result.input, interpretation: null },
    rows: result.rows.map(row => ({ ...row, metrics: null })) }} />);
  expect(rawOnly).toContain("TickFlow 原始分钟帧");
  expect(rawOnly).not.toContain("WHYJ 临时分时指标");
  const etfs = ["510300.SH", "159915.SZ", "588000.SH"];
  const etfOnly = renderToStaticMarkup(<CurrentMinuteResult result={{
    input: { ...result.input, minutes: { ...result.input.minutes, assetType: "etf", requestedSymbols: etfs,
      frames: result.input.minutes.frames.map((frame, index) => ({ ...frame, symbol: etfs[index]! })) } },
    rows: result.rows.map((row, index) => ({ ...row, symbol: etfs[index]!, previousClose: null })),
  }} />);
  expect(etfOnly).toContain("查看 ETF");
  expect(etfOnly).toContain("较昨收");
  expect(renderToStaticMarkup(<ObservationCurrentMinutes readStock={undefined} />)).toContain("当前服务不支持当日分时");
});

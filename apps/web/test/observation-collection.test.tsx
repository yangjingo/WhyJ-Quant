import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ObservationCollection, ObservationIndicatorResult, observationRequest, type CollectionFields } from "../src/components/ObservationCollection";
import { IntradayIndicatorResult } from "../src/components/ObservationIntraday";
import type { ObservationIndicatorPreview, ObservationIntradayPreview, WorkbenchClient } from "../src/client/contract";
import { TSP_DAILY_INDICATOR_FIELDS } from "../../../src/source/src/tsp-list-catalog.ts";

const base: CollectionFields = { dataset: "daily", symbol: "600000.SH", start: "2026-11-12", end: "2026-11-12", adjustment: "none", interval: "1m" };
test("uses Shanghai days and builds exact Host requests", () => {
  const startTime = Date.parse("2026-11-12T00:00:00+08:00"), endTime = Date.parse("2026-11-12T23:59:59.999+08:00");
  expect(observationRequest(base)).toEqual({ dataset: "daily", symbol: "600000.SH", startTime, endTime, adjustment: "none" });
  expect(observationRequest({ ...base, dataset: "minute", interval: "5m", adjustment: "forward" })).toEqual({ dataset: "minute", symbol: "600000.SH", startTime, endTime, adjustment: "forward", interval: "5m" });
  expect(observationRequest({ ...base, dataset: "factor" })).toEqual({ dataset: "factor", symbol: "600000.SH", startTime, endTime });
  expect(observationRequest({ ...base, dataset: "daily-date" })).toEqual({ dataset: "daily", timeMode: "trading-date", symbol: "600000.SH", startDate: "2026-11-12", endDate: "2026-11-12", adjustment: "none" });
});
test("rejects invalid dates, symbol, inverted and oversized windows", () => {
  for (const change of [{ symbol: "600000" }, { start: "2026-02-30" }, { start: "2026-11-13" }, { dataset: "minute" as const, start: "2026-10-01" }]) expect(observationRequest({ ...base, ...change })).toBeNull();
  for (const change of [{ start: "2026-02-30" }, { start: "2026-11-13" }, { start: "2025-11-11" }, { start: "0000-01-01" }, { end: "9999-12-31" }]) expect(observationRequest({ ...base, dataset: "daily-date", ...change })).toBeNull();
  expect(observationRequest({ ...base, dataset: "daily-date", start: "2025-11-12" })).not.toBeNull();
});

test("submits a bounded past historical-minute window in date mode", () => {
  const intraday: CollectionFields = { ...base, dataset: "historical-minute-bars", start: "2024-01-02", end: "2024-02-01" };
  expect(observationRequest(intraday)).toEqual({ dataset: "historical-minute-bars", symbol: "600000.SH",
    startDate: "2024-01-02", endDate: "2024-02-01" });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format();
  for (const change of [{ end: "2024-02-02" }, { end: "2024-01-01" }, { start: "2009-12-31" },
    { start: "2024-02-30" }, { symbol: "000300.SH" }, { start: today, end: today }]) {
    expect(observationRequest({ ...intraday, ...change })).toBeNull();
  }
});
test("reports unsupported host without exposing collection controls", () => {
  const html = renderToStaticMarkup(<ObservationCollection client={{ mode: "host" } as WorkbenchClient} />);
  expect(html).toContain("当前连接不支持行情采集"); expect(html).not.toContain("开始采集");
});
test("offers both explicit daily modes when the Host exposes collection", () => {
  const client = { startObservationJob() {}, readObservationJob() {}, cancelObservationJob() {}, readObservationIndicators() {} } as unknown as WorkbenchClient;
  const html = renderToStaticMarkup(<ObservationCollection client={client} />);
  expect(html).toContain("日 K（按时间）"); expect(html).toContain("日 K（按交易日）");
  expect(html).toContain("历史分时指标");
  expect(html).not.toContain("预览日线指标");
});

test("renders all daily fields with provenance, percentages, and distinct missing and zero values", () => {
  const date = "2026-11-12", revision = "f".repeat(40);
  const legacy: ObservationIndicatorPreview = {
    archiveRef: { version: 2, revision: "a".repeat(64) }, formula: { version: 1, revision },
    input: { symbol: "600000.SH", source: "tickflow", endpoint: "/v1/klines", observedAt: "2026-11-13T00:00:00.000Z",
      calendarTimeZone: "Asia/Shanghai", adjustment: "forward", requested: { startDate: date, endDate: date },
      coverage: "unknown", firstTradeDate: date, lastTradeDate: date, finality: "unknown" },
    rows: [{ date, rsi6: 0, rsi14: 0, rsi24: 0, atr14: 3 }],
  };
  const values = Object.fromEntries(TSP_DAILY_INDICATOR_FIELDS.map(key => [key, 0 as number | null]));
  values.ma5 = null;
  values.change_pct = 0.0125;
  const current: ObservationIndicatorPreview = { ...legacy, daily: { producer: "whyj",
    formula: { id: "tsp_daily_ohlcv", version: 1, revision }, fields: TSP_DAILY_INDICATOR_FIELDS, rows: [{ date, values }] } };
  const html = renderToStaticMarkup(<ObservationIndicatorResult result={current} />);
  expect(html.match(/<dt>/g)).toHaveLength(37);
  expect(html).toContain("<dt>MA 5</dt><dd>暂无</dd>");
  expect(html).toContain("<dt>RSI 14</dt><dd>0</dd>");
  expect(html).toContain("<dt>涨跌幅</dt><dd>1.25%</dd>");
  expect(html).toContain("数据源 tickflow");
  expect(html).toContain("WhyJ 计算");
  const old = renderToStaticMarkup(<ObservationIndicatorResult result={legacy} />);
  expect(old.match(/<dt>/g)).toHaveLength(4);
  expect(old).toContain("<dt>ATR 14</dt><dd>3.00</dd>");
});

const sample: ObservationIntradayPreview = {
  archiveRef: { version: 1, kind: "historical-minute-bars", revision: "a".repeat(64) },
  tradeDate: "2024-01-02", producer: "whyj", formula: { id: "tsp_intraday", version: 1, revision: "b".repeat(40) },
  input: { source: "tushare", endpoint: "stk_mins", market: "A", symbol: "600000.SH", adjustment: "unknown",
    observedAt: "2024-01-03T00:00:00Z", coverage: "unknown", finality: "unknown", timeZone: "Asia/Shanghai",
    interval: "1m", volumeUnit: "share", amountUnit: "CNY", requested: { startDate: "2024-01-02", endDate: "2024-01-03" },
    labelConvention: "tushare-stk-mins-end-time-v1", previousClose: null },
  openingBoundaries: [{ tradeTime: "2024-01-02 09:30:00", openingBoundary: true, open: 10, high: 10, low: 10, close: 10, volume: 0, amount: null }],
  rows: [{
    tradingDate: "2024-01-02", minute: "09:30", originalTradeTime: "2024-01-02 09:31:00",
    values: { price: 10, vwap: null, pct_vs_prev_close: null, pct_from_open: 0, vol_ratio_1m_today: 2,
      vol_ratio_3m_today: null, vol_ratio_5m_today: null, day_high_dist: 0, day_low_dist: 0,
      open_30m_high_dist: null, open_30m_low_dist: null },
    signals: { signal_intraday_avg_cross_up: false, signal_intraday_avg_cross_down: true,
      signal_intraday_zero_cross_up: null, signal_intraday_zero_cross_down: null },
  }],
};

test("renders every intraday indicator, crossing and opening-boundary evidence", () => {
  const output = renderToStaticMarkup(<IntradayIndicatorResult result={sample} minute="09:30" />);
  expect(output.match(/<dt>/g)).toHaveLength(15);
  expect(output).toContain("<dt>较开盘</dt><dd>0%</dd>");
  expect(output).toContain("<dt>当日成交均价</dt><dd>暂无</dd>");
  expect(output).toContain("<dt>1 分钟量比</dt><dd>2×</dd>");
  expect(output).toContain("<dt>上穿成交均价</dt><dd>未命中</dd>");
  expect(output).toContain("<dt>下穿成交均价</dt><dd>命中</dd>");
  expect(output).toContain("<dt>上穿昨收零轴</dt><dd>暂无</dd>");
  expect(output).toContain("原始时间 2024-01-02 09:31:00");
  expect(output).toContain("开盘边界 2024-01-02 09:30:00");
  expect(output).toContain("成交量 0 股");
  expect(output).toContain("WhyJ 计算");
  const empty = renderToStaticMarkup(<IntradayIndicatorResult result={{ ...sample, rows: [] }} minute="" />);
  expect(empty).toContain("归档中没有该日期的常规分钟记录");
  expect(empty).not.toContain("<dt>");
});

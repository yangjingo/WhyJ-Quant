import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ObservationListRowsPreview } from "../src/client/contract";
import { listRowsManifest, ObservationListResult, ObservationListRows } from "../src/components/ObservationListRows";

const date = "2024-03-04";
const observedAt = "2024-03-05T02:00:00Z";
const marketRevision = "a".repeat(64), dailyRevision = "b".repeat(64);
const limitsRevision = "c".repeat(64), rawRevision = "d".repeat(64);
const symbol = "600000.SH", missing = "000001.SZ";
const manifest = { version: 1, marketRevision, adjustment: "forward", stocks: [
  { symbol, dailyRevision, limitsRevision, rawRevision }, { symbol: missing },
] };

test("builds a bounded ordered Host request from the CLI manifest", () => {
  expect(listRowsManifest(manifest)).toEqual({
    marketRef: { version: 1, kind: "market-cross-section", revision: marketRevision }, adjustment: "forward",
    stocks: [{ symbol, history: { ref: { version: 2, revision: dailyRevision }, exchange: {
      tradingLimitArchiveRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision },
      rawArchiveRef: { version: 2, revision: rawRevision },
    } } }, { symbol: missing }],
  });
  for (const value of [
    { ...manifest, marketRevision: "../data" }, { ...manifest, version: 2 },
    { ...manifest, stocks: [{ symbol, rawRevision }] },
    { ...manifest, stocks: [{ symbol, dailyRevision, rawRevision }] },
    { ...manifest, stocks: [{ symbol }, { symbol }] }, { ...manifest, stocks: [{ symbol: "000001.SH" }] },
    { ...manifest, stocks: [{ symbol, unknown: true }] },
    { ...manifest, stocks: Array.from({ length: 101 }, (_, i) => ({ symbol: `600${String(i).padStart(3, "0")}.SH` })) },
  ]) expect(() => listRowsManifest(value)).toThrow("清单需要有效");
});

test("presents provider data and WHYJ metrics with distinct zero and missing values", () => {
  const meta = { tradeDate: date, observedAt, coverage: "unknown" } as const;
  const result: ObservationListRowsPreview = {
    marketRef: { version: 1, kind: "market-cross-section", revision: marketRevision }, source: "tushare", market: "A",
    tradeDate: date, adjustment: "forward",
    observations: {
      roster: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks" },
      daily: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand" },
      dailyBasic: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand" },
    },
    rows: [{
      instrument: { symbol, name: "示例股票", industry: null, listedOn: null },
      observations: { bar: { symbol, open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: 10, returnPct: 0,
        changeCny: 0, volume: 0, amount: null }, basic: null, quantities: { volumeShares: 0, amountCny: null } },
      metrics: {
        liquidity: { producer: "whyj", formula: { id: "tsp_list_liquidity", version: 1, revision: "tsp" },
          units: { floatValueCny: "CNY", turnoverPct: "percentage-points" }, floatValueCny: null, turnoverPct: 0 },
        history: null,
        daily: { producer: "whyj", formula: { id: "tsp_daily_ohlcv", version: 1, revision: "tsp" }, date,
          values: { change_pct: 0.05, ma5: null } },
        signals: { producer: "whyj", formula: { id: "tsp_daily_signals", version: 1, revision: "tsp" }, date,
          values: { signal_limit_up: false, signal_volume_surge: null }, exchangeInputs: null },
      },
    }],
  };
  const html = renderToStaticMarkup(<ObservationListResult result={result} />);
  expect(html).toContain(date);
  expect(html).toContain(observedAt);
  expect(html).toContain("供应商行情与估值");
  expect(html).toContain("WHYJ 计算");
  expect(html).toContain("<dt>成交量（股）</dt><dd>0</dd>");
  expect(html).toContain("<dt>成交额（元）</dt><dd>暂无</dd>");
  expect(html).toContain("<dt>涨跌幅</dt><dd>0%</dd>");
  expect(html).toContain("<dt>涨跌幅</dt><dd>5%</dd>");
  expect(html).toContain("<dt>signal_limit_up</dt><dd>未命中</dd>");
  expect(renderToStaticMarkup(<ObservationListResult result={{ ...result, rows: [] }} />)).toContain("清单没有请求股票");
  expect(renderToStaticMarkup(<ObservationListRows read={undefined} />)).toContain("当前服务不支持历史股票列表");

  const timestamp = Date.parse(observedAt);
  const renderQuote = (reported: {
    reportedTurnoverFraction?: number; reportedChangeAmount?: number; reportedChangeFraction?: number; reportedAmplitudeFraction?: number;
  } = {}) => renderToStaticMarkup(<ObservationListResult result={result} quotes={{
    status: "observed", source: "tickflow", endpoint: "/v1/quotes", observedAt, units: "unknown",
    rows: [{ symbol, status: "available", sourceTimestamp: timestamp,
      snapshot: { symbol, timestamp, lastPrice: 12, previousClose: 10, open: 10, high: 12, low: 10, volume: 0, amount: null,
        ...reported },
      change: { producer: "whyj", changeAmount: 2, changeFraction: 0.2 } }],
  }} />);
  const quoted = renderQuote({
    reportedTurnoverFraction: 0.01, reportedChangeAmount: -0.5, reportedChangeFraction: -0.05, reportedAmplitudeFraction: 0.3,
  });
  const quotedZero = renderQuote({
    reportedTurnoverFraction: 0, reportedChangeAmount: 0, reportedChangeFraction: 0, reportedAmplitudeFraction: 0,
  });
  const quotedMissing = renderQuote();
  for (const [field, value, zero] of [
    ["供应商报价换手率", "1%", "0%"], ["供应商报价涨跌额（元）", "-0.5", "0"],
    ["供应商报价涨跌幅", "-5%", "0%"], ["供应商报价振幅", "30%", "0%"],
  ]) {
    expect(quoted).toContain(`<dt>${field}</dt><dd>${value}</dd>`);
    expect(quotedZero).toContain(`<dt>${field}</dt><dd>${zero}</dd>`);
    expect(quotedMissing).toContain(`<dt>${field}</dt><dd>暂无</dd>`);
  }
  expect(quoted).toContain("收盘 10 元");
  expect(quoted).toContain("报价 12 元");
  expect(quoted).toContain("tickflow · /v1/quotes");
  expect(quoted).toContain("原始数量单位未知");
  expect(quoted).toContain("<dt>WHYJ 报价涨跌幅</dt><dd>20%</dd>");
  expect(quoted).toContain("<dt>原始成交量</dt><dd>0</dd>");
  expect(renderToStaticMarkup(<ObservationListResult result={result} quotes={{ status: "unavailable" }} />))
    .toContain("当前数据源未能返回报价，仍可查看固定归档。");
  expect(renderToStaticMarkup(<ObservationListRows read={async () => result} />)).not.toContain("读取当日报价");
  expect(renderToStaticMarkup(<ObservationListRows read={async () => result}
    readQuotes={async () => ({ fixed: result, quotes: { status: "outside-current-day" } })} />)).toContain("读取当日报价");
});

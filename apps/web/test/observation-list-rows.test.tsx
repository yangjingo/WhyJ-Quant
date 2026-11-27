import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ObservationListRowsPreview } from "../src/client/contract";
import { listRowsManifest, ObservationListResult, ObservationListRows } from "../src/components/ObservationListRows";

const date = "2024-03-04";
const observedAt = "2024-03-05T02:00:00Z";
const marketRevision = "a".repeat(64), dailyRevision = "b".repeat(64);
const limitsRevision = "c".repeat(64), rawRevision = "d".repeat(64);
const reportRevision = "e".repeat(64), disclosureRevision = "f".repeat(64);
const minuteRevision = "1".repeat(64);
const minuteRequest = { minuteRevision, interpretation: {
  timestampLabel: "minute-end", priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "hand",
} } as const;
const reportRef = { version: 1, kind: "report-financial-indicators", revision: reportRevision } as const;
const disclosureRef = { version: 1, kind: "financial-disclosure-dates", revision: disclosureRevision } as const;
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
  expect(listRowsManifest({ ...manifest, stocks: [{ ...manifest.stocks[0], candleBars: 12 }] }).stocks[0]?.history)
    .toMatchObject({ ref: { revision: dailyRevision }, candleBars: 12 });
  for (const stock of [{ symbol, candleBars: 12 }, { symbol, dailyRevision, candleBars: 61 },
    { symbol, dailyRevision, candleBars: "12" }]) {
    expect(() => listRowsManifest({ ...manifest, stocks: [stock] })).toThrow("日 K");
  }
  const previousClose = { revision: limitsRevision, priceBasis: "caller-confirmed-same-basis" } as const;
  expect(listRowsManifest({ ...manifest, stocks: [{ symbol, intraday: { ...minuteRequest, previousClose } }] }).stocks).toEqual([
    { symbol, intraday: { ref: { version: 1, kind: "dated-stock-minute", revision: minuteRevision },
      interpretation: minuteRequest.interpretation,
      previousClose: { ref: { version: 1, kind: "daily-trading-limits", revision: limitsRevision }, priceBasis: previousClose.priceBasis } } },
  ]);
  for (const intraday of [null, { ...minuteRequest, minuteRevision: "../private" },
    { ...minuteRequest, interpretation: { ...minuteRequest.interpretation, amountUnit: "CNY-million" } },
    { ...minuteRequest, previousClose: { ...previousClose, priceBasis: "assumed" } },
    { ...minuteRequest, market: "HK" }]) {
    expect(() => listRowsManifest({ ...manifest, stocks: [{ symbol, intraday }] })).toThrow("分时");
  }
  const finance = { financialReportRevisions: [reportRevision], financialDisclosureRevisions: [disclosureRevision] };
  expect(listRowsManifest({ ...manifest, stocks: [
    { ...manifest.stocks[0], ...finance }, { symbol: missing, ...finance },
  ] }).stocks).toEqual([
    { ...listRowsManifest(manifest).stocks[0]!, financialArchives: [reportRef, disclosureRef] },
    { symbol: missing, financialArchives: [reportRef, disclosureRef] },
  ]);
  for (const value of [
    { ...manifest, marketRevision: "../data" }, { ...manifest, version: 2 },
    { ...manifest, stocks: [{ symbol, rawRevision }] },
    { ...manifest, stocks: [{ symbol, dailyRevision, rawRevision }] },
    { ...manifest, stocks: [{ symbol }, { symbol }] }, { ...manifest, stocks: [{ symbol: "000001.SH" }] },
    { ...manifest, stocks: [{ symbol, unknown: true }] },
    { ...manifest, stocks: [{ symbol, ...finance, financialReportRevisions: ["../data"] }] },
    { ...manifest, stocks: [{ symbol, ...finance, financialDisclosureRevisions: [reportRevision] }] },
    { ...manifest, stocks: [{ symbol, ...finance, limitsRevision }] },
    { ...manifest, stocks: Array.from({ length: 101 }, (_, i) => ({ symbol: `600${String(i).padStart(3, "0")}.SH` })) },
  ]) expect(() => listRowsManifest(value)).toThrow("清单需要有效");

  const limitCalendar = { revision: "fixture-exchange", sessions: ["2024-03-01", date] };
  expect(listRowsManifest({ ...manifest, limitCalendar, stocks: [{ symbol, tradingLimitsRevision: limitsRevision }] })).toMatchObject({
    limitCalendar, stocks: [{ symbol, tradingLimitsRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision } }],
  });
  for (const sessions of [[date, date], [date, "2024-03-01"], ["2024-02-30", date], []]) {
    expect(() => listRowsManifest({ ...manifest, limitCalendar: { ...limitCalendar, sessions } })).toThrow("交易日历");
  }
  expect(() => listRowsManifest({ ...manifest, stocks: [{ symbol, dailyRevision, limitsRevision, tradingLimitsRevision: limitsRevision }] }))
    .toThrow("一种限价归档");
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
  expect(html).not.toContain("供应商日 K");
  expect(html).not.toContain("WHYJ 分时走势");
  const minuteResult: ObservationListRowsPreview = { ...result, rows: result.rows.map(row => ({
    ...row,
    observations: { ...row.observations, intraday: {
      ...meta, ref: { version: 1, kind: "dated-stock-minute", revision: minuteRevision },
      source: "tickflow", endpoint: "/v1/klines", market: "A", symbol, assetType: "stock", interval: "1m", adjustment: "none",
      priceUnit: "provider-native", volumeUnit: "provider-native", amountUnit: "provider-native", finality: "unknown",
      timeZone: "Asia/Shanghai", timestampLabel: "provider-native", interpretation: { ...minuteRequest.interpretation, amountUnit: "unknown" },
      rows: [{ sourceTimestamp: 1709515860000, open: 10, high: 10, low: 10, close: 10, volume: 0, amount: null }],
      rowCount: 1, previousClose: null, excluded: [],
    } },
    metrics: { ...row.metrics, intraday: {
      producer: "whyj", formula: { id: "tsp_list_intraday", version: 1, revision: "tsp" }, tradeDate: date,
      plotBaseline: { kind: "first-observed-open", value: 10 }, latestReturnFraction: null,
      points: [{ minute: "09:30", sourceTimestamp: 1709515860000, close: 10, averageClose: 10, previousCloseReturnFraction: null }],
    } },
  })) };
  const minutes = renderToStaticMarkup(<ObservationListResult result={minuteResult} />);
  expect(minutes).toContain("WHYJ 分时走势");
  expect(minutes).toContain("首个观测开盘价");
  expect(minutes).toContain("查看分钟");
  expect(minutes).toContain(minuteRevision);
  expect(minutes).toContain("tsp_list_intraday v1");
  expect(minutes).toContain("<dt>基于实际昨收的涨跌幅</dt><dd>暂无</dd>");
  const minuteRow = minuteResult.rows[0]!;
  const observedMinute = minuteRow.observations.intraday!;
  const calculatedMinute = minuteRow.metrics.intraday!;
  const zero = renderToStaticMarkup(<ObservationListResult result={{ ...minuteResult, rows: [{
    ...minuteRow,
    observations: { ...minuteRow.observations, intraday: { ...observedMinute, previousClose: {
      archiveRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision },
      priceBasis: "caller-confirmed-same-basis", source: "tushare", endpoint: "stk_limit", observedAt, priceUnit: "CNY",
      requested: { startDate: date, endDate: date }, rows: [{ tradeDate: date, price: 10 }],
    } } },
    metrics: { ...minuteRow.metrics, intraday: {
      ...calculatedMinute, latestReturnFraction: 0, plotBaseline: { kind: "previous-close", value: 10 },
      points: calculatedMinute.points.map(point => ({ ...point, previousCloseReturnFraction: 0 })),
    } },
  }] }} />);
  expect(zero).toContain("<dt>基于实际昨收的涨跌幅</dt><dd>0%</dd>");
  const empty = renderToStaticMarkup(<ObservationListResult result={{ ...minuteResult, rows: [{
    ...minuteRow,
    observations: { ...minuteRow.observations, intraday: { ...observedMinute, rows: [], rowCount: 0 } },
    metrics: { ...minuteRow.metrics, intraday: { ...calculatedMinute, points: [], plotBaseline: null } },
  }] }} />);
  expect(empty).toContain("归档没有可显示的已完成分钟");
  const candleRows: NonNullable<ObservationListRowsPreview["rows"][number]["observations"]["dailyCandles"]> = {
    ref: { version: 2, revision: dailyRevision }, source: "tickflow", endpoint: "/v1/klines", symbol,
    observedAt, calendarTimeZone: "Asia/Shanghai", adjustment: "forward", requestedBars: 12,
    firstTradeDate: date, lastTradeDate: date, requested: { startDate: date, endDate: date },
    coverage: "unknown", finality: "unknown", volumeUnit: "unknown", amountUnit: "unknown",
    rows: [{ tradeDate: date, sourceTimestamp: 1709535600000, open: 10, high: 12, low: 9, close: 11, volume: 0, amount: null }],
  };
  const candleResult = { ...result, rows: result.rows.map(row => ({
    ...row, observations: { ...row.observations, dailyCandles: candleRows },
  })) };
  const candles = renderToStaticMarkup(<ObservationListResult result={candleResult} />);
  expect(candles).toContain("供应商日 K");
  expect(candles).toContain("前复权");
  expect(candles).toContain("查看交易日");
  expect(candles).toContain(dailyRevision);
  expect(candles).toContain("<dt>成交量（单位未知）</dt><dd>0</dd>");
  expect(candles).toContain("<dt>成交额（单位未知）</dt><dd>暂无</dd>");
  expect(html).not.toContain("供应商财务报告");
  expect(html).not.toContain("供应商交易所限价");
  expect(html).not.toContain("WHYJ 连板计数");
  expect(html).toContain("WHYJ 计算");
  expect(html).toContain("<dt>成交量（股）</dt><dd>0</dd>");
  expect(html).toContain("<dt>成交额（元）</dt><dd>暂无</dd>");
  expect(html).toContain("<dt>涨跌幅</dt><dd>0%</dd>");
  expect(html).toContain("<dt>涨跌幅</dt><dd>5%</dd>");
  expect(html).toContain("<dt>signal_limit_up</dt><dd>未命中</dd>");
  expect(renderToStaticMarkup(<ObservationListResult result={{ ...result, rows: [] }} />)).toContain("清单没有请求股票");
  expect(renderToStaticMarkup(<ObservationListRows read={undefined} />)).toContain("当前服务不支持历史股票列表");

  const report = {
    periodEnd: "2023-12-31", announcementDate: "2024-02-28", updateFlag: null, basicEarningsPerShare: 0,
    earningsPerShareCurrency: "unknown", bookValuePerShare: 10, bookValueCurrency: "unknown", roe: -2, grossProfitMargin: 25,
    netProfitMargin: null, operatingRevenueYoyPct: 12, totalOperatingRevenueYoyPct: null, parentNetProfitYoyPct: -3,
    debtToAssets: 40, ratioUnit: "provider-native",
  } as const;
  const financeMarkup = (financial: ObservationListRowsPreview["rows"][number]["observations"]["financial"]) =>
    renderToStaticMarkup(<ObservationListResult result={{ ...result, rows: result.rows.map(row => ({
      ...row, observations: { ...row.observations, financial },
    })) }} />);
  const financed = financeMarkup({
    status: "available", tradingDate: date, periodEnd: report.periodEnd, actualDisclosureDate: report.announcementDate, report,
    reportEvidence: [{ ref: reportRef, observedAt }], disclosureEvidence: [{ ref: disclosureRef, observedAt }],
  });
  expect(financed).toContain("供应商财务报告");
  expect(financed).toContain("<dt>基本 EPS</dt><dd>0</dd>");
  expect(financed).toContain("<dt>ROE</dt><dd>-2</dd>");
  expect(financed).toContain("<dt>净利率</dt><dd>暂无</dd>");
  expect(financed).toContain(report.announcementDate);
  expect(financed).toContain(reportRevision);
  expect(financed).toContain(disclosureRevision);
  expect(financed).toContain("比率沿用供应商原始口径");
  expect(financeMarkup({ status: "unavailable", reason: "missing-disclosure", tradingDate: date }))
    .toContain("暂无可确认报告披露日期的归档");

  const tradingLimits = {
    ref: { version: 1, kind: "daily-trading-limits", revision: limitsRevision },
    symbol, market: "A", source: "tushare", endpoint: "stk_limit", priceUnit: "CNY", coverage: "unknown", observedAt,
    requested: { startDate: date, endDate: date },
    row: { tradeDate: date, previousClose: 10, limitUp: 11, limitDown: 9 },
  } as const;
  const withLimits: ObservationListRowsPreview = { ...result, limitCalendar: { revision: "fixture-exchange", zone: "Asia/Shanghai", sessions: [date] },
    rows: result.rows.map(row => ({ ...row, observations: { ...row.observations, tradingLimits },
      metrics: { ...row.metrics, limitStreaks: { producer: "whyj", formula: { id: "tsp_limit_streaks", version: 1, revision: "ref-tsp" },
        consecutiveLimitUps: 0, consecutiveLimitDowns: null } } })) };
  const limitsMarkup = renderToStaticMarkup(<ObservationListResult result={withLimits} />);
  expect(limitsMarkup).toContain("<dt>涨停价（元）</dt><dd>11</dd>");
  expect(limitsMarkup).toContain("<dt>跌停价（元）</dt><dd>9</dd>");
  expect(limitsMarkup).toContain("<dt>连续涨停（交易日）</dt><dd>0</dd>");
  expect(limitsMarkup).toContain("<dt>连续跌停（交易日）</dt><dd>暂无</dd>");
  expect(limitsMarkup).toContain("fixture-exchange");
  expect(limitsMarkup).toContain(limitsRevision);
  expect(renderToStaticMarkup(<ObservationListResult result={{ ...withLimits, rows: withLimits.rows.map(row => ({
    ...row, observations: { ...row.observations, tradingLimits: { ...tradingLimits, row: null } },
  })) }} />)).toContain("归档未返回该交易日的限价");

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

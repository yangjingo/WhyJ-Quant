import { useEffect, useRef, useState } from "react";
import type { ObservationListIntradayRequest, ObservationListQuoteRow, ObservationListQuotesPreview, ObservationListRowsPreview,
  ObservationListDeviationPreview, ObservationListRowsRequest, ObservationListScreenerScope, WorkbenchClient } from "../client/contract";
import { ObservationDailyValues } from "./ObservationCollection";
import { ObservationCandleChart } from "./ObservationCandleChart";
import { ObservationListIntradayChart } from "./ObservationListIntradayChart";

const stockPattern = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const isRevision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("清单需要有效的市场截面、归档修订和复权口径，股票范围最多 100 只不同的 A 股。");

function financialReferences(reports: unknown, disclosures: unknown) {
  if (reports === undefined && disclosures === undefined) return undefined;
  const reportRevisions = reports === undefined ? [] : reports;
  const disclosureRevisions = disclosures === undefined ? [] : disclosures;
  if (!Array.isArray(reportRevisions) || !reportRevisions.every(isRevision) ||
    !Array.isArray(disclosureRevisions) || !disclosureRevisions.every(isRevision) ||
    new Set([...reportRevisions, ...disclosureRevisions]).size !== reportRevisions.length + disclosureRevisions.length) throw invalid();
  return [
    ...reportRevisions.map(revision => ({ version: 1, kind: "report-financial-indicators", revision }) as const),
    ...disclosureRevisions.map(revision => ({ version: 1, kind: "financial-disclosure-dates", revision }) as const),
  ];
}

function intradayReference(value: unknown): ObservationListIntradayRequest {
  const error = () => new Error("分时清单需要有效的分钟归档修订、分钟标签和价格口径。");
  if (!isObject(value) || Object.keys(value).some(key => !["minuteRevision", "interpretation", "previousClose"].includes(key)) ||
    !isRevision(value.minuteRevision)) throw error();
  const { minuteRevision, interpretation, previousClose } = value;
  if (!isObject(interpretation) || Object.keys(interpretation).some(key => !["timestampLabel", "priceBasis", "volumeUnit", "amountUnit"].includes(key))) {
    throw error();
  }
  const { timestampLabel, priceBasis, volumeUnit, amountUnit } = interpretation;
  if ((timestampLabel !== "minute-start" && timestampLabel !== "minute-end") || priceBasis !== "caller-confirmed-unadjusted-CNY" ||
    (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw error();
  const request: ObservationListIntradayRequest = {
    ref: { version: 1, kind: "dated-stock-minute", revision: minuteRevision },
    interpretation: { timestampLabel, priceBasis,
      ...(volumeUnit !== undefined && { volumeUnit }), ...(amountUnit !== undefined && { amountUnit }) },
  };
  if (previousClose === undefined) return request;
  if (!isObject(previousClose) || Object.keys(previousClose).some(key => key !== "revision" && key !== "priceBasis") ||
    !isRevision(previousClose.revision) || previousClose.priceBasis !== "caller-confirmed-same-basis") throw error();
  return { ...request, previousClose: {
    ref: { version: 1, kind: "daily-trading-limits", revision: previousClose.revision }, priceBasis: previousClose.priceBasis,
  } };
}

function dailyHistory(dailyRevision: unknown, limitsRevision: unknown, rawRevision: unknown, error: () => Error) {
  if (!isRevision(dailyRevision) || (limitsRevision !== undefined && !isRevision(limitsRevision)) ||
    (rawRevision !== undefined && (!isRevision(rawRevision) || limitsRevision === undefined))) throw error();
  return { ref: { version: 2, revision: dailyRevision } as const, ...(limitsRevision && { exchange: {
    tradingLimitArchiveRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision } as const,
    ...(rawRevision && { rawArchiveRef: { version: 2, revision: rawRevision } as const }),
  } }) };
}

const invalidScreener = () => new Error("选股范围需要有效的候选归档和策略，候选代码和策略 ID 各自不能重复。");

function screenerStrategy(value: unknown): ObservationListScreenerScope["strategies"][number] {
  if (!isObject(value) || Object.keys(value).some(key => !["strategy", "weights", "signalGate", "orderBy", "descending"].includes(key))) {
    throw invalidScreener();
  }
  const { strategy, weights, signalGate, orderBy, descending } = value;
  if (!isObject(strategy) || Object.keys(strategy).some(key => key !== "id" && key !== "revision") ||
    typeof strategy.id !== "string" || !strategy.id.trim() || strategy.id !== strategy.id.trim() || !isRevision(strategy.revision) ||
    !Array.isArray(weights) || (orderBy !== undefined && (typeof orderBy !== "string" || !orderBy.trim() || orderBy !== orderBy.trim())) ||
    (descending !== undefined && typeof descending !== "boolean")) throw invalidScreener();
  let gate: ObservationListScreenerScope["strategies"][number]["signalGate"];
  if (signalGate !== undefined) {
    if (!isObject(signalGate) || Object.keys(signalGate).some(key => key !== "mode" && key !== "signals") ||
      (signalGate.mode !== "any" && signalGate.mode !== "all") || !Array.isArray(signalGate.signals) || !signalGate.signals.length ||
      !signalGate.signals.every(signal => typeof signal === "string" && signal.length > 0) ||
      new Set(signalGate.signals).size !== signalGate.signals.length) throw invalidScreener();
    gate = { mode: signalGate.mode, signals: signalGate.signals };
  }
  return {
    strategy: { id: strategy.id, revision: strategy.revision },
    weights: weights.map((entry: unknown) => {
      if (!isObject(entry) || Object.keys(entry).some(key => !["field", "weight", "direction"].includes(key)) ||
        typeof entry.field !== "string" || !entry.field.trim() || entry.field !== entry.field.trim() ||
        typeof entry.weight !== "number" || !Number.isFinite(entry.weight) || entry.weight < 0 ||
        (entry.direction !== undefined && entry.direction !== "low" && entry.direction !== "high")) throw invalidScreener();
      return { field: entry.field, weight: entry.weight, ...(entry.direction !== undefined && { direction: entry.direction }) };
    }),
    ...(gate && { signalGate: gate }), ...(orderBy !== undefined && { orderBy }), ...(descending !== undefined && { descending }),
  };
}

function screenerScope(value: unknown): ObservationListScreenerScope {
  if (!isObject(value) || Object.keys(value).some(key => key !== "histories" && key !== "strategies") ||
    !Array.isArray(value.histories) || !Array.isArray(value.strategies) || !value.strategies.length) throw invalidScreener();
  const histories = value.histories.map((entry: unknown) => {
    if (!isObject(entry) || Object.keys(entry).some(key => !["symbol", "dailyRevision", "limitsRevision", "rawRevision"].includes(key)) ||
      typeof entry.symbol !== "string" || !stockPattern.test(entry.symbol)) throw invalidScreener();
    return { symbol: entry.symbol, ...dailyHistory(entry.dailyRevision, entry.limitsRevision, entry.rawRevision, invalidScreener) };
  });
  const strategies = value.strategies.map(screenerStrategy);
  if (new Set(histories.map(item => item.symbol)).size !== histories.length ||
    new Set(strategies.map(item => item.strategy.id)).size !== strategies.length) throw invalidScreener();
  return { histories, strategies };
}

function listCalendar(value: unknown, error: () => Error): NonNullable<ObservationListRowsRequest["limitCalendar"]> {
  if (!isObject(value) || Object.keys(value).some(key => key !== "revision" && key !== "sessions") ||
    typeof value.revision !== "string" || !value.revision.trim() || value.revision.length > 256 ||
    !Array.isArray(value.sessions) || !value.sessions.length) throw error();
  const sessions: string[] = [];
  for (const date of value.sessions) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "0001-01-01" ||
      date <= (sessions.at(-1) ?? "")) throw error();
    const time = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw error();
    sessions.push(date);
  }
  return { revision: value.revision, sessions };
}

const invalidDeviation = () => new Error("价格偏离需要有效的交易日历、股票归档修订和可选的基准指数归档修订。");

function deviationReferences(value: unknown): NonNullable<ObservationListRowsRequest["stocks"][number]["deviation"]> {
  if (!isObject(value) || Object.keys(value).some(key => key !== "stockRevision" && key !== "benchmarkRevision") ||
    !isRevision(value.stockRevision) || (value.benchmarkRevision !== undefined && !isRevision(value.benchmarkRevision))) throw invalidDeviation();
  return { stockRef: { version: 2, revision: value.stockRevision },
    ...(value.benchmarkRevision !== undefined && { benchmarkRef: { version: 1, kind: "benchmark-index", revision: value.benchmarkRevision } }) };
}

export function listRowsManifest(value: unknown): ObservationListRowsRequest {
  if (!isObject(value) || Object.keys(value).some(key => !["version", "marketRevision", "adjustment", "stocks", "limitCalendar",
    "watchlistMembershipRevision", "screener", "deviationCalendar"].includes(key)) ||
    value.version !== 1 || !isRevision(value.marketRevision) || (value.adjustment !== "none" && value.adjustment !== "forward") ||
    !Array.isArray(value.stocks) || value.stocks.length > 100) throw invalid();
  const watchlistError = () => new Error("自选清单需要有效的成员修订。附上收益率历史时也要提供前复权日线归档修订。");
  const { watchlistMembershipRevision } = value;
  if (watchlistMembershipRevision !== undefined && !isRevision(watchlistMembershipRevision)) throw watchlistError();
  const screener = value.screener === undefined ? undefined : screenerScope(value.screener);
  const limitCalendar = value.limitCalendar === undefined ? undefined :
    listCalendar(value.limitCalendar, () => new Error("交易日历须包含修订号和升序且互异的有效交易日。"));
  const deviationCalendar = value.deviationCalendar === undefined ? undefined : listCalendar(value.deviationCalendar, invalidDeviation);
  const seen = new Set<string>();
  const stocks: ObservationListRowsRequest["stocks"] = value.stocks.map(entry => {
    if (!isObject(entry) || Object.keys(entry).some(key => !["symbol", "dailyRevision", "limitsRevision", "rawRevision",
      "financialReportRevisions", "financialDisclosureRevisions", "tradingLimitsRevision", "candleBars", "intraday",
      "watchlistHistoryRevision", "deviation"].includes(key))) throw invalid();
    const { symbol, dailyRevision, limitsRevision, rawRevision, financialReportRevisions, financialDisclosureRevisions, tradingLimitsRevision, candleBars,
      intraday, watchlistHistoryRevision, deviation } = entry;
    if (deviation !== undefined && !deviationCalendar) throw invalidDeviation();
    if (watchlistHistoryRevision !== undefined && (watchlistMembershipRevision === undefined || !isRevision(watchlistHistoryRevision))) {
      throw watchlistError();
    }
    if (candleBars !== undefined && (typeof candleBars !== "number" || !Number.isInteger(candleBars) || candleBars < 5 ||
      candleBars > 60 || !isRevision(dailyRevision))) throw new Error("日 K 窗口须为 5 至 60 的整数，并附上日线归档修订。");
    if (typeof symbol !== "string" || !stockPattern.test(symbol) || seen.has(symbol)) throw invalid();
    seen.add(symbol);
    const financialArchives = financialReferences(financialReportRevisions, financialDisclosureRevisions);
    if (tradingLimitsRevision !== undefined && !isRevision(tradingLimitsRevision)) throw invalid();
    if (tradingLimitsRevision !== undefined && limitsRevision !== undefined) throw new Error("每只股票只能指定一种限价归档引用。");
    const stock = { symbol, ...(financialArchives !== undefined && { financialArchives }),
      ...(intraday !== undefined && { intraday: intradayReference(intraday) }),
      ...(watchlistHistoryRevision !== undefined && { watchlistHistoryRef: { version: 2, revision: watchlistHistoryRevision } as const }),
      ...(deviation !== undefined && { deviation: deviationReferences(deviation) }),
      ...(tradingLimitsRevision && { tradingLimitsRef: { version: 1, kind: "daily-trading-limits", revision: tradingLimitsRevision } as const }) };
    if (dailyRevision === undefined && limitsRevision === undefined && rawRevision === undefined) return stock;
    return { ...stock, history: { ...dailyHistory(dailyRevision, limitsRevision, rawRevision, invalid),
      ...(candleBars !== undefined && { candleBars }) } };
  });
  return { marketRef: { version: 1, kind: "market-cross-section", revision: value.marketRevision }, adjustment: value.adjustment, stocks,
    ...(watchlistMembershipRevision !== undefined && { watchlistMembershipRevision }),
    ...(limitCalendar && { limitCalendar }), ...(screener && { screener }), ...(deviationCalendar && { deviationCalendar }) };
}

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const display = (value: number | null | undefined, unit = "") => value == null ? "暂无" : numberFormat.format(value) + unit;
const displayFraction = (value: number | null | undefined) => display(value == null ? null : value * 100, "%");
const quoteTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const quoteRowStatus = {
  missing: "未返回报价", "missing-price": "缺少有效价格", "different-session": "报价与列表日期不符", "future-timestamp": "行情时间晚于获取时间",
} as const;
const quoteBatchStatus = {
  "outside-current-day": "列表日期并非当前上海日期，已跳过报价请求。",
  empty: "清单没有报价标的。", unavailable: "当前数据源未能返回报价，仍可查看固定归档。",
} as const;
const financialStatus = {
  "missing-report": "目标交易日前暂无可用的报告归档。",
  "missing-disclosure": "暂无可确认报告披露日期的归档。",
  "ambiguous-report": "报告版本存在冲突。",
  "ambiguous-disclosure": "归档中的实际披露日存在冲突。",
  "inconsistent-timing": "披露与归档时间不一致。",
} as const;

function ListValues({ values }: { values: [string, string][] }) {
  return <dl className="observation-indicator-values">
    {values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

type ListFinancial = NonNullable<ObservationListRowsPreview["rows"][number]["observations"]["financial"]>;

function StockListFinancial({ financial }: { financial: ListFinancial }) {
  return <section>
    <h5>供应商财务报告</h5>
    {financial.status === "available" ? <>
      <p className="supporting">报告期 <time dateTime={financial.periodEnd}>{financial.periodEnd}</time>
        {" · "}实际披露日 <time dateTime={financial.actualDisclosureDate}>{financial.actualDisclosureDate}</time></p>
      <ListValues values={[
        ["基本 EPS", display(financial.report.basicEarningsPerShare)],
        ["每股净资产", display(financial.report.bookValuePerShare)],
        ["ROE", display(financial.report.roe)],
        ["毛利率", display(financial.report.grossProfitMargin)],
        ["净利率", display(financial.report.netProfitMargin)],
        ["营业收入同比", display(financial.report.operatingRevenueYoyPct)],
        ["归母净利润同比", display(financial.report.parentNetProfitYoyPct)],
        ["资产负债率", display(financial.report.debtToAssets)],
      ]} />
      <p className="supporting">每股数据币种未知，比率沿用供应商原始口径。</p>
      {financial.reportEvidence.map(({ ref, observedAt }) => <p key={ref.revision} className="supporting observation-ref">
        财报归档 <code>{ref.revision}</code> · <time dateTime={observedAt}>{observedAt}</time>
      </p>)}
      {financial.disclosureEvidence.map(({ ref, observedAt }) => <p key={ref.revision} className="supporting observation-ref">
        披露归档 <code>{ref.revision}</code> · <time dateTime={observedAt}>{observedAt}</time>
      </p>)}
    </> : <p className="supporting">{financialStatus[financial.reason]}</p>}
  </section>;
}

type ListCandles = NonNullable<ObservationListRowsPreview["rows"][number]["observations"]["dailyCandles"]>;

function StockListCandles({ candles }: { candles: ListCandles }) {
  const { rows } = candles;
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(rows.at(-1)?.tradeDate);
  const selected = rows.find(row => row.tradeDate === date) ?? rows.at(-1);

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>供应商日 K · {rows.length} 根</summary>
    <p className="supporting observation-ref">{candles.source} · {candles.endpoint} · {candles.adjustment === "forward" ? "前复权" : "未复权"}
      {" · "}<time dateTime={candles.observedAt}>{candles.observedAt}</time> · <code>{candles.ref.revision}</code></p>
    {selected ? <>
      <p className="supporting">{rows[0]!.tradeDate} 至 {rows.at(-1)!.tradeDate} · 已观察 {rows.length} / 请求 {candles.requestedBars} 根</p>
      {open && <ObservationCandleChart rows={rows} />}
      <label className="field-row">查看交易日<select value={selected.tradeDate} onChange={event => setDate(event.currentTarget.value)}>
        {rows.map(row => <option key={row.tradeDate} value={row.tradeDate}>{row.tradeDate}</option>)}
      </select></label>
      <ListValues values={[
        ["开盘", display(selected.open)], ["最高", display(selected.high)], ["最低", display(selected.low)], ["收盘", display(selected.close)],
        [candles.volumeUnit === "hand" ? "成交量（手）" : "成交量（单位未知）", display(selected.volume)],
        [candles.amountUnit === "CNY-thousand" ? "成交额（千元）" : "成交额（单位未知）", display(selected.amount)],
      ]} />
    </> : <p role="status">归档没有可显示的日 K。</p>}
  </details>;
}

type ListIntradayObservation = NonNullable<ObservationListRowsPreview["rows"][number]["observations"]["intraday"]>;
type ListIntradayMetric = NonNullable<ObservationListRowsPreview["rows"][number]["metrics"]["intraday"]>;

const intradayBasis = {
  "previous-close": "实际昨收",
  "implied-from-last-return": "按收盘涨幅推算",
  "first-observed-open": "首个观测开盘价",
  "first-observed-close": "首个观测收盘价",
} as const;

function StockListIntraday({ observation, metric }: { observation: ListIntradayObservation; metric: ListIntradayMetric }) {
  const { points, formula, plotBaseline, latestReturnFraction } = metric;
  const [open, setOpen] = useState(false);
  const [minute, setMinute] = useState(points.at(-1)?.minute);
  const selected = points.find(point => point.minute === minute) ?? points.at(-1);
  const pct = (value: number | null) => display(value === null ? null : value * 100, "%");

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>WHYJ 分时走势 · {points.length} 个分钟</summary>
    <p className="supporting observation-ref">分钟归档 {observation.source} · {observation.endpoint} · <code>{observation.ref.revision}</code>
      {" · "}<time dateTime={observation.observedAt}>{observation.observedAt}</time></p>
    <p className="supporting observation-ref">{formula.id} v{formula.version} · <code>{formula.revision}</code></p>
    {selected ? <>
      <ListValues values={[
        ["图表基准", plotBaseline ? `${intradayBasis[plotBaseline.kind]} ${display(plotBaseline.value, " 元")}` : "暂无"],
        ["最新分钟涨跌幅", pct(latestReturnFraction)],
      ]} />
      {open && <ObservationListIntradayChart points={points} baseline={plotBaseline?.value} />}
      <label className="field-row">查看分钟<select value={selected.minute} onChange={event => setMinute(event.currentTarget.value)}>
        {points.map(point => <option key={point.minute} value={point.minute}>{point.minute}</option>)}
      </select></label>
      <ListValues values={[
        ["收盘（元）", display(selected.close)], ["累计均价（元）", display(selected.averageClose)],
        ["基于实际昨收的涨跌幅", pct(selected.previousCloseReturnFraction)],
      ]} />
    </> : <p role="status">归档没有可显示的已完成分钟。</p>}
  </details>;
}

type ListRow = ObservationListRowsPreview["rows"][number];
const screenerStatus = {
  matched: "命中",
  "not-matched": "未命中",
  unavailable: "证据不足",
  "outside-scope": "未参与评估",
} as const;
const watchlistReturnReason = {
  "missing-baseline": "缺少加入日或之前的前复权收盘价。",
  "missing-added-date": "缺少可以用于计算的加入日期。",
  "added-after-cutoff": "加入日期晚于列表交易日。",
  "unsupported-asset": "该资产类型暂无加入以来收益率。",
} as const;

function StockListMembership({ membership, result }: {
  membership: NonNullable<ListRow["membership"]>;
  result: ListRow["metrics"]["watchlistReturn"];
}) {
  const endpoint = (value: { tradeDate: string; close: number } | null) =>
    value ? `${value.tradeDate} · ${display(value.close, " 元")}` : "暂无";
  return <section aria-label="自选记录">
    <h5>自选记录</h5>
    <ListValues values={[["加入时间", membership.addedAt ?? "暂无"], ["保存在自选中的代码", membership.code]]} />
    <p className="supporting observation-ref">自选清单修订 <code>{membership.revision}</code></p>
    {result ? <>
      <h5>WHYJ 自选收益率</h5>
      <ListValues values={[
        ["加入以来涨跌幅", display(result.pctSinceAdded === null ? null : result.pctSinceAdded * 100, "%")],
        ["加入日期（上海）", result.addedDate ?? "暂无"],
        ["基准收盘", endpoint(result.baseline)],
        ["截至列表日期的收盘", endpoint(result.latest)],
      ]} />
      {result.status !== "available" && <p className="supporting">{watchlistReturnReason[result.status]}</p>}
      <p className="supporting observation-ref">{result.formulaVersion} · <code>{result.referenceRevision}</code></p>
      <p className="supporting observation-ref">前复权历史 {result.history.source} · {result.history.endpoint}
        {" · "}<code>{result.history.ref.revision}</code></p>
    </> : <p className="supporting">清单未绑定用于计算收益率的前复权历史。</p>}
  </section>;
}

function StockListScreener({ metric }: { metric: NonNullable<ListRow["metrics"]["screener"]> }) {
  const hits = new Map(metric.hits.map(hit => [hit.strategyId, hit.score]));
  return <section aria-label="WHYJ 选股评分">
    <h5>WHYJ 选股评分</h5>
    <ListValues values={[
      ["展示分数", display(metric.score)], ["汇总排名", display(metric.position)], ["评分来源策略", metric.scoreStrategyId ?? "暂无"],
    ]} />
    <ListValues values={metric.evaluations.map(({ strategyId, status }) => [
      strategyId, status === "matched" ? `命中 · ${hits.get(strategyId) == null ? "缺分" : display(hits.get(strategyId))}` : screenerStatus[status],
    ])} />
  </section>;
}

const proximityStatus = {
  unavailable: "证据不足",
  "below-watch": "低于关注区间",
  watch: "关注",
  edge: "接近阈值",
  triggered: "达到分析阈值",
} as const;

function StockListDeviation({ metric }: { metric: ObservationListDeviationPreview }) {
  const { formula, input: { stock, benchmark }, values, comparisonDates, proximity } = metric;
  const fraction = (value: number | null) => display(value === null ? null : value * 100, "%");
  return <details>
    <summary>WHYJ 价格偏离</summary>
    {benchmark ? <p className="supporting observation-ref">基准指数 {benchmark.symbol} · {benchmark.source} · {benchmark.endpoint}
      {" · "}<code>{benchmark.ref.revision}</code></p> : <p className="supporting">未绑定基准指数。</p>}
    <ListValues values={([3, 10, 30] as const).flatMap((window): [string, string][] => [
      [`${window} 日偏离`, fraction(values[`deviate_${window}d`])],
      [`${window} 日比较日期`, comparisonDates[window] ?? "暂无"],
    ])} />
    <p className="supporting observation-ref">前复权历史 {stock.source} · {stock.endpoint} · <code>{stock.ref.revision}</code></p>
    <p className="supporting observation-ref">{formula.id} v{formula.version} · <code>{formula.revision}</code></p>
    <h5>分析阈值接近度</h5>
    <ListValues values={[
      ["状态", proximityStatus[proximity.tier]],
      ["最接近阈值的窗口", display(proximity.dominantWindow, " 日")],
      ...proximity.windows.flatMap(({ window, threshold, closeness }): [string, string][] => [
        [`${window} 日分析阈值`, fraction(threshold)], [`${window} 日接近度`, fraction(closeness)],
      ]),
    ]} />
    <p className="supporting observation-ref">{proximity.formula.id} v{proximity.formula.version} · <code>{proximity.formula.revision}</code></p>
  </details>;
}

function StockListRow({ row, quote }: { row: ListRow; quote?: ObservationListQuoteRow }) {
  const { instrument, membership, observations: { bar, basic, quantities, financial, tradingLimits, dailyCandles, intraday: minuteObservation },
    metrics: { liquidity, history, daily, signals, limitStreaks, intraday: minuteMetric, watchlistReturn, screener, deviation } } = row;
  return <details className="observation-list-stock">
    <summary>
      <span><strong>{instrument.name || instrument.symbol}</strong><span className="supporting">{instrument.symbol}</span></span>
      <span className="observation-list-price">收盘 {display(bar?.close, " 元")} · {display(bar?.returnPct, "%")}</span>
      {screener?.position != null && <span className="observation-list-price">排名 {screener.position}</span>}
      {quote?.status === "available" && <span className="observation-list-price">报价 {display(quote.snapshot.lastPrice, " 元")}</span>}
    </summary>
    <div className="observation-list-detail">
      {quote && <section className="observation-list-quote">
        <h5>当日报价</h5>
        {quote.sourceTimestamp !== null && <p className="supporting">
          行情时间 <time dateTime={new Date(quote.sourceTimestamp).toISOString()}>{quoteTime.format(quote.sourceTimestamp)}</time>（上海）
        </p>}
        {quote.status === "available" ? <ListValues values={[
          ["最新价（元）", display(quote.snapshot.lastPrice)], ["报价昨收（元）", display(quote.snapshot.previousClose)],
          ["开盘（元）", display(quote.snapshot.open)], ["最高（元）", display(quote.snapshot.high)], ["最低（元）", display(quote.snapshot.low)],
          ["原始成交量", display(quote.snapshot.volume)], ["原始成交额", display(quote.snapshot.amount)],
          ["供应商报价涨跌额（元）", display(quote.snapshot.reportedChangeAmount)],
          ["供应商报价涨跌幅", displayFraction(quote.snapshot.reportedChangeFraction)],
          ["供应商报价振幅", displayFraction(quote.snapshot.reportedAmplitudeFraction)],
          ["供应商报价换手率", displayFraction(quote.snapshot.reportedTurnoverFraction)],
          ["WHYJ 报价涨跌额（元）", display(quote.change.changeAmount)],
          ["WHYJ 报价涨跌幅", displayFraction(quote.change.changeFraction)],
        ]} /> : <p className="supporting">{quoteRowStatus[quote.status]}</p>}
      </section>}
      <h5>供应商行情与估值</h5>
      <ListValues values={[
        ["开盘（元）", display(bar?.open)], ["最高（元）", display(bar?.high)], ["最低（元）", display(bar?.low)], ["收盘（元）", display(bar?.close)],
        ["除权参考昨收（元）", display(bar?.exRightsPreviousClose)], ["涨跌额（元）", display(bar?.changeCny)], ["涨跌幅", display(bar?.returnPct, "%")],
        ["成交量（股）", display(quantities.volumeShares)], ["成交额（元）", display(quantities.amountCny)],
        ["换手率", display(basic?.turnoverPct, "%")], ["PE TTM", display(basic?.peTtm)], ["PB", display(basic?.pb)],
      ]} />
      {tradingLimits && <section aria-label="供应商交易所限价">
        <h5>供应商交易所限价</h5>
        {tradingLimits.row ? <ListValues values={[
          ["涨停价（元）", display(tradingLimits.row.limitUp)], ["跌停价（元）", display(tradingLimits.row.limitDown)],
        ]} /> : <p className="supporting">归档未返回该交易日的限价。</p>}
        <p className="supporting observation-ref">{tradingLimits.source} · {tradingLimits.endpoint} · <code>{tradingLimits.ref.revision}</code>
          {" · "}<time dateTime={tradingLimits.observedAt}>{tradingLimits.observedAt}</time></p>
      </section>}
      {dailyCandles && <StockListCandles candles={dailyCandles} />}
      {financial && <StockListFinancial financial={financial} />}
      {membership && <StockListMembership membership={membership} result={watchlistReturn} />}
      {screener && <StockListScreener metric={screener} />}
      <h5>WHYJ 计算</h5>
      <ListValues values={[
        ["流通市值（元）", display(liquidity.floatValueCny)], ["按流通股计算的换手率", display(liquidity.turnoverPct, "%")],
      ]} />
      <p className="supporting observation-ref">{liquidity.formula.id} v{liquidity.formula.version} · <code>{liquidity.formula.revision}</code></p>
      {minuteObservation && minuteMetric && <StockListIntraday observation={minuteObservation} metric={minuteMetric} />}
      {deviation && <StockListDeviation metric={deviation} />}
      {limitStreaks && <section aria-label="WHYJ 连板计数">
        <h5>WHYJ 连板计数</h5>
        <ListValues values={[
          ["连续涨停（交易日）", display(limitStreaks.consecutiveLimitUps)],
          ["连续跌停（交易日）", display(limitStreaks.consecutiveLimitDowns)],
        ]} />
        <p className="supporting observation-ref">{limitStreaks.formula.id} v{limitStreaks.formula.version} · <code>{limitStreaks.formula.revision}</code></p>
      </section>}
      {history && <p className="supporting observation-ref">日线归档 {history.source} · {history.endpoint} · {history.observedAt}
        {" · "}{history.firstTradeDate} 至 {history.lastTradeDate} · <code>{history.ref.revision}</code></p>}
      {daily ? <details>
        <summary>日线技术指标</summary>
        <p className="supporting observation-ref">{daily.formula.id} v{daily.formula.version} · <code>{daily.formula.revision}</code></p>
        <ObservationDailyValues values={daily.values} fields={Object.keys(daily.values)} />
      </details> : <p className="supporting">目标交易日暂无日线技术指标。</p>}
      {signals && <details>
        <summary>日线信号</summary>
        <p className="supporting observation-ref">{signals.formula.id} v{signals.formula.version} · <code>{signals.formula.revision}</code></p>
        {signals.exchangeInputs && <p className="supporting observation-ref">限价归档 <code>{signals.exchangeInputs.limits.ref.revision}</code>
          {" · "}未复权日线 <code>{signals.exchangeInputs.raw.ref.revision}</code></p>}
        <ListValues values={Object.entries(signals.values).map(([key, value]) =>
          [key, value === null ? "暂无" : value ? "命中" : "未命中"])} />
      </details>}
    </div>
  </details>;
}

export function ObservationListResult({ result, quotes }: {
  result: ObservationListRowsPreview;
  quotes?: ObservationListQuotesPreview["quotes"];
}) {
  const observed = quotes?.status === "observed" ? quotes : undefined;
  const quoteBySymbol = new Map(observed?.rows.map(row => [row.symbol, row]));
  return <section className="observation-indicators observation-list-result" aria-label="历史列表结果">
    <h5>历史列表结果 <time dateTime={result.tradeDate}>{result.tradeDate}</time></h5>
    <p className="supporting">{result.rows.length} 只股票 · {result.source} · 日线计算{result.adjustment === "forward" ? "前复权" : "未复权"}</p>
    <p className="supporting">日行情 {result.observations.daily.observedAt} · 估值 {result.observations.dailyBasic.observedAt}</p>
    <p className="supporting observation-ref">市场截面 <code>{result.marketRef.revision}</code></p>
    {result.screener && <details>
      <summary>选股评分依据 · 候选 {result.screener.scoped} · 命中 {result.screener.matched}</summary>
      {result.screener.strategies.map(({ strategy, formula, candidateRevision, fieldSources, coverage }) =>
        <div key={strategy.id}>
          <p className="supporting observation-ref">{strategy.id} · <code>{strategy.revision}</code>
            {" · "}{formula.id} v{formula.version} · <code>{formula.revision}</code></p>
          <p className="supporting observation-ref">候选修订 <code>{candidateRevision}</code>
            {" · "}命中 {coverage.matched} · 未命中 {coverage.notMatched} · 证据不足 {coverage.unavailable}</p>
          {Object.keys(fieldSources).length > 0 && <ListValues values={Object.entries(fieldSources).map(([field, source]) =>
            [field, [source.producer, source.endpoint ?? source.formula, source.unit ?? source.nativeUnit].filter(Boolean).join(" · ")])} />}
        </div>)}
    </details>}
    {result.limitCalendar && <p className="supporting observation-ref">连板日历 <code>{result.limitCalendar.revision}</code>
      {" · "}{result.limitCalendar.sessions[0]} 至 {result.limitCalendar.sessions.at(-1)}</p>}
    {result.deviationCalendar && <p className="supporting observation-ref">偏离日历 <code>{result.deviationCalendar.revision}</code>
      {" · "}{result.deviationCalendar.sessions[0]} 至 {result.deviationCalendar.sessions.at(-1)}</p>}
    {quotes && <p className="supporting" role="status">{quotes.status === "observed"
      ? <>报价 {quotes.source} · {quotes.endpoint} · 获取于 <time dateTime={quotes.observedAt}>{quoteTime.format(new Date(quotes.observedAt))}</time>（上海）· 原始数量单位未知</>
      : quoteBatchStatus[quotes.status]}</p>}
    {result.rows.length ? result.rows.map(row => <StockListRow key={row.instrument.symbol} row={row}
      quote={quoteBySymbol.get(row.instrument.symbol)} />) : <p role="status">清单没有请求股票。</p>}
  </section>;
}

export function ObservationListRows({ read, readQuotes }: {
  read: WorkbenchClient["readObservationListRows"];
  readQuotes?: WorkbenchClient["readObservationListQuotes"];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"fixed" | "quotes" | null>(null);
  const [result, setResult] = useState<ObservationListRowsPreview | null>(null);
  const [quotes, setQuotes] = useState<ObservationListQuotesPreview["quotes"]>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setBusy(null); setResult(null); setError(""); setQuotes(undefined);
    return () => { generation.current++; };
  }, [read, readQuotes]);

  const load = async (kind: "fixed" | "quotes") => {
    if (!file || !read || busy) return;
    const ticket = ++generation.current;
    setBusy(kind); setError(""); setQuotes(undefined);
    if (kind === "fixed") setResult(null);
    try {
      if (file.size > 128 * 1024) throw new Error("清单文件不能超过 128 KB。");
      let value: unknown;
      try { value = JSON.parse(await file.text()); } catch { throw new Error("无法读取 JSON 清单。"); }
      const request = listRowsManifest(value);
      if (ticket !== generation.current) return;
      if (kind === "quotes" && readQuotes) {
        const preview = await readQuotes(request);
        if (ticket === generation.current) {
          setResult(preview.fixed);
          setQuotes(preview.quotes);
        }
      } else {
        const preview = await read(request);
        if (ticket === generation.current) setResult(preview);
      }
    } catch (cause) {
      if (ticket !== generation.current) return;
      const code = isObject(cause) ? cause.code : undefined;
      setError(code === "METHOD_NOT_FOUND" ? `当前服务不支持${kind === "quotes" ? "当日报价读取" : "历史股票列表"}，请更新并重新连接。` :
        cause instanceof Error ? cause.message : "无法读取指定归档，请检查连接后重试。");
    } finally {
      if (ticket === generation.current) setBusy(null);
    }
  };

  return <div className="settings-group observation-list" aria-busy={!!busy}>
    <h4>历史股票列表</h4>
    {!read ? <p role="status">当前服务不支持历史股票列表，请更新并重新连接。</p> : <>
      <p className="supporting">上传与 CLI 通用的 list-rows.json，读取当前工作区的市场截面以及可选的日线、分时、限价和财务归档。</p>
      <label className="field-row">列表清单<input type="file" accept=".json,application/json" disabled={!!busy} onChange={event => {
        setFile(event.currentTarget.files?.[0] ?? null); setResult(null); setQuotes(undefined); setError("");
      }} /></label>
      <div className="observation-list-actions">
        <button type="button" className="action" disabled={!file || !!busy} onClick={() => void load("fixed")}>{busy === "fixed" ? "正在读取归档…" : "读取列表归档"}</button>
        {readQuotes && <button type="button" className="action" disabled={!file || !!busy} onClick={() => void load("quotes")}>
          {busy === "quotes" ? "正在读取报价…" : "读取当日报价"}
        </button>}
      </div>
      {error && <p role="alert" className="operation-feedback error-feedback">{error}</p>}
      {result && <ObservationListResult result={result} quotes={quotes} />}
    </>}
  </div>;
}

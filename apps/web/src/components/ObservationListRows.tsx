import { useEffect, useRef, useState } from "react";
import type { ObservationListQuoteRow, ObservationListQuotesPreview, ObservationListRowsPreview,
  ObservationListRowsRequest, WorkbenchClient } from "../client/contract";
import { ObservationDailyValues } from "./ObservationCollection";

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

export function listRowsManifest(value: unknown): ObservationListRowsRequest {
  if (!isObject(value) || Object.keys(value).some(key => !["version", "marketRevision", "adjustment", "stocks", "limitCalendar"].includes(key)) ||
    value.version !== 1 || !isRevision(value.marketRevision) || (value.adjustment !== "none" && value.adjustment !== "forward") ||
    !Array.isArray(value.stocks) || value.stocks.length > 100) throw invalid();
  let limitCalendar: ObservationListRowsRequest["limitCalendar"];
  if (value.limitCalendar !== undefined) {
    const calendar = value.limitCalendar;
    const error = () => new Error("交易日历须包含修订号和升序且互异的有效交易日。");
    if (!isObject(calendar) || Object.keys(calendar).some(key => key !== "revision" && key !== "sessions") ||
      typeof calendar.revision !== "string" || !calendar.revision.trim() || calendar.revision.length > 256 ||
      !Array.isArray(calendar.sessions) || !calendar.sessions.length) throw error();
    const sessions: string[] = [];
    for (const date of calendar.sessions) {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "0001-01-01" ||
        date <= (sessions.at(-1) ?? "")) throw error();
      const time = Date.parse(date + "T00:00:00Z");
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw error();
      sessions.push(date);
    }
    limitCalendar = { revision: calendar.revision, sessions };
  }
  const seen = new Set<string>();
  const stocks: ObservationListRowsRequest["stocks"] = value.stocks.map(entry => {
    if (!isObject(entry) || Object.keys(entry).some(key => !["symbol", "dailyRevision", "limitsRevision", "rawRevision",
      "financialReportRevisions", "financialDisclosureRevisions", "tradingLimitsRevision"].includes(key))) throw invalid();
    const { symbol, dailyRevision, limitsRevision, rawRevision, financialReportRevisions, financialDisclosureRevisions, tradingLimitsRevision } = entry;
    if (typeof symbol !== "string" || !stockPattern.test(symbol) || seen.has(symbol)) throw invalid();
    seen.add(symbol);
    const financialArchives = financialReferences(financialReportRevisions, financialDisclosureRevisions);
    if (tradingLimitsRevision !== undefined && !isRevision(tradingLimitsRevision)) throw invalid();
    if (tradingLimitsRevision !== undefined && limitsRevision !== undefined) throw new Error("每只股票只能指定一种限价归档引用。");
    const stock = { symbol, ...(financialArchives !== undefined && { financialArchives }),
      ...(tradingLimitsRevision && { tradingLimitsRef: { version: 1, kind: "daily-trading-limits", revision: tradingLimitsRevision } as const }) };
    if (dailyRevision === undefined && limitsRevision === undefined && rawRevision === undefined) return stock;
    if (!isRevision(dailyRevision) || (limitsRevision !== undefined && !isRevision(limitsRevision)) ||
      (rawRevision !== undefined && (!isRevision(rawRevision) || limitsRevision === undefined))) throw invalid();
    return { ...stock, history: { ref: { version: 2, revision: dailyRevision }, ...(limitsRevision && { exchange: {
      tradingLimitArchiveRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision },
      ...(rawRevision && { rawArchiveRef: { version: 2, revision: rawRevision } }),
    } }) } };
  });
  return { marketRef: { version: 1, kind: "market-cross-section", revision: value.marketRevision }, adjustment: value.adjustment, stocks,
    ...(limitCalendar && { limitCalendar }) };
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

function StockListRow({ row, quote }: { row: ObservationListRowsPreview["rows"][number]; quote?: ObservationListQuoteRow }) {
  const { instrument, observations: { bar, basic, quantities, financial, tradingLimits },
    metrics: { liquidity, history, daily, signals, limitStreaks } } = row;
  return <details className="observation-list-stock">
    <summary>
      <span><strong>{instrument.name || instrument.symbol}</strong><span className="supporting">{instrument.symbol}</span></span>
      <span className="observation-list-price">收盘 {display(bar?.close, " 元")} · {display(bar?.returnPct, "%")}</span>
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
      {financial && <StockListFinancial financial={financial} />}
      <h5>WHYJ 计算</h5>
      <ListValues values={[
        ["流通市值（元）", display(liquidity.floatValueCny)], ["按流通股计算的换手率", display(liquidity.turnoverPct, "%")],
      ]} />
      <p className="supporting observation-ref">{liquidity.formula.id} v{liquidity.formula.version} · <code>{liquidity.formula.revision}</code></p>
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
    {result.limitCalendar && <p className="supporting observation-ref">连板日历 <code>{result.limitCalendar.revision}</code>
      {" · "}{result.limitCalendar.sessions[0]} 至 {result.limitCalendar.sessions.at(-1)}</p>}
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
      <p className="supporting">上传与 CLI 通用的 list-rows.json，读取当前工作区的市场截面以及可选的日线、限价和财务归档。</p>
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

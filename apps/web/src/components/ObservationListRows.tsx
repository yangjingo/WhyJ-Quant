import { useEffect, useRef, useState } from "react";
import type { ObservationListRowsPreview, ObservationListRowsRequest, WorkbenchClient } from "../client/contract";
import { ObservationDailyValues } from "./ObservationCollection";

const stockPattern = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const isRevision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("清单需要有效的市场截面修订、复权口径和最多 100 只不同的 A 股。");

export function listRowsManifest(value: unknown): ObservationListRowsRequest {
  if (!isObject(value) || Object.keys(value).some(key => !["version", "marketRevision", "adjustment", "stocks"].includes(key)) ||
    value.version !== 1 || !isRevision(value.marketRevision) || (value.adjustment !== "none" && value.adjustment !== "forward") ||
    !Array.isArray(value.stocks) || value.stocks.length > 100) throw invalid();
  const seen = new Set<string>();
  const stocks: ObservationListRowsRequest["stocks"] = value.stocks.map(entry => {
    if (!isObject(entry) || Object.keys(entry).some(key => !["symbol", "dailyRevision", "limitsRevision", "rawRevision"].includes(key))) throw invalid();
    const { symbol, dailyRevision, limitsRevision, rawRevision } = entry;
    if (typeof symbol !== "string" || !stockPattern.test(symbol) || seen.has(symbol)) throw invalid();
    seen.add(symbol);
    if (Object.keys(entry).length === 1) return { symbol };
    if (!isRevision(dailyRevision) || (limitsRevision !== undefined && !isRevision(limitsRevision)) ||
      (rawRevision !== undefined && (!isRevision(rawRevision) || limitsRevision === undefined))) throw invalid();
    return { symbol, history: { ref: { version: 2, revision: dailyRevision }, ...(limitsRevision && { exchange: {
      tradingLimitArchiveRef: { version: 1, kind: "daily-trading-limits", revision: limitsRevision },
      ...(rawRevision && { rawArchiveRef: { version: 2, revision: rawRevision } }),
    } }) } };
  });
  return { marketRef: { version: 1, kind: "market-cross-section", revision: value.marketRevision }, adjustment: value.adjustment, stocks };
}

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const display = (value: number | null | undefined, unit = "") => value == null ? "暂无" : numberFormat.format(value) + unit;

function ListValues({ values }: { values: [string, string][] }) {
  return <dl className="observation-indicator-values">
    {values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function StockListRow({ row }: { row: ObservationListRowsPreview["rows"][number] }) {
  const { instrument, observations: { bar, basic, quantities }, metrics: { liquidity, history, daily, signals } } = row;
  return <details className="observation-list-stock">
    <summary>
      <span><strong>{instrument.name || instrument.symbol}</strong><span className="supporting">{instrument.symbol}</span></span>
      <span className="observation-list-price">收盘 {display(bar?.close, " 元")} · {display(bar?.returnPct, "%")}</span>
    </summary>
    <div className="observation-list-detail">
      <h5>供应商行情与估值</h5>
      <ListValues values={[
        ["开盘（元）", display(bar?.open)], ["最高（元）", display(bar?.high)], ["最低（元）", display(bar?.low)], ["收盘（元）", display(bar?.close)],
        ["除权参考昨收（元）", display(bar?.exRightsPreviousClose)], ["涨跌额（元）", display(bar?.changeCny)], ["涨跌幅", display(bar?.returnPct, "%")],
        ["成交量（股）", display(quantities.volumeShares)], ["成交额（元）", display(quantities.amountCny)],
        ["换手率", display(basic?.turnoverPct, "%")], ["PE TTM", display(basic?.peTtm)], ["PB", display(basic?.pb)],
      ]} />
      <h5>WHYJ 计算</h5>
      <ListValues values={[
        ["流通市值（元）", display(liquidity.floatValueCny)], ["按流通股计算的换手率", display(liquidity.turnoverPct, "%")],
      ]} />
      <p className="supporting observation-ref">{liquidity.formula.id} v{liquidity.formula.version} · <code>{liquidity.formula.revision}</code></p>
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

export function ObservationListResult({ result }: { result: ObservationListRowsPreview }) {
  return <section className="observation-indicators observation-list-result" aria-label="历史列表结果">
    <h5>历史列表结果 <time dateTime={result.tradeDate}>{result.tradeDate}</time></h5>
    <p className="supporting">{result.rows.length} 只股票 · {result.source} · 日线计算{result.adjustment === "forward" ? "前复权" : "未复权"}</p>
    <p className="supporting">日行情 {result.observations.daily.observedAt} · 估值 {result.observations.dailyBasic.observedAt}</p>
    <p className="supporting observation-ref">市场截面 <code>{result.marketRef.revision}</code></p>
    {result.rows.length ? result.rows.map(row => <StockListRow key={row.instrument.symbol} row={row} />) : <p role="status">清单没有请求股票。</p>}
  </section>;
}

export function ObservationListRows({ read }: { read: WorkbenchClient["readObservationListRows"] }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ObservationListRowsPreview | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setBusy(false); setResult(null); setError("");
    return () => { generation.current++; };
  }, [read]);

  const load = async () => {
    if (!file || !read || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setError(""); setResult(null);
    try {
      if (file.size > 128 * 1024) throw new Error("清单文件不能超过 128 KB。");
      let value: unknown;
      try { value = JSON.parse(await file.text()); } catch { throw new Error("无法读取 JSON 清单。"); }
      const request = listRowsManifest(value);
      if (ticket !== generation.current) return;
      const preview = await read(request);
      if (ticket === generation.current) setResult(preview);
    } catch (cause) {
      if (ticket !== generation.current) return;
      const code = isObject(cause) ? cause.code : undefined;
      setError(code === "METHOD_NOT_FOUND" ? "当前服务不支持历史股票列表，请更新并重新连接。" :
        cause instanceof Error ? cause.message : "无法读取指定归档，请检查连接后重试。");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };

  return <div className="settings-group observation-list" aria-busy={busy}>
    <h4>历史股票列表</h4>
    {!read ? <p role="status">当前服务不支持历史股票列表，请更新并重新连接。</p> : <>
      <p className="supporting">选择与 CLI 回放通用的 list-rows.json，读取当前工作区的市场截面和可选日线归档。</p>
      <label className="field-row">列表清单<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        setFile(event.currentTarget.files?.[0] ?? null); setResult(null); setError("");
      }} /></label>
      <button type="button" className="action" disabled={!file || busy} onClick={() => void load()}>{busy ? "正在读取…" : "读取列表归档"}</button>
      {error && <p role="alert" className="operation-feedback error-feedback">{error}</p>}
      {result && <ObservationListResult result={result} />}
    </>}
  </div>;
}

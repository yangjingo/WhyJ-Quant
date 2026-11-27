import { useEffect, useRef, useState } from "react";
import type { ObservationCurrentStockMinutesPreview, ObservationCurrentStockMinutesRequest, WorkbenchClient } from "../client/contract";
import { ObservationListIntradayChart } from "./ObservationListIntradayChart";

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const shanghaiTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const stockPattern = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const invalid = () => new Error("清单需要上海当天日期、最多 100 只不同的 A 股，以及有效的可选分时口径和昨收引用。");

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}

export function currentStockMinutesManifest(value: unknown): ObservationCurrentStockMinutesRequest {
  const { version, tradeDate, stocks, interpretation: rawInterpretation } = fields(value, ["version", "tradeDate", "stocks", "interpretation"]);
  if (version !== 1 || tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(stocks) || !stocks.length || stocks.length > 100) throw invalid();
  let interpretation: ObservationCurrentStockMinutesRequest["interpretation"];
  if (rawInterpretation !== undefined) {
    const { timestampLabel, priceBasis } = fields(rawInterpretation, ["timestampLabel", "priceBasis"]);
    if ((timestampLabel !== "minute-start" && timestampLabel !== "minute-end") || priceBasis !== "caller-confirmed-unadjusted-CNY") throw invalid();
    interpretation = { timestampLabel, priceBasis };
  }
  const seen = new Set<string>();
  const targets = stocks.map((item: unknown) => {
    const { symbol, previousClose } = fields(item, ["symbol", "previousClose"]);
    const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
    if (!stockPattern.test(code) || seen.has(code)) throw invalid();
    seen.add(code);
    if (previousClose === undefined) return { symbol: code };
    const { revision, priceBasis } = fields(previousClose, ["revision", "priceBasis"]);
    if (!interpretation || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision) || priceBasis !== "caller-confirmed-same-basis") throw invalid();
    return { symbol: code, previousClose: { ref: { version: 1, kind: "daily-trading-limits", revision }, priceBasis } } as const;
  });
  return { tradeDate, stocks: targets, ...(interpretation && { interpretation }) };
}

const statuses = {
  observed: "已观测", empty: "供应商返回空帧", missing: "供应商未返回该标的",
  "different-session": "供应商返回其他交易日", "future-timestamp": "供应商帧含未来时间戳",
} as const;

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const show = (value: number | null) => value === null ? "暂无" : number.format(value);

export function CurrentStockMinuteResult({ result }: { result: ObservationCurrentStockMinutesPreview }) {
  const { minutes } = result.input;
  const [symbol, select] = useState(minutes.requestedSymbols[0]);
  const frame = minutes.frames.find(item => item.symbol === symbol);
  const row = result.rows.find(item => item.symbol === symbol);
  const latest = frame?.rows.at(-1);
  const chart = row?.metrics;
  const lastPoint = chart?.points.at(-1);
  return <div className="observation-list-result">
    <p className="supporting">TickFlow · {minutes.tradeDate} · <time dateTime={minutes.observedAt}>{minutes.observedAt}</time></p>
    <label className="field-row">查看股票<select value={symbol} onChange={event => select(event.currentTarget.value)}>
      {minutes.frames.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol} · {statuses[item.status]}</option>)}
    </select></label>
    {frame && <details className="observation-list-stock">
      <summary>TickFlow 原始分钟帧 · {statuses[frame.status]} · {frame.rows.length} 条</summary>
      {frame.sourceTradeDate && <p className="supporting">供应商交易日 {frame.sourceTradeDate}</p>}
      {latest && <p className="supporting">最新原始记录 {shanghaiTime.format(latest.sourceTimestamp)} · 收盘 {show(latest.close)}
        {" · "}成交量 {show(latest.volume)} · 成交额 {show(latest.amount)}（供应商单位）</p>}
    </details>}
    {chart && <section aria-label="WHYJ 临时分时指标">
      <p><strong>WHYJ 临时分时指标</strong></p>
      {lastPoint ? <>
        <p>最新分钟 {lastPoint.minute} · 收盘 {show(lastPoint.close)} 元 · 累计均价 {show(lastPoint.averageClose)} 元</p>
        <p>较昨收 {chart.latestReturnFraction === null ? "暂无昨收收益" : percent.format(chart.latestReturnFraction)}</p>
        <ObservationListIntradayChart points={chart.points} baseline={chart.plotBaseline?.value} />
      </> : <p role="status">暂无符合声明口径的分钟点。</p>}
      {!!row?.excluded.length && <p className="supporting">排除 {row.excluded.length} 条不符合分钟标签或交易时段的记录。</p>}
      <p className="supporting observation-ref">{chart.formula.id} v{chart.formula.version} · <code>{chart.formula.revision}</code></p>
    </section>}
  </div>;
}

export function ObservationCurrentStockMinutes({ read }: { read: WorkbenchClient["readObservationCurrentStockMinutes"] }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ObservationCurrentStockMinutesPreview | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    setBusy(false); setError(""); setResult(null);
    return () => { generation.current++; };
  }, [read]);
  const unsupported = "当前服务不支持当日股票分时，请更新并重新连接。";
  const load = async () => {
    if (!file || !read || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setError(""); setResult(null);
    try {
      if (file.size > 32 * 1024) throw new Error("清单文件不能超过 32 KB。");
      let value: unknown;
      try { value = JSON.parse(await file.text()); } catch { throw new Error("无法读取 JSON 清单。"); }
      const request = currentStockMinutesManifest(value);
      if (ticket !== generation.current) return;
      const preview = await read(request);
      if (ticket === generation.current) setResult(preview);
    } catch (cause) {
      if (ticket === generation.current)
        setError(cause instanceof Error && "code" in cause && cause.code === "METHOD_NOT_FOUND" ? unsupported
          : cause instanceof Error ? cause.message : "无法读取当日股票分时，请检查数据源后重试。");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  return <div className="settings-group observation-list" aria-busy={busy}>
    <h4>当日股票分时</h4>
    {!read ? <p role="status">{unsupported}</p> : <>
      <p className="supporting">上传与 CLI 通用的当日股票分时 JSON 清单。声明分时口径后可查看 WHYJ 临时指标。</p>
      <label className="field-row">当日分时清单<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        setFile(event.currentTarget.files?.[0] ?? null); setResult(null); setError("");
      }} /></label>
      <button type="button" className="action" disabled={!file || busy} onClick={() => void load()}>
        {busy ? "正在读取分时…" : "读取当日分时"}
      </button>
      {error && <p role="alert" className="operation-feedback error-feedback">{error}</p>}
      {result && <CurrentStockMinuteResult result={result} />}
    </>}
  </div>;
}

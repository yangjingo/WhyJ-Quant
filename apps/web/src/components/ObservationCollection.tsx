import { useEffect, useRef, useState } from "react";
import type { ObservationIndicatorPreview, ObservationJobRequest, ObservationJobView, WorkbenchClient } from "../client/contract";
import { ObservationIntraday } from "./ObservationIntraday";

type Dataset = "daily" | "daily-date" | "minute" | "factor" | "historical-minute-bars";
type Interval = "1m" | "5m" | "10m" | "15m" | "30m" | "60m";
export interface CollectionFields { dataset: Dataset; symbol: string; start: string; end: string; adjustment: "none" | "forward"; interval: Interval }
const day = 86_400_000;
const sessionKey = "whyj.observation-job.v1";
const pendingKey = "whyj.observation-start-pending.v1";
const stateEvent = "whyj-observation-state";

/** Date inputs represent Shanghai calendar dates, regardless of the browser's timezone. */
function shanghaiDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isFinite(time) && new Date(time + 8 * 3_600_000).toISOString().slice(0, 10) === value ? time : NaN;
}
export function observationRequest(fields: CollectionFields): ObservationJobRequest | null {
  if (fields.dataset === "historical-minute-bars") {
    const start = shanghaiDay(fields.start), end = shanghaiDay(fields.end);
    if (!/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(fields.symbol) ||
      !Number.isFinite(start) || !Number.isFinite(end) || fields.start < "2010-01-01" ||
      end < start || end - start > 30 * day || fields.end >= todayShanghai()) return null;
    return { dataset: fields.dataset, symbol: fields.symbol, startDate: fields.start, endDate: fields.end };
  }
  if (fields.dataset === "daily-date") {
    const date = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01" || value > "9998-12-31") return NaN;
      const time = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
    };
    const start = date(fields.start), end = date(fields.end);
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(fields.symbol) || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 365 * day) return null;
    return { dataset: "daily", timeMode: "trading-date", symbol: fields.symbol, startDate: fields.start, endDate: fields.end, adjustment: fields.adjustment };
  }
  const startTime = shanghaiDay(fields.start), endStart = shanghaiDay(fields.end);
  const endTime = endStart + day - 1;
  const max = fields.dataset === "minute" ? 31 : fields.dataset === "daily" ? 366 : 3660;
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(fields.symbol) || !Number.isFinite(startTime) || startTime <= 0
    || !Number.isFinite(endTime) || endStart < startTime || endTime - startTime > max * day) return null;
  const base = { symbol: fields.symbol, startTime, endTime };
  if (fields.dataset === "factor") return { ...base, dataset: "factor" };
  if (fields.dataset === "daily") return { ...base, dataset: "daily", adjustment: fields.adjustment };
  return { ...base, dataset: "minute", adjustment: fields.adjustment, interval: fields.interval };
}
function todayShanghai(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function readId(): string | null { try { return sessionStorage.getItem(sessionKey); } catch { return null; } }
function saveId(id: string | null) { try { if (id) sessionStorage.setItem(sessionKey, id); else sessionStorage.removeItem(sessionKey); } catch { /* session state is optional */ } }
function readPending(): boolean { try { return sessionStorage.getItem(pendingKey) === "1"; } catch { return false; } }
function savePending(value: boolean) { try { if (value) sessionStorage.setItem(pendingKey, "1"); else sessionStorage.removeItem(pendingKey); } catch { /* session state is optional */ } }

type PreviewState =
  | { status: "idle" | "loading" | "unsupported" | "failed" }
  | { status: "ready"; result: ObservationIndicatorPreview };
const indicatorLabels = { rsi6: "RSI 6", rsi14: "RSI 14", rsi24: "RSI 24", atr14: "ATR 14" } as const;
const indicatorKeys = Object.keys(indicatorLabels) as (keyof typeof indicatorLabels)[];

const indicatorGroups = [
  { label: "价格与区间", fields: {
    prev_close: "前收盘", change_amount: "涨跌额", change_pct: "涨跌幅", amplitude: "振幅",
    high_60d: "60 日最高收盘", low_60d: "60 日最低收盘",
  } },
  { label: "均线", fields: {
    ma5: "MA 5", ma10: "MA 10", ma20: "MA 20", ma30: "MA 30", ma60: "MA 60",
    ema5: "EMA 5", ema10: "EMA 10", ema20: "EMA 20", ema30: "EMA 30", ema60: "EMA 60",
  } },
  { label: "趋势与摆动", fields: {
    macd_dif: "MACD DIF", macd_dea: "MACD DEA", macd_hist: "MACD 柱值", boll_upper: "布林上轨", boll_lower: "布林下轨",
    kdj_k: "KDJ K", kdj_d: "KDJ D", kdj_j: "KDJ J", rsi_6: "RSI 6", rsi_14: "RSI 14", rsi_24: "RSI 24",
  } },
  { label: "波动与成交量", fields: {
    atr_14: "ATR 14", annual_vol_20d: "20 日年化波动率", vol_ma5: "5 日均量", vol_ma10: "10 日均量", vol_ratio_5d: "5 日量比",
  } },
  { label: "区间动量", fields: {
    momentum_5d: "5 日动量", momentum_10d: "10 日动量", momentum_20d: "20 日动量", momentum_30d: "30 日动量", momentum_60d: "60 日动量",
  } },
] as const;
const namedFields = new Set(indicatorGroups.flatMap(group => Object.keys(group.fields)));
const percentFields = new Set(["change_pct", "amplitude", "annual_vol_20d", "momentum_5d", "momentum_10d", "momentum_20d", "momentum_30d", "momentum_60d"]);
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 4 });

function indicatorValue(field: string, value: number | null): string {
  if (value === null) return "暂无";
  if (percentFields.has(field)) return percent.format(value);
  return decimal.format(value) + (field === "vol_ratio_5d" ? "×" : "");
}

export function ObservationDailyValues({ values, fields: suppliedFields }: {
  values: Record<string, number | null>;
  fields: readonly string[];
}) {
  const fields = new Set(suppliedFields);
  const groups: { label: string; entries: [string, string][] }[] = indicatorGroups.map(group => ({
    label: group.label, entries: Object.entries(group.fields).filter(([field]) => fields.has(field)),
  }));
  const other = [...fields].filter(field => !namedFields.has(field));
  if (other.length) groups.push({ label: "其他指标", entries: other.map(field => [field, field]) });

  return <div className="observation-indicator-groups">
      {groups.filter(group => group.entries.length).map((group, i) => <details key={group.label} open={i === 0}>
        <summary>{group.label}</summary>
        <dl className="observation-indicator-values">
          {group.entries.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{indicatorValue(field, values[field]!)}</dd></div>)}
        </dl>
      </details>)}
      <p className="supporting">暂无表示计算窗口或输入不足。</p>
  </div>;
}

/** Present the latest values from the fixed archive selected by the preview request. */
export function ObservationIndicatorResult({ result }: { result: ObservationIndicatorPreview }) {
  const { daily, input, rows } = result;
  const latest = rows.at(-1)!;
  const formula = daily?.formula ?? result.formula;
  const values = daily?.rows.at(-1)?.values;

  return <>
    <h5>日线指标预览 <time dateTime={latest.date}>{latest.date}</time></h5>
    <p className="supporting">数据源 {input.source} · {input.adjustment === "none" ? "未复权" : "前复权"} · {input.firstTradeDate} 至 {input.lastTradeDate} · {rows.length} 条</p>
    <p className="supporting observation-ref">WhyJ 计算 · 公式 v{formula.version} · TSP 修订 <code>{formula.revision}</code></p>
    {values && daily ? <ObservationDailyValues values={values} fields={daily.fields} /> : <dl className="observation-indicator-values">
      {indicatorKeys.map(key => <div key={key}><dt>{indicatorLabels[key]}</dt><dd>{latest[key].toFixed(2)}</dd></div>)}
    </dl>}
    <p className="supporting">指标从归档首日开始计算。历史覆盖和 K 线最终状态未知。</p>
  </>;
}

function ObservationIndicators({ read, archiveRef }: {
  read: WorkbenchClient["readObservationIndicators"];
  archiveRef: ObservationIndicatorPreview["archiveRef"];
}) {
  const [preview, setPreview] = useState<PreviewState>({ status: read ? "idle" : "unsupported" });
  const resultRegion = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview.status === "ready") resultRegion.current?.focus();
  }, [preview.status]);
  const load = async () => {
    if (!read || preview.status === "loading") return;
    setPreview({ status: "loading" });
    try {
      const result = await read(archiveRef);
      const latest = result.rows.at(-1);
      if (result.archiveRef.version !== archiveRef.version || result.archiveRef.revision !== archiveRef.revision
        || !latest || !indicatorKeys.every(key => Number.isFinite(latest[key]))) throw new Error("Invalid indicator preview");
      if (result.daily) {
        const { fields, rows, producer } = result.daily;
        const day = rows.at(-1);
        if (producer !== "whyj" || day?.date !== latest.date || fields.length === 0 || new Set(fields).size !== fields.length
          || !fields.every(field => Object.hasOwn(day.values, field) && (day.values[field] === null || Number.isFinite(day.values[field])))) {
          throw new Error("Invalid daily indicator preview");
        }
      }
      setPreview({ status: "ready", result });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      setPreview({ status: code === "METHOD_NOT_FOUND" || code === "UNAVAILABLE" ? "unsupported" : "failed" });
    }
  };
  if (preview.status === "ready") {
    return <section className="observation-indicators" ref={resultRegion} tabIndex={-1} aria-label="日线指标预览">
      <ObservationIndicatorResult result={preview.result} />
    </section>;
  }
  if (preview.status === "unsupported") return <p role="status" className="supporting">当前服务版本不支持日线指标预览。</p>;
  return <div className="observation-indicators">
    {preview.status === "failed" && <p role="alert" className="operation-feedback error-feedback">无法读取指标预览，请核对日线归档后重试。</p>}
    <button type="button" className="action" disabled={preview.status === "loading"} onClick={() => void load()}>
      {preview.status === "loading" ? "正在读取指标…" : preview.status === "failed" ? "重试指标预览" : "预览日线指标"}
    </button>
    {preview.status === "loading" && <p role="status" className="supporting">正在计算已归档日线。</p>}
  </div>;
}

export function ObservationCollection({ client }: { client: WorkbenchClient }) {
  const today = todayShanghai();
  const [fields, setFields] = useState<CollectionFields>({ dataset: "daily", symbol: "000001.SZ", start: today, end: today, adjustment: "none", interval: "1m" });
  const [jobId, setJobId] = useState<string | null>(readId);
  const [job, setJob] = useState<ObservationJobView | null>(null);
  const [problem, setProblem] = useState(() => readPending() ? "无法确认此前任务是否已启动；请先核实，再手动允许重新采集。" : ""); const [busy, setBusy] = useState(false); const [unknownStart, setUnknownStart] = useState(readPending);
  const [refresh, setRefresh] = useState(0); const mounted = useRef(false); const generation = useRef(0);
  const supported = !!(client.startObservationJob && client.readObservationJob && client.cancelObservationJob);
  const patch = (update: Partial<CollectionFields>) => setFields(current => ({ ...current, ...update }));
  useEffect(() => {
    mounted.current = true;
    const changed = () => { const id = readId(); if (id) { setJobId(id); setUnknownStart(false); setProblem(""); setRefresh(v => v + 1); } };
    window.addEventListener(stateEvent, changed);
    return () => { mounted.current = false; generation.current++; window.removeEventListener(stateEvent, changed); };
  }, []);
  useEffect(() => {
    if (!jobId || !supported) return;
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const ticket = generation.current;
      try {
        const value = await client.readObservationJob!(jobId);
        if (!alive || ticket !== generation.current) return;
        setJob(value); setProblem("");
        if (value.status === "running") timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!alive || ticket !== generation.current) return;
        const code = (error as { code?: string } | null)?.code;
        setProblem(code === "METHOD_NOT_FOUND" || code === "UNAVAILABLE" ? "当前服务版本不支持行情采集。" : code === "OBSERVATION_JOB_NOT_FOUND" ? "任务不存在或服务已重启；此前归档可能仍在本机。" : "无法确认任务状态，任务可能仍在运行。请重新查询。空结果不代表完成。") ;
      }
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [client, jobId, supported, refresh]);
  const running = job?.status === "running" || (!!jobId && !job);
  const savedRef = !busy && job?.id === jobId && job?.status === "archived" ? job.receipt?.ref : null;
  const previewRef = savedRef?.version === 2 ? savedRef : null;
  const minuteRef = savedRef?.version === 1 && "kind" in savedRef && savedRef.kind === "historical-minute-bars"
    ? { version: savedRef.version, kind: savedRef.kind, revision: savedRef.revision } as const
    : null;
  const request = observationRequest(fields);
  const start = async () => {
    if (!request || !client.startObservationJob || busy || running || unknownStart) return;
    setBusy(true); setProblem(""); savePending(true); const ticket = ++generation.current;
    try {
      const result = await client.startObservationJob(request);
      saveId(result.id); savePending(false); window.dispatchEvent(new Event(stateEvent));
      if (mounted.current && ticket === generation.current) { setJobId(result.id); setJob(result); setRefresh(v => v + 1); }
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (["METHOD_NOT_FOUND", "UNAVAILABLE", "OBSERVATION_BUSY", "INPUT_INVALID"].includes(code ?? "")) savePending(false);
      if (mounted.current && ticket === generation.current) {
        if (code === "METHOD_NOT_FOUND" || code === "UNAVAILABLE") setProblem("当前服务版本不支持行情采集。");
        else if (code === "OBSERVATION_BUSY" || code === "INPUT_INVALID") setProblem(code === "OBSERVATION_BUSY" ? "已有采集任务运行中，请稍后再试。" : request.dataset === "daily" && "timeMode" in request ? "交易日采集参数无效，或当前服务版本不支持此模式。请检查参数并更新服务。" : "采集参数无效，请检查后重试。");
        else { setUnknownStart(true); setProblem(request.dataset === "daily" && "timeMode" in request ? "无法确认交易日任务是否已启动；旧版服务可能不支持此模式。请先核实，再手动允许重新采集。" : "无法确认任务是否已启动；任务可能仍在后台运行。请先核实，再手动允许重新采集。"); }
      }
    } finally { if (mounted.current && ticket === generation.current) setBusy(false); }
  };
  const cancel = async () => {
    if (!jobId || !client.cancelObservationJob || busy) return;
    setBusy(true); setProblem(""); const ticket = ++generation.current;
    try { const result = await client.cancelObservationJob(jobId); if (mounted.current && ticket === generation.current) { setJob(result); setRefresh(v => v + 1); } }
    catch { if (mounted.current && ticket === generation.current) setProblem("无法确认取消状态；任务可能仍在运行。请重新查询。"); }
    finally { if (mounted.current && ticket === generation.current) setBusy(false); }
  };
  const clear = () => { generation.current++; saveId(null); savePending(false); setJobId(null); setJob(null); setProblem(""); setUnknownStart(false); };
  return <div className="settings-group observation-collection">
    <h4>行情采集</h4>
    <p className="supporting">使用已保存的数据源采集单个 A 股标的。日期按上海时间解释；结果保存在本机，不代表完整历史或 TSP 同步。</p>
    {!supported ? <p role="status">当前连接不支持行情采集，请更新并重新连接服务。</p> : <>
      <div className="data-source-grid">
        <label className="field-row">数据类型<select aria-label="采集数据类型" value={fields.dataset} disabled={running || busy} onChange={e => patch({ dataset: e.target.value as Dataset })}><option value="daily">日 K（按时间）</option><option value="daily-date">日 K（按交易日）</option><option value="minute">分钟 K</option><option value="historical-minute-bars">历史分时指标</option><option value="factor">复权因子</option></select></label>
        <label className="field-row">标的代码<input aria-label="采集标的代码" value={fields.symbol} disabled={running || busy} placeholder="000001.SZ" onChange={e => patch({ symbol: e.target.value.toUpperCase() })} /></label>
        <label className="field-row">开始日期<input aria-label="采集开始日期" type="date" value={fields.start} disabled={running || busy} onChange={e => patch({ start: e.target.value })} /></label>
        <label className="field-row">结束日期<input aria-label="采集结束日期" type="date" value={fields.end} disabled={running || busy} onChange={e => patch({ end: e.target.value })} /></label>
        {fields.dataset === "minute" && <label className="field-row">分钟周期<select aria-label="分钟周期" value={fields.interval} disabled={running || busy} onChange={e => patch({ interval: e.target.value as Interval })}>{["1m", "5m", "10m", "15m", "30m", "60m"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        {fields.dataset !== "factor" && fields.dataset !== "historical-minute-bars" && <label className="field-row">价格口径<select aria-label="采集价格口径" value={fields.adjustment} disabled={running || busy} onChange={e => patch({ adjustment: e.target.value as "none" | "forward" })}><option value="none">未复权</option><option value="forward">前复权</option></select></label>}
      </div>
      <p className="supporting">代码需包含交易所后缀；日线最多 366 天、分钟最多 31 天、因子最多 3660 天。实际权限和可用范围以返回结果为准。</p>
      {fields.dataset === "daily-date" && <p className="supporting">交易日模式支持 TickFlow 和 Tushare；Tushare 仅支持未复权。较旧的服务可能无法处理此模式。</p>}
      {fields.dataset === "historical-minute-bars" && <p className="supporting">历史分时使用 Tushare。采集日期须早于上海当天，窗口至多 31 天。</p>}
      {!request && <p className="operation-feedback error-feedback" role="status">请检查标的代码和日期范围。</p>}
      <div className="data-source-actions"><button className="action primary-action" type="button" disabled={!request || running || busy || unknownStart} onClick={() => void start()}>开始采集</button>
        {job?.status === "running" && <button className="action" type="button" disabled={busy || job.cancelRequested} onClick={() => void cancel()}>{job.cancelRequested ? "正在取消…" : "取消采集"}</button>}
        {jobId && problem && <button className="action" type="button" onClick={() => { setProblem(""); setRefresh(v => v + 1); }}>重新查询</button>}
        {jobId && problem && <button className="text-action" type="button" onClick={clear}>移除本页任务记录</button>}
        {unknownStart && <button className="text-action" type="button" onClick={() => { savePending(false); setUnknownStart(false); setProblem(""); }}>我已核实，允许重新采集</button>}</div>
      {job && <div className="data-source-result" role="status" aria-live="polite"><strong>{({ running: job.cancelRequested ? "正在取消，等待最终结果" : "采集中", archived: "已保存观察数据", empty: "未返回数据", failed: "采集失败", cancelled: "已取消" } as const)[job.status]}</strong>
        <p>{job.request.symbol} · {({ daily: "日 K", minute: "分钟 K", factor: "复权因子", "daily-trading-limits": "涨跌停价", "historical-minute-bars": "历史分时" } as const)[job.request.dataset]}{job.receipt && ` · ${job.receipt.source} · ${job.receipt.rowCount} 条 · 获取时间 ${job.receipt.observedAt}`}</p>
        {job.receipt?.ref && <p className="supporting observation-ref">归档引用（版本 {job.receipt.ref.version}）：<code>{job.receipt.ref.revision}</code></p>}
        <p className="supporting">状态仅保留在当前服务进程；关闭此面板不会取消任务。</p></div>}
      {previewRef && <ObservationIndicators key={`${jobId}:${previewRef.revision}`} archiveRef={previewRef} read={client.readObservationIndicators} />}
      {minuteRef && job?.request.dataset === "historical-minute-bars" && <ObservationIntraday key={`${jobId}:${minuteRef.revision}`}
        archiveRef={minuteRef} startDate={job.request.startDate} endDate={job.request.endDate} read={client.readObservationIntraday} />}
      {problem && <p className="operation-feedback error-feedback" role="alert">{problem}</p>}
    </>}
  </div>;
}

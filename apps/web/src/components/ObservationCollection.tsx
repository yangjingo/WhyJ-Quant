import { useEffect, useRef, useState } from "react";
import type { ObservationJobRequest, ObservationJobView, WorkbenchClient } from "../client/contract";

type Dataset = "daily" | "minute" | "factor";
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
        else if (code === "OBSERVATION_BUSY" || code === "INPUT_INVALID") setProblem(code === "OBSERVATION_BUSY" ? "已有采集任务运行中，请稍后再试。" : "采集参数无效，请检查后重试。");
        else { setUnknownStart(true); setProblem("无法确认任务是否已启动；任务可能仍在后台运行。请先核实，再手动允许重新采集。"); }
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
        <label className="field-row">数据类型<select aria-label="采集数据类型" value={fields.dataset} disabled={running || busy} onChange={e => patch({ dataset: e.target.value as Dataset })}><option value="daily">日 K</option><option value="minute">分钟 K</option><option value="factor">复权因子</option></select></label>
        <label className="field-row">标的代码<input aria-label="采集标的代码" value={fields.symbol} disabled={running || busy} placeholder="000001.SZ" onChange={e => patch({ symbol: e.target.value.toUpperCase() })} /></label>
        <label className="field-row">开始日期<input aria-label="采集开始日期" type="date" value={fields.start} disabled={running || busy} onChange={e => patch({ start: e.target.value })} /></label>
        <label className="field-row">结束日期<input aria-label="采集结束日期" type="date" value={fields.end} disabled={running || busy} onChange={e => patch({ end: e.target.value })} /></label>
        {fields.dataset === "minute" && <label className="field-row">分钟周期<select aria-label="分钟周期" value={fields.interval} disabled={running || busy} onChange={e => patch({ interval: e.target.value as Interval })}>{["1m", "5m", "10m", "15m", "30m", "60m"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        {fields.dataset !== "factor" && <label className="field-row">价格口径<select aria-label="采集价格口径" value={fields.adjustment} disabled={running || busy} onChange={e => patch({ adjustment: e.target.value as "none" | "forward" })}><option value="none">未复权</option><option value="forward">前复权</option></select></label>}
      </div>
      <p className="supporting">代码需包含交易所后缀；日线最多 366 天、分钟最多 31 天、因子最多 3660 天。实际权限和可用范围以返回结果为准。</p>
      {!request && <p className="operation-feedback error-feedback" role="status">请检查标的代码和日期范围。</p>}
      <div className="data-source-actions"><button className="action primary-action" type="button" disabled={!request || running || busy || unknownStart} onClick={() => void start()}>开始采集</button>
        {job?.status === "running" && <button className="action" type="button" disabled={busy || job.cancelRequested} onClick={() => void cancel()}>{job.cancelRequested ? "正在取消…" : "取消采集"}</button>}
        {jobId && problem && <button className="action" type="button" onClick={() => { setProblem(""); setRefresh(v => v + 1); }}>重新查询</button>}
        {jobId && problem && <button className="text-action" type="button" onClick={clear}>移除本页任务记录</button>}
        {unknownStart && <button className="text-action" type="button" onClick={() => { savePending(false); setUnknownStart(false); setProblem(""); }}>我已核实，允许重新采集</button>}</div>
      {job && <div className="data-source-result" role="status" aria-live="polite"><strong>{({ running: job.cancelRequested ? "正在取消，等待最终结果" : "采集中", archived: "已保存观察数据", empty: "未返回数据", failed: "采集失败", cancelled: "已取消" } as const)[job.status]}</strong>
        <p>{job.request.symbol} · {({ daily: "日 K", minute: "分钟 K", factor: "复权因子" } as const)[job.request.dataset]}{job.receipt && ` · ${job.receipt.source} · ${job.receipt.rowCount} 条 · 获取时间 ${job.receipt.observedAt}`}</p>
        {job.receipt?.ref && <p className="supporting observation-ref">归档引用：<code>{job.receipt.ref.revision}</code></p>}
        <p className="supporting">状态仅保留在当前服务进程；关闭此面板不会取消任务。</p></div>}
      {problem && <p className="operation-feedback error-feedback" role="alert">{problem}</p>}
    </>}
  </div>;
}

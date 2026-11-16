import { useEffect, useRef, useState } from "react";
import type { ArtifactSummary, SessionSnapshot, WorkbenchClient } from "../client/contract";
import type { ThesisTspSelection } from "../../../../src/types/thesis-archive";
import type { ThesisTspView } from "../../../../src/types/thesis-workbench";

type DraftSelection = Omit<ThesisTspSelection, "price"> & { price: (Omit<NonNullable<ThesisTspSelection["price"]>, "volumeUnit"> & { volumeUnit: "shares" | "lots" | "" }) | null };
export type SelectedTsp = { view: ThesisTspView; selection: DraftSelection };

export function ThesisTsp({ client, snapshot, baseline, value, onChange, onBusy, refresh, onReport }: {
  client: WorkbenchClient; snapshot: SessionSnapshot; baseline: ArtifactSummary; value: SelectedTsp | null;
  onChange(value: SelectedTsp | null): void; onBusy(value: boolean): void; refresh(): Promise<void>; onReport(artifact: ArtifactSummary): void;
}) {
  const [records, setRecords] = useState<ThesisTspView[]>([]), [loading, setLoading] = useState(false), [collecting, setCollecting] = useState(false);
  const [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const request = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const versions = snapshot.output.artifacts.filter(item => item.kind === "tsp-observation");
  const versionKey = versions.map(item => `${item.id}@${item.sha256}`).join("|");
  const ref = (artifact: ArtifactSummary) => ({ workspaceId: snapshot.identity.workspaceId, sessionId: snapshot.identity.sessionId, artifactId: artifact.id, sha256: artifact.sha256 });
  useEffect(() => {
    let active = true; setLoading(true);
    void Promise.allSettled(versions.map(item => client.readThesisTsp!(ref(item)))).then(results => {
      if (!active) return;
      setRecords(results.flatMap(result => result.status === "fulfilled" && result.value.baseline.artifactId === baseline.id && result.value.baseline.sha256 === baseline.sha256 ? [result.value] : []));
      if (results.some(result => result.status === "rejected")) setError("部分观察固定版本不可用，原文件已保留；不会用新采集替换。");
      setLoading(false);
    });
    return () => { active = false; };
  }, [client, versionKey, baseline.id, baseline.sha256, retry]);
  const select = (view: ThesisTspView | null) => {
    onChange(view ? { view, selection: { artifactId: view.artifact.id, revision: view.artifact.sha256, alertIndex: null, price: null } } : null);
    setError("");
  };
  const collect = async () => {
    if (collecting) return;
    setCollecting(true); onBusy(true); setError("");
    request.current ??= crypto.randomUUID();
    try {
      const latest = await client.session(snapshot.identity.sessionId);
      const result = await client.collectThesisTsp!({ ...ref(baseline), requestId: request.current, expectedRevision: latest.revision! });
      if (!live.current) return;
      setRecords(items => [...items.filter(item => item.artifact.id !== result.artifact.id), result]); select(result);
      await refresh(); request.current = null; setRetry(item => item + 1);
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : "采集失败，原记录已保留。"); }
    finally { if (live.current) { setCollecting(false); onBusy(false); } }
  };
  const update = (change: Partial<DraftSelection>) => { if (value) onChange({ ...value, selection: { ...value.selection, ...change } }); };
  const source = value?.view, window = value?.selection.price;
  return <section className="full thesis-tsp" aria-label="TSP 固定观察">
    <h3>可选 TSP 观察</h3><p className="supporting">显式采集只读提醒与日线。提醒只作价格事件，基本面判断仍需原始披露。打开此表单不会连接 TSP。</p>
    <div className="thesis-actions"><button type="button" className="action" disabled={collecting || !client.collectThesisTsp} onClick={() => void collect()}>{collecting ? "正在采集 TSP…" : request.current ? "重试本次 TSP 采集" : "采集一次 TSP 观察"}</button>
      <button type="button" className="text-action" disabled={collecting} onClick={() => { setError(""); setRetry(item => item + 1); }}>重读固定观察</button></div>
    {loading && <p role="status">正在读取已保存的观察…</p>}
    {error && <p role="alert">{error} 请检查全局 Pi 的 tsp 只读配置；可重试本次请求，或继续手动复核。</p>}
    <label>本次使用的固定观察<select value={source ? `${source.artifact.id}@${source.artifact.sha256}` : ""} onChange={event => select(records.find(item => `${item.artifact.id}@${item.artifact.sha256}` === event.target.value) ?? null)}>
      <option value="">不附加 TSP 观察</option>{records.map(item => <option key={item.artifact.id + item.artifact.sha256} value={`${item.artifact.id}@${item.artifact.sha256}`}>{new Date(item.recordedAt).toLocaleString()} · {item.artifact.sha256.slice(0, 12)}</option>)}
    </select></label>
    {source && <>
      <p className="supporting">固定于 {new Date(source.recordedAt).toLocaleString()}。保存复核会引用这一版本，观察截止同步到本次选择时间。</p>
      <ul>{source.observations.map(item => <li key={item.tool}>{item.tool}：{item.status === "available" ? "已保留原始 JSON，语义待核对" : "不可用"} · {new Date(item.retrievedAt).toLocaleString()}{item.reason && ` · ${item.reason}`}</li>)}</ul>
      <button className="text-action" type="button" onClick={() => onReport(source.artifact)}>查看原始观察（离开表单）</button>
      <label>使用提醒作为价格事件<select value={value.selection.alertIndex ?? ""} onChange={event => update({ alertIndex: event.target.value === "" ? null : Number(event.target.value) })}>
        <option value="">只作背景，手动填写事件</option>{source.alerts.map(item => <option key={item.index} value={item.index}>{new Date(item.event.occurredAt).toLocaleString()} · {item.event.summary}</option>)}
      </select></label>
      {source.alertsReason && <p>{source.alertsReason}</p>}{source.omittedAlerts > 0 && <p className="supporting">另有 {source.omittedAlerts} 条提醒未纳入此股票的选择列表。</p>}
      {source.daily ? <>
        <label className="thesis-check"><input type="checkbox" checked={!!window} onChange={event => update({ price: event.target.checked ? { start: source.daily!.start, end: source.daily!.end, volumeUnit: "" } : null })} />使用 TSP 固定日线绘图</label>
        <p className="supporting">{source.daily.count} 条采集日前日线 · {source.daily.start} 至 {source.daily.end} · 前复权。排除当日未完成数据；工具 limit 不保证窗口。请核实成交量单位。</p>
        {window && <div className="thesis-form">
          <label>日线开始<input type="date" required value={window.start} min={source.daily.start} max={source.daily.end} onChange={event => update({ price: { ...window, start: event.target.value } })} /></label>
          <label>日线结束<input type="date" required value={window.end} min={source.daily.start} max={source.daily.end} onChange={event => update({ price: { ...window, end: event.target.value } })} /></label>
          <label>确认 TSP 成交量单位<select required value={window.volumeUnit} onChange={event => update({ price: { ...window, volumeUnit: event.target.value as "shares" | "lots" } })}><option value="">请选择已核实单位</option><option value="shares">股</option><option value="lots">手</option></select></label>
        </div>}
      </> : <p>{source.dailyReason ?? "无可用日线；未补造行情。"}</p>}
    </>}
  </section>;
}

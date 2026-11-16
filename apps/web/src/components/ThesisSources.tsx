import { useEffect, useRef, useState } from "react";
import type { ArtifactSummary, SessionSnapshot, WorkbenchClient } from "../client/contract";
import type { ThesisSourcesView } from "../../../../src/types/thesis-workbench";

export type SelectedSources = { view: ThesisSourcesView; disclosure: null | { page: number; quote: string; publishedAt: string; confirmed: boolean } };
const localTime = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 23); };
const day = (ago: number) => new Date(Date.now() + 8 * 3_600_000 - ago * 86_400_000).toISOString().slice(0, 10);

/** All collection is explicit; selecting a retained page never fetches the remote PDF. */
export function ThesisSources({ client, snapshot, baseline, value, onChange, onBusy, refresh, onReport }: {
  client: WorkbenchClient; snapshot: SessionSnapshot; baseline: ArtifactSummary; value: SelectedSources | null;
  onChange(value: SelectedSources | null): void; onBusy(value: boolean): void; refresh(): Promise<void>; onReport(artifact: ArtifactSummary): void;
}) {
  const [records, setRecords] = useState<ThesisSourcesView[]>([]), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [retry, setRetry] = useState(0), [page, setPage] = useState<ThesisSourcesView["page"]>(null);
  const [start, setStart] = useState(() => day(30)), [end, setEnd] = useState(() => day(1)), [url, setUrl] = useState("");
  const request = useRef<{ payload: string; id: string } | null>(null), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const versions = snapshot.output.artifacts.filter(item => item.kind === "source-check");
  const versionKey = versions.map(item => `${item.id}@${item.sha256}`).join("|");
  const ref = (artifact: ArtifactSummary) => ({ workspaceId: snapshot.identity.workspaceId, sessionId: snapshot.identity.sessionId, artifactId: artifact.id, sha256: artifact.sha256 });
  useEffect(() => {
    let active = true; setLoading(true);
    void Promise.allSettled(versions.map(item => client.readThesisSources!(ref(item)))).then(results => {
      if (!active) return;
      setRecords(results.flatMap(result => result.status === "fulfilled" && result.value.baseline.artifactId === baseline.id && result.value.baseline.sha256 === baseline.sha256 ? [result.value] : []));
      if (results.some(result => result.status === "rejected")) setError("部分固定来源无法验证，原记录已保留；不会重新采集替代。");
      setLoading(false);
    });
    return () => { active = false; };
  }, [client, versionKey, baseline.id, baseline.sha256, retry]);
  const select = (view: ThesisSourcesView | null) => { setPage(null); setError(""); onChange(view ? { view, disclosure: null } : null); };
  const collect = async () => {
    if (busy) return;
    setBusy(true); onBusy(true); setError("");
    const body = { ...ref(baseline), start, end, disclosureUrl: url.trim() || null }, payload = JSON.stringify(body);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    try {
      const latest = await client.session(snapshot.identity.sessionId);
      const result = await client.collectThesisSources!({ ...body, requestId: request.current.id, expectedRevision: latest.revision! });
      if (!live.current) return;
      setRecords(items => [...items.filter(item => item.artifact.id !== result.artifact.id), result]); select(result);
      await refresh(); request.current = null; setRetry(item => item + 1);
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : "来源读取失败，可重试同一请求。"); }
    finally { if (live.current) { setBusy(false); onBusy(false); } }
  };
  const readPage = async (number: number) => {
    if (!value || busy) return;
    setPage(null); onChange({ ...value, disclosure: null });
    if (!number) return;
    setBusy(true); onBusy(true); setError("");
    try {
      const result = await client.readThesisSources!({ ...ref(value.view.artifact), page: number });
      if (live.current) setPage(result.page);
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : "固定页无法读取。"); }
    finally { if (live.current) { setBusy(false); onBusy(false); } }
  };
  const source = value?.view, disclosure = value?.disclosure;
  const update = (change: Partial<NonNullable<SelectedSources["disclosure"]>>) => { if (value && disclosure) onChange({ ...value, disclosure: { ...disclosure, ...change } }); };
  return <section className="full thesis-sources" aria-label="行情与公告核对">
    <h3>行情与公告核对</h3><p className="supporting">读取配置行情源及可选的交易所/巨潮公告 PDF。日期与 TSP 图表一致时才可比较；原文仍需核对发行人、日期和指标口径。</p>
    <div className="thesis-form">
      <label>核对开始日期<input type="date" value={start} max={end} onChange={event => setStart(event.target.value)} /></label>
      <label>核对结束日期<input type="date" value={end} min={start} max={day(1)} onChange={event => setEnd(event.target.value)} /></label>
      <label className="full">公告 PDF 直链（可留空）<input type="url" value={url} maxLength={2048} placeholder="https://static.cninfo.com.cn/…pdf" onChange={event => setUrl(event.target.value)} /></label>
    </div>
    <div className="thesis-actions"><button type="button" className="action" disabled={busy || !client.collectThesisSources} onClick={() => void collect()}>{busy ? "正在读取来源…" : request.current ? "重试本次来源核对" : "读取一次核对来源"}</button>
      <button type="button" className="text-action" disabled={busy} onClick={() => { setError(""); setRetry(item => item + 1); }}>重读固定来源</button></div>
    {loading && <p role="status">正在核验已有来源…</p>}{error && <p role="alert">{error}</p>}
    <label>本次使用的核对来源<select value={source ? `${source.artifact.id}@${source.artifact.sha256}` : ""} onChange={event => select(records.find(item => `${item.artifact.id}@${item.artifact.sha256}` === event.target.value) ?? null)}>
      <option value="">不附加来源核对</option>{records.map(item => <option key={item.artifact.id + item.artifact.sha256} value={`${item.artifact.id}@${item.artifact.sha256}`}>{new Date(item.recordedAt).toLocaleString()} · {item.artifact.sha256.slice(0, 12)}</option>)}
    </select></label>
    {source && <>
      <p>行情：{source.price.status === "available" ? `${source.price.source} · ${source.price.origin} · ${source.price.barCount} 条` : source.price.reason} · {source.price.start} 至 {source.price.end}</p>
      <p>公告：{source.disclosure ? `${source.disclosure.status} · ${source.disclosure.reason}` : "未请求公告；不能由行情推断基本面事实。"}</p>
      <button type="button" className="text-action" onClick={() => onReport(source.artifact)}>查看固定来源报告（离开表单）</button>
      {!!source.disclosure?.pages.length && <>
        <p className="supporting">共 {source.disclosure.totalPages} 页 · 取得 {new Date(source.disclosure.fetchedAt).toLocaleString()} · 发行人代码线索 {source.disclosure.symbolMention}。文件摘要与完整分页提取保留在固定来源报告中。</p>
        <label>读取公告页<select value={page?.page ?? ""} onChange={event => void readPage(Number(event.target.value))}><option value="">请选择页码</option>{source.disclosure.pages.map(item => <option key={item.page} value={item.page}>第 {item.page} 页 · {item.characters} 字符</option>)}</select></label>
        {page && <>
          <label>固定页原文<textarea readOnly rows={7} value={page.text} /></label>{page.truncated && <p>此页预览已截断；完整提取见固定来源报告。</p>}
          <label className="thesis-check"><input type="checkbox" checked={!!disclosure} onChange={event => onChange({ ...value!, disclosure: event.target.checked ? { page: page.page, quote: "", publishedAt: localTime(), confirmed: false } : null })} />用此页原文作为本次指标证据</label>
          {disclosure && <>
            <label>逐字引用原文<textarea required rows={3} maxLength={4000} value={disclosure.quote} onChange={event => update({ quote: event.target.value, confirmed: false })} /></label>
            <label>公告实际发布时间（本机时区）<input type="datetime-local" step="0.001" required value={disclosure.publishedAt} onChange={event => update({ publishedAt: event.target.value, confirmed: false })} /></label>
            <p className="supporting">在下方填写指标口径与新观察数值；原文必须与该页逐字匹配。时间默认值仅便于输入，请按公告核实。</p>
            <label className="thesis-check"><input type="checkbox" checked={disclosure.confirmed} onChange={event => update({ confirmed: event.target.checked })} />我已核对发行人、发布时间、引用原文和下方指标口径</label>
            {!disclosure.confirmed && <p>未确认的原文作为解释判断，基本面结论保留待核验。</p>}
          </>}
        </>}
      </>}
    </>}
  </section>;
}

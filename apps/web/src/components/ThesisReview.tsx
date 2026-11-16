import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtifactSummary, SessionSnapshot, WorkbenchClient } from "../client/contract";
import type { ThesisBaselineRequest, ThesisReviewRequest, ThesisView } from "../../../../src/types/thesis-workbench";
import type { ThesisReviewInput } from "../../../../src/types/thesis-review";
import { HOST_MAX_REQUEST_BYTES } from "../../../../src/types/workbench-host";
import { Dialog } from "./UI";
import { ThesisTsp, type SelectedTsp } from "./ThesisTsp";
import { ThesisSources, type SelectedSources } from "./ThesisSources";

const outcomes = { price_observation: "价格观察", assumption_review: "需要复核假设", pending_verification: "待核验", no_material_change: "无实质变化" };
const localTime = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
const instant = (value: string) => new Date(value).toISOString();
const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
type Baseline = Extract<ThesisView, { kind: "baseline" }>;

/** Manual private records share the current Host; this panel never starts a model run. */
export function ThesisDashboard({ client, snapshot, portfolio, refresh, onReport }: {
  client: WorkbenchClient; snapshot: SessionSnapshot; portfolio: string; refresh(): Promise<void>; onReport(artifact: ArtifactSummary): void;
}) {
  const [views, setViews] = useState<ThesisView[]>([]), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0), [page, setPage] = useState<"list" | "baseline" | "review" | null>(null);
  const [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [saved, setSaved] = useState<ArtifactSummary | null>(null);
  const [tsp, setTsp] = useState<SelectedTsp | null>(null), [tspBusy, setTspBusy] = useState(false);
  const [checks, setChecks] = useState<SelectedSources | null>(null), [checksBusy, setChecksBusy] = useState(false);
  const working = busy || tspBusy || checksBusy;
  const [formTime, setFormTime] = useState(localTime);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const form = useRef<HTMLFormElement>(null), feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { setTsp(null); setTspBusy(false); setChecks(null); setChecksBusy(false); setPage(null); setSelected(""); }, [snapshot.identity.workspaceId, snapshot.identity.sessionId]);
  const artifacts = snapshot.output.artifacts;
  const versionKey = artifacts.map(item => `${item.id}@${item.sha256}`).join("|");
  const ref = (artifact: ArtifactSummary) => ({ workspaceId: snapshot.identity.workspaceId, sessionId: snapshot.identity.sessionId, artifactId: artifact.id, sha256: artifact.sha256 });
  useEffect(() => {
    let active = true; setLoading(true); setLoadError("");
    const records = artifacts.filter(item => item.kind === "thesis-baseline" || item.kind === "thesis-review");
    void Promise.allSettled(records.map(item => client.readThesis!(ref(item)))).then(results => {
      if (!active) return;
      setViews(results.flatMap(result => result.status === "fulfilled" ? [result.value] : []));
      if (results.some(result => result.status === "rejected")) setLoadError("部分固定记录无法核验，已保留原文件。可重新读取；不会使用最新版本替代。");
      setLoading(false);
    });
    return () => { active = false; };
  }, [client, versionKey, snapshot.identity.workspaceId, snapshot.identity.sessionId, retry]);
  useEffect(() => { if (error) feedback.current?.focus(); }, [error]);
  const bases = views.filter((item): item is Baseline => item.kind === "baseline");
  const reviews = views.filter(item => item.kind === "review");
  const pending = reviews.filter(item => item.result.outcome === "pending_verification" || item.result.outcome === "assumption_review" && !item.result.input.decision).length;
  const base = bases.find(item => item.artifact.id === selected) ?? bases[0];
  const open = (next: typeof page) => { setPage(next); setError(""); setSaved(null); setTsp(null); setChecks(null); setFormTime(localTime()); request.current = null; };
  const selectedAlert = tsp?.view.alerts.find(item => item.index === tsp.selection.alertIndex);
  const selectTsp = (value: SelectedTsp | null) => {
    setTsp(value); setError("");
    const field = (name: string, text: string) => { const item = form.current?.elements.namedItem(name) as HTMLInputElement | null; if (item) item.value = text; };
    if (value) {
      field("cutoff", localTime(new Date(Math.max(Date.now(), Date.parse(value.view.recordedAt)))));
      const alert = value.view.alerts.find(item => item.index === value.selection.alertIndex);
      if (alert) { field("kind", "price"); field("occurred", localTime(new Date(alert.event.occurredAt))); field("summary", alert.event.summary); field("eventUrl", alert.event.sourceUrl); field("decided", localTime()); }
    }
  };
  const selectChecks = (value: SelectedSources | null) => {
    if (value && value.view.artifact.sha256 !== checks?.view.artifact.sha256) {
      const cutoff = form.current?.elements.namedItem("cutoff") as HTMLInputElement | null;
      if (cutoff) cutoff.value = localTime(new Date(Math.max(Date.now(), Date.parse(value.view.recordedAt))));
    }
    setChecks(value); setError("");
  };
  const submit = async () => {
    if (!form.current || working || !form.current.reportValidity()) return;
    const data = new FormData(form.current), text = (key: string) => String(data.get(key) ?? "").trim();
    const number = (key: string) => { const value = text(key); if (!value || !Number.isFinite(Number(value))) throw new Error("请填写有效数值。"); return Number(value); };
    setBusy(true); setError(""); setSaved(null);
    try {
      let body: Omit<ThesisBaselineRequest, "requestId" | "expectedRevision"> | Omit<ThesisReviewRequest, "requestId" | "expectedRevision">;
      if (page === "baseline") {
        const source = artifacts.find(item => `${item.id}@${item.sha256}` === text("source")); if (!source) throw new Error("请先选择当前会话的一份固定报告。");
        body = { ...ref(source), groupId: text("group"), symbol: text("symbol"), assumption: { assumptionId: "manual-assumption", statement: text("statement"),
          metric: { name: text("metric"), value: number("before"), period: text("period"), unit: text("unit"), definition: text("definition"), adjustment: text("adjustment") as "none" | "forward" | "backward" },
          threshold: { operator: text("operator") as "gt" | "gte" | "lt" | "lte", value: number("threshold") } } };
      } else {
        if (!base) throw new Error("请先设立并读取一条假设基线。");
        const raw = text("excerpt"), observed = text("after"), kind = selectedAlert?.event.kind ?? text("kind") as ThesisReviewInput["event"]["kind"];
        if (!checks?.disclosure && !!raw !== !!observed) throw new Error("观察数值与来源摘录需要同时填写；均留空时生成待核验记录。");
        if (checks?.disclosure && raw) throw new Error("本次原文证据已来自固定公告页，请清空手动摘录。");
        const cutoff = instant(text("cutoff")), occurredAt = instant(text("occurred"));
        const dataRef = raw ? { id: "manual-source", sha256: await sha256(raw) } : null;
        const evidence: ThesisReviewInput["evidence"] = raw ? [{ id: "manual-observation", symbol: base.symbol, kind: kind === "price" ? "price" : "fundamental", sourceUrl: text("sourceUrl"),
          publishedAt: instant(text("published")), retrievedAt: instant(text("retrieved")), origin: text("origin") as "source" | "calculation" | "interpretation", dataRef,
          metric: { name: text("metric"), value: number("after"), period: text("period"), unit: text("unit"), definition: text("definition"), adjustment: text("adjustment") as "none" | "forward" | "backward" } }] : [];
        body = { ...ref(base.artifact), cutoff, event: selectedAlert?.event ?? { id: "manual-event", kind, occurredAt, sourceUrl: text("eventUrl"), summary: text("summary") }, evidence,
          parameters: { entry: "manual-workbench" }, retainedEvidence: raw ? [{ id: "manual-source", mediaType: "text/plain", content: raw }] : [], price: null,
          decision: text("decision") ? { action: text("decision") as "maintain" | "revise" | "defer", rationale: text("rationale"), decidedAt: instant(text("decided")) } : null };
        if (checks) {
          const selected = checks.disclosure;
          body = { ...body, checks: { artifactId: checks.view.artifact.id, revision: checks.view.artifact.sha256,
            disclosure: selected ? { ...selected, publishedAt: instant(selected.publishedAt), metric: {
              name: text("metric"), value: number("after"), period: text("period"), unit: text("unit"), definition: text("definition"),
              adjustment: text("adjustment") as "none" | "forward" | "backward" } } : null } };
        }
        const csv = text("prices");
        if (tsp) {
          const window = tsp.selection.price;
          if (window && !window.volumeUnit) throw new Error("请先确认 TSP 成交量单位。");
          if (window && csv) throw new Error("本次只选一种固定价量来源，请清空手动日线或取消 TSP 绘图。");
          body = { ...body, tsp: { ...tsp.selection, price: window ? { ...window, volumeUnit: window.volumeUnit as "shares" | "lots" } : null } };
        }
        if (csv) {
          const lines = csv.split(/\r?\n/).filter(line => line.trim());
          if (lines[0]?.trim() === "date,open,high,low,close,vol") lines.shift();
          if (lines.length < 2 || lines.length > 100) throw new Error("请填写 2 至 100 行固定日线数据。");
          const rows = lines.map(line => {
            const [date, ...values] = line.split(",").map(part => part.trim());
            if (values.length !== 5 || values.some(value => !value || !Number.isFinite(Number(value)))) throw new Error("行情每行需要日期、开、高、低、收、量六列，用英文逗号分隔。");
            return { date: date!, open: Number(values[0]), high: Number(values[1]), low: Number(values[2]), close: Number(values[3]), vol: Number(values[4]) };
          });
          body = { ...body, price: { symbol: base.symbol, sourceUrl: text("priceUrl"), retrievedAt: instant(text("priceRetrieved")), adjustment: text("priceAdjustment") as "none" | "forward" | "backward", currency: "CNY", volumeUnit: text("volumeUnit") as "shares" | "lots", rows, dataRef: { id: "manual-prices", sha256: await sha256(csv) } },
            retainedEvidence: [...body.retainedEvidence, { id: "manual-prices", mediaType: "text/plain", content: csv }] };
        }
      }
      const payload = JSON.stringify(body);
      if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
      const latest = await client.session(snapshot.identity.sessionId);
      const command = { ...body, requestId: request.current!.id, expectedRevision: latest.revision! };
      if (new TextEncoder().encode(JSON.stringify({ method: page === "baseline" ? "establishThesis" : "saveThesisReview", args: [command] })).byteLength > HOST_MAX_REQUEST_BYTES)
        throw new Error("来源摘录与行情超过本次保存容量，请缩短为本次判断所需的片段。");
      const result = page === "baseline" ? await client.establishThesis!(command as ThesisBaselineRequest) : await client.saveThesisReview!(command as ThesisReviewRequest);
      setSaved(result); await refresh(); setRetry(value => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败，输入与原记录已保留。"); }
    finally { setBusy(false); }
  };
  const metricFields = (baseline?: Baseline) => <>
    <label>指标名称<input name="metric" required defaultValue={baseline?.assumption.metric.name ?? ""} /></label>
    <label>报告期<input name="period" required defaultValue={baseline?.assumption.metric.period ?? ""} placeholder="例如 2026-Q3" /></label>
    <label>计量单位<input name="unit" required defaultValue={baseline?.assumption.metric.unit ?? ""} placeholder="例如 percent" /></label>
    <label>业务定义<input name="definition" required defaultValue={baseline?.assumption.metric.definition ?? ""} /></label>
    <label>复权口径<select name="adjustment" defaultValue={baseline?.assumption.metric.adjustment ?? "none"}><option value="none">不复权 / 不适用</option><option value="forward">前复权</option><option value="backward">后复权</option></select></label>
  </>;
  const status = <>{loading && <p role="status">正在核验固定记录…</p>}{loadError && <p role="alert">{loadError} <button className="text-action" onClick={() => setRetry(value => value + 1)}>重新读取记录</button></p>}</>;
  return <section className="thesis-dashboard" aria-label="事件与假设复核">
    <div className="thesis-heading"><strong>事件与假设</strong><button className="text-action" onClick={() => open("list")}>查看复核记录 ↗</button></div>
    <p>{pending ? `${pending} 条待处理` : reviews.length ? "已核验记录暂无待处理项" : "尚无事件复核"} · {bases.length} 条基线</p>{status}
    <p className="supporting">人工登记并保留固定版本；价格变化与假设变化分开判断。</p>
    {page && createPortal(<Dialog title="事件与假设复核" className="thesis-dialog" onClose={() => { if (!working) setPage(null); }}>
      <nav className="thesis-tabs" aria-label="复核操作"><button className="action" disabled={working} aria-pressed={page === "list"} onClick={() => open("list")}>固定记录</button><button className="action" disabled={working || !artifacts.length} aria-pressed={page === "baseline"} onClick={() => open("baseline")}>设立假设基线</button><button className="action" disabled={working || !bases.length} aria-pressed={page === "review"} onClick={() => open("review")}>登记事件复核</button></nav>
      <div className="thesis-content">{status}
        {page === "list" ? <>{!views.length && !loading && <p className="empty-state">尚无可核验的基线或复核。先保存一份研究报告，再明确设立假设基线。</p>}
          {[...views].reverse().map(item => <article className="thesis-record" key={item.artifact.id}>
            <p className="eyebrow">{item.kind === "baseline" ? "人工基线" : outcomes[item.result.outcome]}</p><h3>{item.artifact.title}</h3>
            <p>{item.kind === "baseline" ? item.assumption.statement : item.result.input.event.summary}</p>
            <small>登记于 {new Date(item.recordedAt).toLocaleString()} · 固定版本 {item.artifact.sha256.slice(0, 12)}</small>
            {item.kind === "review" && <p>{item.result.input.decision ? `已记录人工决定：${({ maintain: "维持", revise: "修订", defer: "暂缓" })[item.result.input.decision.action]} · ${item.result.input.decision.rationale}` : "尚未记录人工决定；分类不代表投资操作。"}</p>}
            <div className="thesis-actions"><button className="action" onClick={() => { setPage(null); onReport(item.artifact); }}>打开固定报告</button>
              <button className="text-action" onClick={() => { const prior = artifacts.find(artifact => artifact.id === item.source.artifactId && artifact.sha256 === item.source.sha256); if (prior) { setPage(null); onReport(prior); } }}>查看{item.kind === "review" ? "原基线" : "参考报告"}</button>
              {item.kind === "baseline" && <button className="text-action" onClick={() => { setSelected(item.artifact.id); open("review"); }}>复核此假设</button>}
              {item.kind === "review" && item.tsp && <button className="text-action" onClick={() => { setPage(null); onReport(item.tsp!.artifact); }}>查看固定 TSP 来源</button>}
              {item.kind === "review" && item.checks && <button className="text-action" onClick={() => { setPage(null); onReport(item.checks!.view.artifact); }}>查看行情与公告来源</button>}</div>
          </article>)}</> : <form ref={form} key={page + (page === "review" ? base?.artifact.id : "")} onChange={event => {
          const target = event.target;
          const name = target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.name : "";
          if (checks?.disclosure?.confirmed && ["metric", "period", "unit", "definition", "adjustment", "after"].includes(name))
            setChecks({ ...checks, disclosure: { ...checks.disclosure, confirmed: false } });
        }} onSubmit={event => { event.preventDefault(); void submit(); }}>
          <p className="supporting">{page === "baseline" ? "这是现在明确设立的假设，不会补写为历史事实。生效前的事件只能待核验。" : "新观察的指标、报告期、单位和定义必须可比。摘录仅作私有归档，不代表已核验外部事实。"}</p>
          <fieldset disabled={working || !!saved || snapshot.state === "running"} className="thesis-form">
          {page === "baseline" ? <>
            <label className="full">参考固定报告<select name="source" required>{artifacts.filter(item => !item.kind).map(item => <option key={item.id + item.sha256} value={`${item.id}@${item.sha256}`}>{item.title} · {item.sha256.slice(0, 8)}</option>)}</select></label>
            <label>观察组<input name="group" required defaultValue={portfolio} /></label><label>A 股代码<input name="symbol" required pattern="[0-9]{6}\.(SH|SZ|BJ)" placeholder="600000.SH" /></label>
            <label className="full">假设陈述<textarea name="statement" required maxLength={2000} rows={2} /></label>{metricFields()}
            <label>当前基线数值<input name="before" type="number" step="any" required /></label><label>假设成立条件<select name="operator" defaultValue="gte"><option value="gte">大于等于 ≥</option><option value="gt">大于 &gt;</option><option value="lte">小于等于 ≤</option><option value="lt">小于 &lt;</option></select></label><label>阈值<input name="threshold" type="number" step="any" required /></label>
          </> : <>
            <label className="full">固定假设基线<select value={base?.artifact.id ?? ""} onChange={event => { setSelected(event.target.value); setTsp(null); setChecks(null); setError(""); request.current = null; }}>{bases.map(item => <option key={item.artifact.id} value={item.artifact.id}>{item.symbol} · {item.assumption.statement}</option>)}</select></label>
            {base && <p className="full supporting">基线：{base.assumption.metric.value} {base.assumption.metric.unit} · 生效 {new Date(base.recordedAt).toLocaleString()}。前一份报告保持不变。</p>}
            {base && <ThesisTsp key={snapshot.identity.sessionId + base.artifact.id} client={client} snapshot={snapshot} baseline={base.artifact} value={tsp} onChange={selectTsp} onBusy={setTspBusy} refresh={refresh} onReport={artifact => { setPage(null); onReport(artifact); }} />}
            {base && <ThesisSources key={snapshot.identity.sessionId + base.artifact.id} client={client} snapshot={snapshot} baseline={base.artifact} value={checks} onChange={selectChecks} onBusy={setChecksBusy} refresh={refresh} onReport={artifact => { setPage(null); onReport(artifact); }} />}
            <label>事件类别<select name="kind" disabled={!!selectedAlert}><option value="fundamental">基本面新信息</option><option value="price">价格变化</option><option value="wording">只有措辞变化</option></select></label>
            <label>事件发生时间（本机时区）<input name="occurred" type="datetime-local" step="0.001" required readOnly={!!selectedAlert} defaultValue={formTime} /></label>
            <label className="full">事件摘要<textarea name="summary" required readOnly={!!selectedAlert} rows={2} maxLength={2000} /></label><label className="full">事件原始链接<input name="eventUrl" type="url" required readOnly={!!selectedAlert} placeholder="https://" /></label>
            <label>观察截止时间<input name="cutoff" type="datetime-local" step="0.001" required defaultValue={formTime} /></label>
            <label>证据层次<select name="origin" disabled={!!checks?.disclosure}><option value="source">来源事实</option><option value="calculation">计算结果</option><option value="interpretation">解释判断</option></select></label>
            {metricFields(base)}<label>新观察数值（可留空）<input name="after" type="number" step="any" required={!!checks?.disclosure} /></label>
            <label className="full">证据原始链接<input name="sourceUrl" type="url" disabled={!!checks?.disclosure} placeholder="https://" /></label>
            <label>证据发布时间<input name="published" disabled={!!checks?.disclosure} type="datetime-local" step="0.001" defaultValue={formTime} /></label><label>证据取得时间<input name="retrieved" disabled={!!checks?.disclosure} type="datetime-local" step="0.001" defaultValue={formTime} /></label>
            <label className="full">保留来源摘录<textarea name="excerpt" disabled={!!checks?.disclosure} rows={4} maxLength={5000} placeholder="粘贴支持数值的原文，不要包含授权信息。数值和摘录同时留空会保留为待核验。" /></label>
            <details className="full thesis-price"><summary>附加固定价量图（可选）</summary><p className="supporting">粘贴已有日线。仅绘制这些固定数据，不自动拉取或补齐行情；事件日没有交易数据时不移动标记。</p>
              <label>行情来源链接<input name="priceUrl" type="url" placeholder="https://" /></label><label>行情取得时间<input name="priceRetrieved" type="datetime-local" step="0.001" defaultValue={formTime} /></label>
              <label>行情复权口径<select name="priceAdjustment"><option value="none">不复权</option><option value="forward">前复权</option><option value="backward">后复权</option></select></label>
              <label>成交量单位<select name="volumeUnit"><option value="shares">股</option><option value="lots">手</option></select></label>
              <label>固定日线（日期、开、高、低、收、量）<textarea name="prices" rows={5} maxLength={10000} placeholder={'date,open,high,low,close,vol\n2026-01-05,10,12,9,11,10000\n2026-01-06,11,13,10,12,12000'} /></label>
            </details>
            <label>我的明确决定<select name="decision"><option value="">尚未决定</option><option value="maintain">维持假设</option><option value="revise">需要修订</option><option value="defer">暂缓决定</option></select></label><label>决定时间<input name="decided" type="datetime-local" step="0.001" defaultValue={formTime} /></label>
            <label className="full">决定理由<textarea name="rationale" rows={2} maxLength={2000} /></label>
          </>}
          </fieldset>
          {snapshot.state === "running" && <p role="status">当前研究仍在运行。可以查看固定记录，请在运行结束后保存。</p>}
          <div className="thesis-actions"><button className="action" type="submit" disabled={working || !!saved || snapshot.state === "running"}>{busy ? "正在保存…" : page === "baseline" ? "明确设立并保存基线" : "保存固定复核"}</button><span className="supporting">私有保存 · 不启动模型</span></div>
        </form>}
        {error && <p className="connection-error" ref={feedback} tabIndex={-1} role="alert">{error} 输入与原记录已保留，可核对后重试。</p>}
        {saved && <div role="status" className="thesis-success"><p>已保存固定版本 {saved.sha256.slice(0, 12)}。</p><button className="action" onClick={() => { setPage(null); onReport(saved); }}>打开已保存报告</button><button className="text-action" onClick={() => open("list")}>返回固定记录</button></div>}
      </div>
    </Dialog>, document.body)}
  </section>;
}

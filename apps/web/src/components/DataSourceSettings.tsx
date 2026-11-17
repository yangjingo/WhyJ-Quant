import { useEffect, useRef, useState } from "react";
import type { DataDraftEdit, DataDraftView, WorkbenchClient } from "../client/contract";

type Market = DataDraftView["sample"]["market"];
type Source = DataDraftView["sample"]["source"];
type KeyAction = "keep" | "replace" | "remove";
const providers: Record<Source, { label: string; url: string; key: boolean }> = {
  akshare: { label: "AKShare", url: "https://akshare.akfamily.xyz/", key: false },
  tickflow: { label: "TickFlow", url: "https://tickflow.org/auth/register/", key: true },
  tushare: { label: "Tushare", url: "https://tushare.pro/", key: true },
  "llmquant-data": { label: "LLMQuant Data", url: "https://data.llmquant.com/", key: true },
  "financial-datasets": { label: "Financial Datasets", url: "https://www.financialdatasets.ai/", key: true },
};
const choices: Record<Market, Source[]> = { A: ["akshare", "tushare", "tickflow"], US: ["llmquant-data", "financial-datasets", "akshare"], HK: ["llmquant-data", "akshare"], Fund: ["akshare", "tushare"] };
const samples: Record<Market, string> = { A: "000001.SZ", US: "AAPL", HK: "00700.HK", Fund: "270042.OF" };
const status: Record<NonNullable<DataDraftView["result"]>["status"], string> = {
  ready: "样本检查通过", "missing-credential": "缺少凭据", "missing-python": "缺少 Python", "missing-package": "缺少依赖",
  "auth-failed": "凭据未通过认证", "permission-denied": "当前账号没有接口权限", "blocked-runtime": "本机运行环境阻止了依赖",
  empty: "样本为空", timeout: "检查超时", cancelled: "已取消检查", unavailable: "数据源暂不可用", unsupported: "该市场不受支持", "invalid-input": "样本代码或日期无效",
};

/** One local form owns one Host draft. Credentials never enter browser storage. */
export function DataSourceSettings({ client, revision, running, onSaved }: { client: WorkbenchClient; revision?: string; running: boolean; onSaved(): Promise<void> }) {
  const [view, setView] = useState<DataDraftView | null>(null);
  const [sample, setSample] = useState<DataDraftView["sample"] | null>(null);
  const [key, setKey] = useState(""); const [keyAction, setKeyAction] = useState<KeyAction>("keep");
  const [endpoint, setEndpoint] = useState(""); const [endpointAction, setEndpointAction] = useState<KeyAction>("keep");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"opening" | "staging" | "checking" | "cancel" | "saving" | "removing" | null>("opening");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [completion, setCompletion] = useState(""); const [confirmRemoval, setConfirmRemoval] = useState(false);
  const live = useRef(false), id = useRef<string | null>(null), sequence = useRef(0);
  const removalClient = client as WorkbenchClient & { removeDataCredential?(input: { source: Source; revision: string }): Promise<{ removed: boolean }> };
  const closeDraft = (value: string) => { void client.closeDataDraft?.(value).catch(() => {}); };
  useEffect(() => {
    live.current = true; const ticket = ++sequence.current;
    void client.startDataDraft!().then(value => {
      if (!live.current || ticket !== sequence.current) { closeDraft(value.id); return; }
      id.current = value.id; setView(value); setSample(value.sample); setBusy(null);
    }).catch(() => { if (live.current && ticket === sequence.current) { setBusy(null); setNotice({ error: true, text: "无法打开数据源草稿，请重新连接后重试。" }); } });
    return () => { live.current = false; sequence.current++; if (id.current) { closeDraft(id.current); id.current = null; } };
  }, [client]);
  const changed = (next: DataDraftView["sample"]) => { setSample(next); setDirty(true); setNotice(null); };
  const check = async () => {
    if (!sample || !id.current || busy || !client.editDataDraft || !client.verifyDataDraft) return;
    const current = id.current, ticket = ++sequence.current;
    setBusy("staging"); setNotice(null); setDirty(true);
    const edit: DataDraftEdit = { id: current, ...sample,
      ...(keyAction === "replace" ? { key } : {}),
      ...(endpointAction === "remove" ? { endpoint: null } : endpointAction === "replace" ? { endpoint } : {}) };
    try {
      const staged = await client.editDataDraft(edit);
      if (!live.current || ticket !== sequence.current) return;
      setView(staged); setKey(""); setKeyAction("keep"); setEndpoint(""); setEndpointAction("keep"); setBusy("checking");
      const checked = await client.verifyDataDraft(current);
      if (!live.current || ticket !== sequence.current) return;
      setView(checked); setSample(checked.sample); setDirty(false);
    } catch (error) {
      if (live.current && ticket === sequence.current) setNotice({ error: true, text: error instanceof Error ? error.message : "检查未完成，请重试。" });
    } finally { if (live.current && ticket === sequence.current) setBusy(null); }
  };
  const cancel = async () => {
    if (!id.current || !client.cancelDataDraft) return;
    const current = id.current, ticket = ++sequence.current; setBusy("cancel"); setDirty(true);
    try { const result = await client.cancelDataDraft(current); if (live.current && ticket === sequence.current) { setView(result); setNotice({ error: false, text: "已取消检查，草稿保留；密钥不再回显，保存前请重新检查。" }); } }
    catch { if (live.current && ticket === sequence.current) setNotice({ error: true, text: "取消状态未确认，请重新打开设置。" }); }
    finally { if (live.current && ticket === sequence.current) setBusy(null); }
  };
  const save = async () => {
    if (!view || !id.current || !client.saveDataDraft || dirty || !view.canSave || busy) return;
    setBusy("saving"); setNotice(null);
    try {
      await client.saveDataDraft({ id: id.current, version: view.version });
      id.current = null; setCompletion("本次配置已保存。关闭后可重新打开设置。"); setView(null); setKey(""); setEndpoint("");
      try { await onSaved(); if (live.current) setNotice({ error: false, text: "数据源已保存。检查仅覆盖本次样本。" }); }
      catch { if (live.current) setNotice({ error: true, text: "数据源已保存，但界面刷新失败；请重新打开设置核对。" }); }
    } catch (error) { if (live.current) setNotice({ error: true, text: error instanceof Error ? error.message : "保存失败，草稿已保留。" }); }
    finally { if (live.current) setBusy(null); }
  };
  const removeKey = async () => {
    if (!sample || !revision || !id.current || !removalClient.removeDataCredential || busy) return;
    const current = id.current; setBusy("removing"); setNotice(null);
    try {
      const result = await removalClient.removeDataCredential({ source: sample.source, revision });
      if (!live.current) { if (result.removed) void onSaved().catch(() => {}); return; }
      if (!result.removed) { setConfirmRemoval(false); setNotice({ error: false, text: "该数据源没有本机保存的密钥。" }); return; }
      closeDraft(current); id.current = null; setView(null); setKey(""); setEndpoint("");
      setCompletion("本机密钥已移除。当前数据源未改变；环境变量如有凭据仍会生效。");
      try { await onSaved(); } catch { if (live.current) setNotice({ error: true, text: "密钥已移除，但界面刷新失败；请重新打开设置核对。" }); }
    } catch (error) { if (live.current) setNotice({ error: true, text: error instanceof Error ? error.message : "移除失败，原设置已保留。" }); }
    finally { if (live.current) setBusy(null); }
  };
  if (!sample || !view) return <div className="data-source-settings"><p role="status">{busy === "opening" ? "正在读取本机数据源设置…" : completion || "数据源配置暂不可用。"}</p>{notice && <p role={notice.error ? "alert" : "status"} className="operation-feedback">{notice.text}</p>}</div>;
  const locked = busy !== null, provider = providers[sample.source];
  return <div className="data-source-settings">
    <p>选择研究数据输入，检查一个样本后保存。当前来源在保存前不会改变。</p>
    <div className="data-source-grid">
      <label className="field-row">市场<select aria-label="数据市场" value={sample.market} disabled={locked} onChange={event => {
        const market = event.target.value as Market, source = choices[market].includes(sample.source) ? sample.source : choices[market][0]!;
        setKey(""); setKeyAction("keep"); setEndpoint(""); setEndpointAction("keep"); setConfirmRemoval(false); changed({ ...sample, market, source, symbol: samples[market] });
      }}><option value="A">A 股</option><option value="US">美股</option><option value="HK">港股</option><option value="Fund">基金</option></select></label>
      <label className="field-row">数据源<select aria-label="研究数据源" value={sample.source} disabled={locked} onChange={event => {
        setKey(""); setKeyAction("keep"); setEndpoint(""); setEndpointAction("keep"); setConfirmRemoval(false); changed({ ...sample, source: event.target.value as Source });
      }}>{choices[sample.market].map(source => <option key={source} value={source}>{providers[source].label}{source === "tickflow" ? " · A 股推荐" : ""}</option>)}</select></label>
    </div>
    <div className="data-source-connection"><div><strong>{provider.label}</strong><p className="supporting">{provider.key ? view.sample.source !== sample.source ? "选择后检查本机凭据状态。" : view.credential === "Missing key" ? "尚未配置凭据" : view.credential.startsWith("Environment") ? "环境变量已配置凭据，尚未验证。" : "本机草稿有凭据，已保存的密钥不会显示。" : "公开接口，无需密钥；AKShare 需要本机 Python 依赖。"}</p></div><a className="settings-link" href={provider.url} target="_blank" rel="noopener noreferrer">{provider.key ? "官方申请地址 ↗" : "官方文档 ↗"}</a></div>
    {provider.key && <><label className="field-row">API 密钥<input aria-label="数据源 API 密钥" type="password" autoComplete="off" value={key} disabled={locked} placeholder="留空保留当前凭据" onChange={event => { setKey(event.target.value); setKeyAction(event.target.value ? "replace" : "keep"); setDirty(true); setNotice(null); }} /></label>
      {!confirmRemoval ? <button type="button" className="text-action" disabled={locked || running || !revision || !removalClient.removeDataCredential} onClick={() => { setConfirmRemoval(true); setNotice(null); }}>移除本机保存的密钥</button> : <div className="data-source-remove"><p>移除 {provider.label} 的本机密钥？此操作不需要连接供应商，不改变当前数据源；环境变量仍可生效。未保存的草稿将被放弃。</p><div className="data-source-actions"><button type="button" className="action" disabled={locked} onClick={() => setConfirmRemoval(false)}>取消移除</button><button type="button" className="action danger-action" disabled={locked || running} onClick={() => void removeKey()}>确认移除密钥</button></div></div>}
      {!removalClient.removeDataCredential && <p className="supporting">当前服务尚不支持在此移除本机密钥，请更新后重新连接。</p>}
      <details className="data-source-endpoint"><summary>连接地址（可选）</summary><p className="supporting">{view.sample.source !== sample.source ? "当前来源的地址状态尚未读取。" : view.endpointConfigured ? "已配置连接地址。留空保留当前值。" : "未配置自定义连接地址。"} 仅支持 HTTPS 或本机 HTTP。</p><label className="field-row">服务地址<input aria-label="数据源服务地址" value={endpoint} disabled={locked} placeholder="留空使用当前设置" onChange={event => { setEndpoint(event.target.value); setEndpointAction(event.target.value ? "replace" : "keep"); setDirty(true); setNotice(null); }} /></label><button type="button" className="text-action" disabled={locked} onClick={() => { setEndpoint(""); setEndpointAction(endpointAction === "remove" ? "keep" : "remove"); setDirty(true); setNotice(null); }}>{endpointAction === "remove" ? "撤销移除地址" : "移除本机地址覆盖"}</button></details></>}
    <div className="settings-group"><h4>检查样本</h4><p className="supporting">检查只请求所选数据源，不使用其他来源回退。</p><div className="data-source-grid"><label className="field-row">标的代码<input aria-label="样本标的" value={sample.symbol} disabled={locked} onChange={event => changed({ ...sample, symbol: event.target.value })} /></label><label className="field-row">开始日期<input aria-label="样本开始日期" type="date" value={sample.start} disabled={locked} onChange={event => changed({ ...sample, start: event.target.value })} /></label><label className="field-row">结束日期<input aria-label="样本结束日期" type="date" value={sample.end} disabled={locked} onChange={event => changed({ ...sample, end: event.target.value })} /></label></div>
      <div className="data-source-actions"><button type="button" className="action" disabled={locked || !sample.symbol.trim() || !sample.start || !sample.end} onClick={() => void check()}>{busy === "checking" || busy === "staging" ? "正在检查…" : "检查连接"}</button>{busy === "checking" && <button type="button" className="text-action" onClick={() => void cancel()}>取消检查</button>}<button type="button" className="action primary-action" disabled={locked || running || dirty || !view.canSave} onClick={() => void save()}>保存已验证配置</button></div>
      {running && <p className="supporting">研究运行中不能保存设置；请先等待或停止研究。</p>}
      {view.result && !dirty && <div role="status" className="data-source-result"><strong>{status[view.result.status]}</strong><p>{provider.label} · {sample.symbol} · {sample.start} 至 {sample.end}{view.result.status === "ready" && ` · ${view.result.rowCount} 条 · 数据日期 ${view.result.asOfDate ?? "未知"}`}</p><p className="supporting">{view.result.capability === "unit-nav" ? "基金净值" : "日线"}样本不代表分钟、实时、财务或完整历史权限。</p></div>}
      {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "operation-feedback error-feedback" : "operation-feedback"}>{notice.text}</p>}
    </div>
    <div className="settings-group"><h4>TSP 连接</h4><p className="supporting">TSP 使用独立连接与凭据，目前此处尚不可配置。直接使用 TickFlow 不需要运行 TSP。</p></div>
  </div>;
}

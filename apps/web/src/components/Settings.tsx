import { useEffect, useRef, useState } from "react";
import type { Preferences, SessionSnapshot, WorkbenchClient } from "../client/contract";
import { DataSourceSettings } from "./DataSourceSettings";
import { ObservationCollection } from "./ObservationCollection";
import { ObservationListRows } from "./ObservationListRows";
import { ModelSettings } from "./ModelSettings";
import { runLabels } from "../presentation";
import { Dialog } from "./UI";
import { defaultClientSettings, type ClientSettings } from "../state/client-settings";

export type DialogPage = "model" | "source" | "reading" | "session";
const labels: Record<DialogPage, string> = { reading: "界面", session: "会话", model: "模型", source: "数据" };

export function Settings(props: {
  page: DialogPage; setPage(page: DialogPage): void; onClose(): void; focusPortfolio?: boolean; focusVersion?: boolean;
  preferences: Preferences; onPreferences(prefs: Preferences): Promise<void>;
  snapshot: SessionSnapshot | null; title: string; onRename(title: string): Promise<void>;
  canDelete: boolean; onDelete(): Promise<void>;
  clientSettings: ClientSettings; onClientSettings(value: ClientSettings): void; settingsSaved: boolean; onStop(): void; mode: string;
  client?: WorkbenchClient; onSettingsSaved?(): Promise<void>;
}) {
  const [legacySource, setLegacySource] = useState(false);
  useEffect(() => { setLegacySource(false); }, [props.client]);
  const portfolioHeading = useRef<HTMLHeadingElement>(null);
  const versionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (props.page === "reading" && props.focusVersion) versionHeading.current?.focus(); }, [props.page, props.focusVersion]);
  useEffect(() => { if (props.page === "source" && props.focusPortfolio) portfolioHeading.current?.focus(); }, [props.page, props.focusPortfolio]);
  const [model, setModel] = useState(props.preferences.model);
  const [legacyModel, setLegacyModel] = useState(false);
  useEffect(() => { setLegacyModel(false); }, [props.client]);
  const [thinking, setThinking] = useState(props.preferences.thinkingLevel ?? "high");
  const [title, setTitle] = useState(props.title);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const perform = async (action: () => Promise<void>, success: string) => {
    if (pending) return;
    setPending(true); setFeedback(null);
    try { await action(); setFeedback({ error: false, text: success }); }
    catch (error) { setFeedback({ error: true, text: error instanceof Error ? error.message : "操作未完成，请重试。" }); }
    finally { setPending(false); }
  };
  const savePreferences = (next: Preferences) => perform(() => props.onPreferences(next), props.mode === "demo" ? "演示偏好已保存；未建立真实连接。" : "偏好已保存。连接状态以研究服务为准。");
  return <Dialog title={labels[props.page]} onClose={props.onClose} className="settings-dialog">
    <div className="settings-layout"><nav aria-label="设置分区" className="settings-nav" onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : buttons.length - 1)) % buttons.length;
      event.preventDefault(); buttons[next]?.focus();
    }}>{(Object.keys(labels) as DialogPage[]).map(page => <button key={page} disabled={pending} aria-current={props.page === page ? "page" : undefined} onClick={() => { props.setPage(page); setFeedback(null); }}>{labels[page]}</button>)}</nav>
      <section key={props.page} className="settings-main" aria-busy={pending}>
        {props.page === "reading" && <><h3>阅读与交互</h3><p className="supporting">这些偏好只保存在当前客户端，不影响工作区和研究内容。</p><div className="settings-group"><h4>阅读字号</h4><label className="field-row">消息正文字号<select value={props.clientSettings.fontSize} onChange={event => props.onClientSettings({ ...props.clientSettings, fontSize: Number(event.target.value) as ClientSettings["fontSize"] })}><option value={13}>紧凑 · 13px</option><option value={15}>标准 · 15px</option><option value={16}>舒适 · 16px</option><option value={18}>大号 · 18px</option></select></label><p className="reading-preview" style={{ fontSize: props.clientSettings.fontSize }}>研究从一个好问题开始。123.45</p></div><div className="settings-group"><h4>输入与发送</h4><label className="field-row">发送快捷键<select value={props.clientSettings.sendKey} onChange={event => props.onClientSettings({ ...props.clientSettings, sendKey: event.target.value as ClientSettings["sendKey"] })}><option value="enter">Enter 发送，Shift + Enter 换行</option><option value="ctrl-enter">Ctrl / ⌘ + Enter 发送，Enter 换行</option></select></label></div><button className="action" onClick={() => props.onClientSettings({ ...defaultClientSettings })}>恢复界面默认值</button><p role="status" className="supporting">{props.settingsSaved ? "修改立即生效，并保存在当前客户端。" : "无法写入本地存储；设置仅在当前窗口有效。"}</p></>}
        {props.page === "reading" && <div className="settings-group"><h3 ref={versionHeading} tabIndex={-1}>WhyJ Quant v{__APP_VERSION__}</h3><p>提问、检查证据、保留研究，再持续复核。</p><div className="notice">{props.mode === "demo" ? "当前为交互演示：数据、证据与报告均为合成示例，没有调用模型。" : props.mode === "disconnected" ? "当前界面尚未连接研究服务。此独立入口暂不能执行研究；请使用接入 Host 的应用入口。" : "当前界面连接到工作区研究服务。"}</div><div className="settings-group"><h4>项目与支持</h4><p className="supporting">浏览器与桌面共用界面，运行与保存由研究服务管理。已结束不等于结论已核验。</p><a className="settings-link" href="https://github.com/yangjingo/WhyJ-Quant" target="_blank" rel="noopener noreferrer">打开项目主页 ↗</a><p className="supporting">本页面展示当前构建版本；尚未提供自动更新检查。</p></div></div>}
        {props.page === "model" && (props.mode === "host" && !legacyModel && props.client?.startModelDraft && props.client.editModelDraft && props.client.verifyModelDraft && props.client.cancelModelDraft && props.client.saveModelDraft && props.client.closeModelDraft && props.onSettingsSaved ? <><h3>模型连接</h3><ModelSettings client={props.client} revision={props.preferences.revision} running={props.snapshot?.state === "running"} onSaved={props.onSettingsSaved} onUnsupported={() => setLegacyModel(true)} /></> : <><h3>当前模型</h3><p>{props.mode === "demo" ? "这里仅保存演示偏好，不会调用模型。" : "模型连接由研究服务管理；这里不保存 API 密钥。"}</p>
          {props.preferences.modelProvider && <div className="notice"><p>服务商：{props.preferences.modelProvider} · {props.preferences.modelProtocol}</p><p>{props.preferences.modelCredentialsConfigured ? "凭据已在本机配置，实际可用性以研究请求为准。" : "凭据尚未验证；服务会在请求时检查本机配置。"}</p><p>当前仅支持编辑既有服务商的模型；服务商、密钥配置与连接测试尚未在此界面开放。</p></div>}
          <p className="supporting">编辑模型 ID 和推理强度后需要保存；不会在打开设置时发送模型请求。</p><label className="field-row">模型 ID<input aria-label="模型 ID" value={model} disabled={pending} onChange={event => { setModel(event.target.value); setFeedback(null); }} placeholder="填写服务提供的模型 ID" /></label>
          {!!props.preferences.availableThinkingLevels?.length && <label className="field-row">推理强度<select aria-label="推理强度" disabled={pending} value={thinking} onChange={event => { setThinking(event.target.value); setFeedback(null); }}>{props.preferences.availableThinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}</select></label>}
          <button className="action primary-action" disabled={pending || !model.trim() || (model === props.preferences.model && thinking === (props.preferences.thinkingLevel ?? "high"))} onClick={() => void savePreferences({ ...props.preferences, model, ...(props.preferences.thinkingLevel ? { thinkingLevel: thinking } : {}) })}>{pending ? "正在保存…" : "保存偏好"}</button></>)}
        {props.page === "source" && <><h3>研究数据源</h3>{!legacySource && props.mode === "host" && props.client?.startDataDraft && props.client.editDataDraft && props.client.verifyDataDraft && props.client.cancelDataDraft && props.client.saveDataDraft && props.client.closeDataDraft && props.onSettingsSaved ? <DataSourceSettings client={props.client} revision={props.preferences.revision} running={props.snapshot?.state === "running"} onSaved={props.onSettingsSaved} onUnsupported={() => setLegacySource(true)} /> : props.mode === "host" && props.preferences.researchSource ? <>
          <p>研究工具使用下面的数据源。保存只改变默认来源，不代表网络、权限或每个字段均已验证；工具可以按字段回退，并记录实际来源。</p>
          <label className="field-row">研究数据源<select aria-label="研究数据源" disabled={pending || props.snapshot?.state === "running"} value={props.preferences.researchSource} onChange={event => void savePreferences({ ...props.preferences, researchSource: event.target.value as Preferences["researchSource"] })}>
            {props.preferences.researchSources?.map(source => <option key={source.id} value={source.id}>{source.label} · {source.requiresCredential ? source.credentialConfigured ? "凭据已配置，待请求验证" : "需要本机配置凭据" : "公开接口，无需密钥"}</option>)}
          </select></label>
          {props.snapshot?.state === "running" && <p>请先等待或停止研究，再切换数据源。</p>}
          <p className="supporting">AKShare 依赖本机 Python。TickFlow、Tushare、LLMQuant 和 Financial Datasets 的凭据仍在本机配置，页面不接收或显示密钥。数据源密钥配置与连接测试尚未在此界面开放。各源覆盖的市场和字段不同，缺失项以工具实际返回为准。</p>
          <div className="settings-group"><h4>官方入口</h4><p className="supporting">选择的来源：{props.preferences.researchSources?.find(source => source.id === props.preferences.researchSource)?.label ?? props.preferences.researchSource}。申请或查看文档后，仍需在服务端配置凭据；链接本身不代表连接成功。</p><a className="settings-link" target="_blank" rel="noopener noreferrer" href={({ akshare: "https://akshare.akfamily.xyz/", tickflow: "https://tickflow.org/auth/register/", tushare: "https://tushare.pro/", "llmquant-data": "https://data.llmquant.com/", "financial-datasets": "https://www.financialdatasets.ai/" } as const)[props.preferences.researchSource]}>打开官方文档或申请页面 ↗</a></div><h3>行情概览</h3><p>右侧指数概览使用已有快照接口，按源时间显示点位与相对前收涨跌；观察组沿用研究日线路由。逐条显示实际来源与数据日期，不保证实时行情；快照失败后的历史日线与旧值单独标记。</p>
        </> : <><p>仅连接成功的数据源才能提供行情。变更偏好不会把旧数据当作新数据。</p><label className="field-row">数据源<select aria-label="数据源" disabled={pending} value={props.preferences.source} onChange={event => void savePreferences({ ...props.preferences, source: event.target.value as Preferences["source"] })}><option value="none">未启用</option>{props.mode === "demo" && <option value="demo">本地合成 · 示例</option>}<option value="akshare">AKShare · 需研究服务连接</option></select></label></>}</>}
        {props.page === "source" && props.mode === "host" && props.client && <ObservationCollection client={props.client} />}
        {props.page === "source" && props.mode === "host" && props.client && <ObservationListRows read={props.client.readObservationListRows} />}
        {props.page === "source" && <><h3 ref={portfolioHeading} tabIndex={-1}>观察组</h3><p>观察组用于行情概览，不代表真实持仓，也不改变已经保存的研究。</p>{props.preferences.availablePortfolios?.length ? <label className="field-row">观察组<select aria-label="投资组合" value={props.preferences.portfolio} disabled={pending} onChange={event => void savePreferences({ ...props.preferences, portfolio: event.target.value })}>{props.preferences.availablePortfolios.map(name => <option key={name}>{name}</option>)}</select></label> : <p className="notice">研究服务尚未提供观察组。</p>}</>}
        {props.page === "session" && <><h3>当前会话</h3><p className="supporting">{props.title || "未命名会话"}</p><p>{props.snapshot ? runLabels[props.snapshot.state] : "研究服务未连接"}</p><button className="action" disabled={props.snapshot?.state !== "running"} onClick={props.onStop}>停止生成</button><p className="supporting">关闭面板、切换会话只改变查看位置，研究仍会继续。</p>{props.snapshot && <details><summary>会话与运行标识</summary><p>会话 ID</p><code>{props.snapshot.identity.sessionId}</code>{props.snapshot.identity.runId && <><p>运行 ID</p><code>{props.snapshot.identity.runId}</code></>}</details>}</>}
        {props.page === "session" && <><label className="field-row">会话名称<input aria-label="会话名称" value={title} disabled={pending} onChange={event => { setTitle(event.target.value); setFeedback(null); }} /></label><button className="action primary-action" disabled={pending || !props.snapshot} onClick={() => void perform(() => props.onRename(title), "会话名称已保存。")}>保存名称</button>
          <div className="delete-session"><h3>删除会话</h3><p className="supporting">运行中的会话不能删除。报告文件会保留，但删除后不能再从该会话查看或复核。</p>{!confirmDelete ? <button className="action" disabled={pending || !props.canDelete || props.snapshot?.state === "running"} onClick={() => setConfirmDelete(true)}>删除当前会话</button> : <><p>确认删除“{props.title}”？会话记录将从工作区移除。</p><button className="action" disabled={pending} onClick={() => setConfirmDelete(false)}>取消</button><button className="action danger-action" disabled={pending} onClick={() => void perform(async () => { await props.onDelete(); props.onClose(); }, "会话已删除。")}>确认删除会话</button></>}</div></>}
        {feedback && <p className={feedback.error ? "operation-feedback error-feedback" : "operation-feedback"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      </section>
    </div>
  </Dialog>;
}

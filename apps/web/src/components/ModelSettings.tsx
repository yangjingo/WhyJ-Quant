import { useEffect, useRef, useState } from "react";
import type { ModelDraftEdit, ModelDraftStatus, ModelDraftView, WorkbenchClient } from "../client/contract";

const statusLabels: Record<ModelDraftStatus, string> = {
  ready: "本次连接检查通过", "missing-credential": "缺少凭据", "auth-failed": "认证失败", "permission-denied": "没有访问权限",
  timeout: "检查超时", cancelled: "检查已取消", "invalid-config": "配置无效", unsupported: "不支持此协议或模型",
  "empty-response": "模型没有返回文本", unavailable: "网络或服务不可用",
};
const providerLinks: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
  deepseek: "https://api-docs.deepseek.com/",
  "moonshotai": "https://www.kimi.ai/help/kimi-api/api-overview",
  openrouter: "https://openrouter.ai/developers",
  "amazon-bedrock": "https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html",
  "ant-ling": "https://developer.ant-ling.com/en/docs/faq/",
  azure: "https://learn.microsoft.com/en-us/azure/ai-services/openai/gpt-v-quickstart",
  baseten: "https://docs.baseten.co/organization/api-keys",
  cerebras: "https://www.cerebras.ai/inference",
  "cloudflare-ai-gateway": "https://developers.cloudflare.com/ai-gateway/get-started/",
  "cloudflare-workers-ai": "https://developers.cloudflare.com/workers-ai/get-started/rest-api/",
  fireworks: "https://docs.fireworks.ai/getting-started/quickstart",
  "github-copilot": "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/troubleshoot-copilot-cli-auth",
  "google-vertex": "https://cloud.google.com/docs/authentication/provide-credentials-adc",
  groq: "https://console.groq.com/docs/quickstart",
  huggingface: "https://huggingface.co/docs/hub/security-tokens",
  "kimi-coding": "https://www.kimi.com/en/help/kimi-code/membership-guide",
  meta: "https://dev.meta.ai/help/api-keys/create-api-key",
  mistral: "https://docs.mistral.ai/getting-started/platform-overview",
  "minimax-cn": "https://platform.minimaxi.com/",
  minimax: "https://platform.minimax.io/",
  "moonshotai-cn": "https://www.kimi.com/help/kimi-code/faq",
  nvidia: "https://docs.nvidia.com/nemo/datadesigner/concepts/models/default-model-settings",
  opencode: "https://opencode.ai/docs/zen",
  "opencode-go": "https://opencode.ai/docs/console/go/",
  "qwen-token-plan": "https://help.aliyun.com/en/model-studio/token-plan-permissions-and-usage",
  "qwen-token-plan-individual": "https://help.aliyun.com/en/model-studio/token-plan-permissions-and-usage",
  "qwen-token-plan-cn": "https://help.aliyun.com/zh/model-studio/use-chat-client-or-development-tool/",
  radius: "https://docs.pi.dev/latest/providers",
  together: "https://support.together.ai/articles/4999040689-where-to-find-your-api-key",
  "vercel-ai-gateway": "https://vercel.com/docs/ai-gateway/authentication-and-byok",
  xai: "https://docs.x.ai/developers/faq/security",
  xiaomi: "https://mimo.mi.com/docs/en-US/quick-start/faq/api-integration",
  "xiaomi-token-plan-ams": "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
  "xiaomi-token-plan-cn": "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
  "xiaomi-token-plan-sgp": "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
  zai: "https://z.ai/model-api",
  "zai-coding-cn": "https://docs.bigmodel.cn/cn/coding-plan/extension/coding-tool-helper",
};

/** The Host owns saved secrets and the authoritative verified draft. */
export function ModelSettings({ client, revision, running, onSaved, onUnsupported }: {
  client: WorkbenchClient; revision?: string; running: boolean; onSaved(): Promise<void>; onUnsupported(): void;
}) {
  const [view, setView] = useState<ModelDraftView | null>(null);
  const [model, setModel] = useState(""); const [protocol, setProtocol] = useState(""); const [thinking, setThinking] = useState("");
  const [thinkingChanged, setThinkingChanged] = useState(false);
  const [key, setKey] = useState(""); const [endpoint, setEndpoint] = useState("");
  const [accountId, setAccountId] = useState(""); const [gatewayId, setGatewayId] = useState("");
  const [clearAccount, setClearAccount] = useState(false); const [clearGateway, setClearGateway] = useState(false);
  const [clearEndpoint, setClearEndpoint] = useState(false); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"opening" | "editing" | "checking" | "cancelling" | "saving" | "removing" | null>("opening");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [completion, setCompletion] = useState(""); const [confirmRemoval, setConfirmRemoval] = useState(false);
  const live = useRef(false), draftId = useRef<string | null>(null), sequence = useRef(0);
  const modelsByProvider = useRef(new Map<string, string>());
  const apply = (next: ModelDraftView) => { setView(next); setModel(next.model); setProtocol(next.protocol ?? ""); setThinking(next.thinkingLevel); setThinkingChanged(false); };
  const close = (id: string) => { void client.closeModelDraft?.(id).catch(() => {}); };
  useEffect(() => {
    live.current = true; const ticket = ++sequence.current;
    void client.startModelDraft!().then(next => {
      if (!live.current || ticket !== sequence.current) { close(next.id); return; }
      draftId.current = next.id; apply(next); setBusy(null);
    }).catch(error => {
      if (!live.current || ticket !== sequence.current) return;
      setBusy(null);
      if ((error as { code?: string })?.code === "METHOD_NOT_FOUND") onUnsupported();
      else setNotice({ error: true, text: "无法打开模型草稿，请重新连接后重试。" });
    });
    return () => { live.current = false; sequence.current++; if (draftId.current) { close(draftId.current); draftId.current = null; } };
  }, [client]);
  const changed = () => { setDirty(true); setNotice(null); };
  const selectProvider = async (provider: string) => {
    if (!draftId.current || !view || busy) return;
    const id = draftId.current, ticket = ++sequence.current;
    modelsByProvider.current.set(view.provider, model);
    setBusy("editing"); setDirty(true); setNotice(null); setKey(""); setEndpoint(""); setClearEndpoint(false); setConfirmRemoval(false);
    setAccountId(""); setGatewayId(""); setClearAccount(false); setClearGateway(false);
    try { const next = await client.editModelDraft!({ id, provider }); if (live.current && ticket === sequence.current) {
      apply(next); const previous = modelsByProvider.current.get(next.provider); if (previous !== undefined) setModel(previous);
    } }
    catch (error) { if (live.current && ticket === sequence.current) setNotice({ error: true, text: error instanceof Error ? error.message : "无法切换供应商。" }); }
    finally { if (live.current && ticket === sequence.current) setBusy(null); }
  };
  const check = async () => {
    if (!draftId.current || !view || busy) return;
    const id = draftId.current, ticket = ++sequence.current;
    setBusy("editing"); setDirty(true); setNotice(null);
    const edit: ModelDraftEdit = { id, model: model.trim(), ...(thinkingChanged ? { thinkingLevel: thinking } : {}),
      ...(protocol !== (view.protocol ?? "") ? { protocol: protocol ? protocol as NonNullable<ModelDraftEdit["protocol"]> : null } : {}),
      ...(key ? { key } : {}), ...(clearEndpoint ? { endpoint: null } : endpoint ? { endpoint } : {}),
      ...(clearAccount ? { cloudflareAccountId: null } : accountId ? { cloudflareAccountId: accountId } : {}),
      ...(clearGateway ? { cloudflareGatewayId: null } : gatewayId ? { cloudflareGatewayId: gatewayId } : {}) };
    try {
      const staged = await client.editModelDraft!(edit);
      if (!live.current || ticket !== sequence.current) return;
      apply(staged); setKey(""); setEndpoint(""); setClearEndpoint(false); setAccountId(""); setGatewayId(""); setClearAccount(false); setClearGateway(false); setBusy("checking");
      const checked = await client.verifyModelDraft!(id);
      if (!live.current || ticket !== sequence.current) return;
      apply(checked); setDirty(false);
    } catch (error) { if (live.current && ticket === sequence.current) setNotice({ error: true, text: error instanceof Error ? error.message : "检查未完成，请重试。" }); }
    finally { if (live.current && ticket === sequence.current) setBusy(null); }
  };
  const cancel = async () => {
    if (!draftId.current || !client.cancelModelDraft) return;
    const ticket = ++sequence.current; setBusy("cancelling"); setDirty(true);
    try { const next = await client.cancelModelDraft(draftId.current); if (live.current && ticket === sequence.current) { apply(next); setNotice({ error: false, text: "检查已取消；保存前请重新检查。" }); } }
    catch { if (live.current && ticket === sequence.current) setNotice({ error: true, text: "取消状态未确认，请重新打开设置。" }); }
    finally { if (live.current && ticket === sequence.current) setBusy(null); }
  };
  const save = async () => {
    if (!draftId.current || !view || dirty || !view.canSave || busy || running) return;
    setBusy("saving"); setNotice(null);
    try {
      await client.saveModelDraft!({ id: draftId.current, version: view.version }); draftId.current = null;
      setView(null); setKey(""); setEndpoint(""); setAccountId(""); setGatewayId(""); setCompletion("模型配置已保存。关闭后可重新打开设置。");
      try { await onSaved(); } catch { if (live.current) setNotice({ error: true, text: "已保存，但界面刷新失败；请重新打开设置核对。" }); }
    } catch (error) { if (live.current) setNotice({ error: true, text: error instanceof Error ? error.message : "保存失败，草稿已保留。" }); }
    finally { if (live.current) setBusy(null); }
  };
  const removeKey = async () => {
    if (!draftId.current || !view || !revision || !client.removeModelCredential || busy || running) return;
    const id = draftId.current; setBusy("removing"); setNotice(null);
    try {
      const result = await client.removeModelCredential({ provider: view.provider, revision });
      if (!live.current) { if (result.removed) void onSaved().catch(() => {}); return; }
      if (!result.removed) { setConfirmRemoval(false); setNotice({ error: false, text: "该供应商没有本机保存的密钥。" }); return; }
      close(id); draftId.current = null; setView(null); setKey(""); setEndpoint(""); setAccountId(""); setGatewayId("");
      setCompletion("本机密钥已移除，环境变量或其他认证方式仍可能生效。");
      try { await onSaved(); } catch { if (live.current) setNotice({ error: true, text: "密钥已移除，但界面刷新失败。" }); }
    } catch (error) { if (live.current) setNotice({ error: true, text: error instanceof Error ? error.message : "移除失败，原设置已保留。" }); }
    finally { if (live.current) setBusy(null); }
  };
  if (!view) return <div><p role="status">{busy === "opening" ? "正在读取模型设置…" : completion || "模型配置暂不可用。"}</p>{notice && <p role="alert" className="operation-feedback error-feedback">{notice.text}</p>}</div>;
  const locked = busy !== null, selected = view.providers.find(provider => provider.id === view.provider);
  const providerLink = Object.hasOwn(providerLinks, view.provider) ? providerLinks[view.provider] : undefined;
  const isCloudflare = view.provider === "cloudflare-workers-ai" || view.provider === "cloudflare-ai-gateway";
  const cloudflare = view.cloudflare;
  return <div className="data-source-settings">
    <p>选择模型并主动检查后保存；打开设置不会调用模型。一次检查可能产生供应商费用。</p>
    <label className="field-row">模型供应商<select aria-label="模型供应商" value={view.provider} disabled={locked} onChange={event => void selectProvider(event.target.value)}>{view.providers.filter(provider => provider.canApiKey || provider.id === view.provider).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
    {providerLink ? <a className="settings-link" href={providerLink} target="_blank" rel="noopener noreferrer">官方文档或申请密钥 ↗</a>
      : selected?.canApiKey && view.provider !== "custom" && <p className="supporting">此供应商的官方申请入口尚未收录，请查阅其官方文档。</p>}
    <p className="supporting">{view.oauthSelected ? "使用已有 OAuth 凭据；此处不提供交互式登录。" : view.keyConfigured ? "本机已配置密钥，不会回显；尚需检查实际连接。" : "未保存本机密钥；环境变量或其他认证方式可能仍生效。"}</p>
    <label className="field-row">模型 ID<input aria-label="模型 ID" list="available-models" value={model} disabled={locked} onChange={event => { setModel(event.target.value); changed(); }} /></label>
    <datalist id="available-models">{view.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
    {!!view.protocols.length && <label className="field-row">连接协议<select aria-label="模型协议" value={protocol} disabled={locked} onChange={event => { setProtocol(event.target.value); changed(); }}><option value="">自动选择</option>{view.protocols.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
    {!!view.thinkingLevels.length && <label className="field-row">推理强度<select aria-label="推理强度" value={thinking} disabled={locked} onChange={event => { setThinking(event.target.value); setThinkingChanged(true); changed(); }}>{view.thinkingLevels.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
    {selected?.canApiKey && <><label className="field-row">API 密钥<input aria-label="模型 API 密钥" type="password" autoComplete="off" value={key} disabled={locked} placeholder="留空保留当前凭据" onChange={event => { setKey(event.target.value); changed(); }} /></label>
      {!confirmRemoval ? <button type="button" className="text-action" disabled={locked || running || !revision || !client.removeModelCredential} onClick={() => setConfirmRemoval(true)}>移除本机保存的密钥</button> : <div className="data-source-remove"><p>移除 {selected.name} 的本机密钥？不会联网，也不会移除环境变量或其他认证方式；未保存草稿将被放弃。</p><div className="data-source-actions"><button type="button" className="action" disabled={locked} onClick={() => setConfirmRemoval(false)}>取消移除</button><button type="button" className="action danger-action" disabled={locked || running} onClick={() => void removeKey()}>确认移除密钥</button></div></div>}</>}
    {isCloudflare && (cloudflare ? <div className="settings-group"><h4>Cloudflare 连接信息</h4>
      <p className="supporting">{cloudflare.accountConfigured ? "本机已保存账号 ID，不会回显。" : "本机未保存账号 ID。"} 留空保留当前设置；环境变量也可能提供这些值。</p>
      <label className="field-row">账号 ID<input aria-label="Cloudflare 账号 ID" value={accountId} disabled={locked} autoComplete="off" placeholder="留空保留当前设置" onChange={event => { setAccountId(event.target.value); setClearAccount(false); changed(); }} /></label>
      <button type="button" className="text-action" disabled={locked} onClick={() => { setAccountId(""); setClearAccount(!clearAccount); changed(); }}>{clearAccount ? "撤销移除账号 ID" : "移除本机账号 ID"}</button>
      {view.provider === "cloudflare-ai-gateway" && <><p className="supporting">{cloudflare.gatewayConfigured ? "本机已保存网关 ID，不会回显。" : "本机未保存网关 ID。"}</p>
        <label className="field-row">网关 ID<input aria-label="Cloudflare 网关 ID" value={gatewayId} disabled={locked} autoComplete="off" placeholder="留空保留当前设置" onChange={event => { setGatewayId(event.target.value); setClearGateway(false); changed(); }} /></label>
        <button type="button" className="text-action" disabled={locked} onClick={() => { setGatewayId(""); setClearGateway(!clearGateway); changed(); }}>{clearGateway ? "撤销移除网关 ID" : "移除本机网关 ID"}</button></>}
    </div> : <p className="notice">当前服务尚不支持在界面配置 Cloudflare 账号和网关 ID；请更新服务后重新连接。</p>)}
    <details className="data-source-endpoint"><summary>连接地址（可选）</summary><p className="supporting">{view.endpointConfigured ? "已配置地址；留空保留。" : "未配置自定义地址。"}仅支持 HTTPS 或本机 HTTP。</p><label className="field-row">模型服务地址<input aria-label="模型服务地址" value={endpoint} disabled={locked} placeholder="留空保留当前设置" onChange={event => { setEndpoint(event.target.value); setClearEndpoint(false); changed(); }} /></label><button type="button" className="text-action" disabled={locked} onClick={() => { setEndpoint(""); setClearEndpoint(!clearEndpoint); changed(); }}>{clearEndpoint ? "撤销移除地址" : "移除本机地址覆盖"}</button></details>
    <div className="data-source-actions"><button type="button" className="action" disabled={locked || !model.trim() || !thinking} onClick={() => void check()}>{busy === "checking" || busy === "editing" ? "正在检查…" : "检查连接"}</button>{busy === "checking" && <button type="button" className="text-action" onClick={() => void cancel()}>取消检查</button>}<button type="button" className="action primary-action" disabled={locked || running || dirty || !view.canSave} onClick={() => void save()}>保存已验证配置</button></div>
    {running && <p className="supporting">研究运行中不能保存设置；请先等待或停止研究。</p>}
    {view.status && !dirty && <div role="status" className="data-source-result"><strong>{statusLabels[view.status]}</strong><p>检查只证明本次请求的结果，不证明工具调用能力或模型质量。</p></div>}
    {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "operation-feedback error-feedback" : "operation-feedback"}>{notice.text}</p>}
  </div>;
}

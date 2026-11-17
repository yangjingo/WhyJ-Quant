import { randomUUID } from "node:crypto";
import { createModelSettingsDraft, configuredThinking, configuredThinkingLevels, modelProtocols, modelProviders, providerModels,
  resolveConfiguredModel, validateModelBaseUrl } from "../../runtime/models/model-settings.ts";
import { probeModelConnection, type ModelProbeResult } from "../../runtime/models/model-probe.ts";
import type { OhQuantSettings } from "../../types/config.ts";
import type { ModelDraftEdit, ModelDraftSave, ModelDraftStatus, ModelDraftView } from "../../types/workbench.ts";
import type { SettingsPort } from "../workbench/model.ts";
import { WorkbenchError } from "../workbench/errors.ts";

const ttlMs = 10 * 60_000, maxDrafts = 8, probeTimeoutMs = 30_000;
const invalid = () => new WorkbenchError("INPUT_INVALID", "模型草稿参数无效。");
const expired = () => new WorkbenchError("MODEL_DRAFT_EXPIRED", "模型草稿已关闭或过期，请重新打开。", 409);
const statuses: readonly ModelDraftStatus[] = ["ready", "missing-credential", "auth-failed", "permission-denied", "timeout", "cancelled", "invalid-config", "unsupported", "empty-response", "unavailable"];
type Entry = { settings: OhQuantSettings; version: number; checked: number | null; status: ModelDraftStatus | null;
  controller: AbortController | null; timer: ReturnType<typeof setTimeout> };

/** Host owns secret-bearing snapshots. Public views exclude credentials, headers and endpoints. */
export function createModelDrafts(port: SettingsPort, options: { beforeSave(): void; probe?: typeof probeModelConnection }) {
  const entries = new Map<string, Entry>();
  const abort = (item: Entry) => { item.controller?.abort(); item.controller = null; item.checked = null; item.status = null; };
  const close = (id: string) => { const item = entries.get(id); if (item) { entries.delete(id); clearTimeout(item.timer); abort(item); } };
  const entry = (id: unknown): Entry => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw invalid();
    const item = entries.get(id); if (!item) throw expired(); return item;
  };
  const view = (id: string): ModelDraftView => {
    const item = entry(id), settings = item.settings, provider = settings.provider ?? "custom";
    const secrets = [...Object.entries(settings.env).filter(([key]) => /key|token|secret|password|authorization|url/i.test(key)).map(([, value]) => value),
      ...Object.values(settings.providers ?? {}).flatMap(value => [value.apiKey, value.baseUrl, ...Object.values(value.env ?? {}), ...Object.values(value.headers ?? {}),
        ...Object.values(value.models ?? {}).flatMap(model => [model.baseUrl, ...Object.values(model.headers ?? {})])])]
      .filter((value): value is string => typeof value === "string" && value.length > 0).sort((a, b) => b.length - a.length);
    const safe = (value: string) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
    const config = settings.providers?.[provider], providers = modelProviders(settings)
      .map(value => ({ id: safe(value.id), name: safe(value.name), canApiKey: value.canApiKey }));
    if (!providers.some(value => value.id === "custom")) providers.push({ id: "custom", name: "Custom endpoint", canApiKey: true });
    let models: ModelDraftView["models"] = [], protocols: string[] = [], thinkingLevels: string[] = [];
    try { models = providerModels(provider, settings).map(value => ({ id: safe(value.id), name: safe(value.name), api: safe(value.api), reasoning: value.reasoning })); } catch { /* incomplete draft */ }
    try { protocols = modelProtocols(provider).map(safe); } catch { /* incomplete draft */ }
    try { thinkingLevels = configuredThinkingLevels(settings).map(safe); } catch { /* incomplete draft */ }
    let protocol: string | null = config?.models?.[settings.model]?.api ?? config?.api ?? null;
    try { protocol = resolveConfiguredModel(settings).api; } catch { /* incomplete draft */ }
    return { id, version: item.version, provider: safe(provider), model: safe(settings.model), protocol: protocol === null ? null : safe(protocol), thinkingLevel: safe(settings.thinkingLevel),
      providers, models, protocols, thinkingLevels, keyConfigured: !!config?.apiKey, oauthSelected: !!config?.oauthId,
      endpointConfigured: !!(config?.models?.[settings.model]?.baseUrl || config?.baseUrl), checking: !!item.controller, canSave: item.checked === item.version && !item.controller,
      status: item.status };
  };
  const start = (): ModelDraftView => {
    if (entries.size >= maxDrafts) throw new WorkbenchError("MODEL_DRAFT_LIMIT", "打开的模型草稿过多，请先关闭。", 409);
    let settings: OhQuantSettings;
    try {
      const current = port.read(); settings = createModelSettingsDraft(current);
      if (!current.provider && settings.provider) {
        const provider = settings.provider, derived = settings.providers?.[provider], existing = current.providers?.[provider];
        // The TUI conversion copies a legacy/environment key into a provider slot.
        // Host opening must not implicitly migrate credentials or overwrite an existing provider.
        if (derived) { delete derived.apiKey; settings.providers![provider] = { ...derived, ...existing }; }
      }
    } catch { throw new WorkbenchError("MODEL_INVALID", "当前模型设置无效，请先修复本机配置。", 409); }
    const id = randomUUID(), timer = setTimeout(() => close(id), ttlMs); timer.unref?.();
    entries.set(id, { settings, version: 0, checked: null, status: null, controller: null, timer }); return view(id);
  };
  const edit = (input: ModelDraftEdit): ModelDraftView => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["id", "provider", "model", "protocol", "endpoint", "key", "thinkingLevel"].includes(key))) throw invalid();
    const item = entry(input.id), next = structuredClone(item.settings);
    for (const key of ["provider", "model", "thinkingLevel"] as const) if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key]!.trim() || input[key]!.length > 160 || /[\x00-\x1f\x7f]/.test(input[key]!))) throw invalid();
    if (input.key !== undefined && input.key !== null && (typeof input.key !== "string" || !input.key.trim() || input.key.length > 4096 || /[\x00-\x1f\x7f]/.test(input.key))) throw invalid();
    if (input.endpoint !== undefined && input.endpoint !== null) {
      if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) throw invalid();
      try { validateModelBaseUrl(input.endpoint); const url = new URL(input.endpoint);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw invalid();
      } catch { throw invalid(); }
    }
    if (input.provider !== undefined) {
      const provider = modelProviders(next).find(value => value.id === input.provider);
      if (input.provider !== "custom" && !provider?.canApiKey) throw invalid();
      next.providers ??= {};
      next.provider = input.provider;
      next.model = next.providers[input.provider]?.model ?? "";
      if (!next.model) next.model = providerModels(input.provider, next)[0]?.id ?? "";
    }
    const provider = next.provider; if (!provider) throw invalid();
    next.providers ??= {}; const config = next.providers[provider] ??= {};
    if (typeof input.key === "string" && provider !== "custom" && !modelProviders(next).find(value => value.id === provider)?.canApiKey) throw invalid();
    if (input.model !== undefined) next.model = input.model.trim();
    if (typeof input.key === "string" && [...Object.keys(config.headers ?? {}), ...Object.keys(config.models?.[next.model]?.headers ?? {})]
      .some(name => /auth|key|token/i.test(name))) {
      throw new WorkbenchError("MODEL_AUTH_HEADERS", "当前模型含额外认证头，无法在此安全替换密钥。", 409);
    }
    if (input.protocol !== undefined) {
      if (input.protocol !== null && (typeof input.protocol !== "string" || !modelProtocols(provider).includes(input.protocol))) throw invalid();
      config.api = input.protocol ?? undefined;
      if (config.models?.[next.model]) delete config.models[next.model]!.api;
    }
    if (input.endpoint !== undefined) { config.baseUrl = input.endpoint === null ? undefined : validateModelBaseUrl(input.endpoint); if (config.models?.[next.model]) delete config.models[next.model]!.baseUrl; }
    if (input.key === null) delete config.apiKey;
    else if (input.key !== undefined) { config.apiKey = input.key.trim(); delete config.oauthId; }
    if (input.thinkingLevel !== undefined) next.thinkingLevel = input.thinkingLevel;
    else if (input.provider !== undefined || input.model !== undefined || input.protocol !== undefined) {
      try { next.thinkingLevel = configuredThinking(next); } catch { /* incomplete draft remains editable */ }
    }
    abort(item); item.settings = next; item.version++; return view(input.id);
  };
  const verify = async (id: string): Promise<ModelDraftView> => {
    const item = entry(id); abort(item); item.version++; const version = item.version;
    if (port.read().revision !== item.settings.revision) throw new WorkbenchError("ESTORAGECONFLICT", "设置已被其他窗口修改，请重新打开草稿。", 409);
    try { resolveConfiguredModel(item.settings); if (!configuredThinkingLevels(item.settings).includes(item.settings.thinkingLevel)) throw invalid(); }
    catch { item.status = "invalid-config"; return view(id); }
    const controller = new AbortController(); item.controller = controller;
    let onAbort: (() => void) | undefined;
    try {
      const checked = await Promise.race([(options.probe ?? probeModelConnection)(structuredClone(item.settings), { signal: controller.signal, timeoutMs: probeTimeoutMs }),
        new Promise<ModelProbeResult>(resolve => { onAbort = () => resolve({ status: "cancelled", ok: false, detail: "" });
          if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener("abort", onAbort, { once: true }); })]);
      if (entries.get(id) !== item) throw expired();
      if (item.version === version && item.controller === controller) {
        item.controller = null; item.status = statuses.includes(checked.status) && (checked.status !== "ready" || checked.ok) ? checked.status : "unavailable";
        item.checked = item.status === "ready" && checked.ok ? version : null;
      }
      return view(id);
    } catch (error) {
      if (entries.get(id) !== item) throw expired();
      if (item.version === version && item.controller === controller) { item.controller = null; item.status = "unavailable"; item.checked = null; }
      return view(id);
    } finally { if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
  };
  const cancel = (id: string): ModelDraftView => { const item = entry(id); abort(item); item.version++; item.status = "cancelled"; return view(id); };
  const save = (input: ModelDraftSave): void => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["id", "version"].includes(key)) || !Number.isSafeInteger(input.version) || input.version < 0) throw invalid();
    const item = entry(input.id);
    if (item.version !== input.version) throw new WorkbenchError("MODEL_DRAFT_CONFLICT", "模型草稿已变化，请重新检查后保存。", 409);
    options.beforeSave();
    if (item.controller || item.checked !== item.version) throw new WorkbenchError("MODEL_DRAFT_UNVERIFIED", "请先成功检查当前模型草稿。", 409);
    const next = structuredClone(item.settings);
    try { resolveConfiguredModel(next); if (!configuredThinkingLevels(next).includes(next.thinkingLevel)) throw invalid(); }
    catch { throw new WorkbenchError("MODEL_INVALID", "模型或推理强度无效。", 409); }
    if (next.provider) { next.providers ??= {}; (next.providers[next.provider] ??= {}).model = next.model; }
    port.save(next); close(input.id);
  };
  const remove = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["provider", "revision"].includes(key)) || typeof input.provider !== "string" || !input.provider || input.provider.length > 160 || typeof input.revision !== "string" || !input.revision || input.revision.length > 160) throw invalid();
    options.beforeSave(); const next = structuredClone(port.read());
    if (next.revision !== input.revision) throw new WorkbenchError("ESTORAGECONFLICT", "设置已被其他窗口修改，请重新读取后再操作。", 409);
    const exists = !!next.providers && Object.hasOwn(next.providers, input.provider);
    if (!exists && input.provider !== "custom" && !modelProviders(next).some(value => value.id === input.provider)) throw invalid();
    const config = exists ? next.providers?.[input.provider] : undefined; if (!config?.apiKey) return false;
    delete config.apiKey; port.save(next); return true;
  };
  return { start, edit, verify, cancel, save, remove, close: (id: string) => { entry(id); close(id); }, dispose: () => { for (const id of entries.keys()) close(id); } };
}

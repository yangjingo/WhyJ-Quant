import { randomUUID } from "node:crypto";
import { DataSettingsDraft, validateDataEndpoint, type DataSettingsOptions } from "../../runtime/data/data-settings.ts";
import { dataSourcesForMarket } from "../../runtime/data/data-readiness.ts";
import type { DataMarket } from "../../types/data-readiness.ts";
import type { DataSource } from "../../types/config.ts";
import type { DataDraftEdit, DataDraftSave, DataDraftView } from "../../types/workbench.ts";
import type { SettingsPort } from "../workbench/model.ts";
import { WorkbenchError } from "../workbench/errors.ts";

const ttlMs = 10 * 60_000, maxDrafts = 8;
const invalid = () => new WorkbenchError("INPUT_INVALID", "数据源草稿参数无效。");
const unavailable = () => new WorkbenchError("DATA_DRAFT_EXPIRED", "数据源草稿已关闭或过期，请重新打开。", 409);
const sources: readonly DataSource[] = ["akshare", "tickflow", "tushare", "llmquant-data", "financial-datasets"];
const markets: readonly DataMarket[] = ["A", "US", "HK", "Fund"];

/** Host owns the secret-bearing drafts; public views contain only bounded sample metadata. */
export function createDataDrafts(port: SettingsPort, options: DataSettingsOptions & { beforeSave(): void; afterSave(): void }) {
  const entries = new Map<string, { draft: DataSettingsDraft; timer: ReturnType<typeof setTimeout>; version: number; cancelled: boolean }>();
  const close = (id: string) => { const entry = entries.get(id); if (entry) { entries.delete(id); clearTimeout(entry.timer); entry.draft.dispose(); } };
  const entry = (id: unknown) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw invalid();
    const value = entries.get(id); if (!value) throw unavailable(); return value;
  };
  const view = (id: string): DataDraftView => {
    const value = entry(id), result = value.draft.readiness;
    return { id, version: value.version, sample: value.draft.request, credential: value.draft.credentialLabel(),
      endpointConfigured: !!value.draft.endpoint(), checking: value.draft.checking, cancelled: value.cancelled, canSave: value.draft.canSave,
      result: result ? { status: result.status, rowCount: result.rowCount, asOfDate: result.asOfDate,
        observedAt: result.observedAt, capability: result.capability } : null };
  };
  const start = (): DataDraftView => {
    if (entries.size >= maxDrafts) throw new WorkbenchError("DATA_DRAFT_LIMIT", "打开的数据源草稿过多，请先关闭。", 409);
    const id = randomUUID(), draft = new DataSettingsDraft(port.read(), options);
    const timer = setTimeout(() => close(id), ttlMs); timer.unref?.();
    entries.set(id, { draft, timer, version: 0, cancelled: false }); return view(id);
  };
  const edit = (input: DataDraftEdit): DataDraftView => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["id", "market", "source", "symbol", "start", "end", "key", "endpoint"].includes(key))) throw invalid();
    const value = entry(input.id), draft = value.draft;
    if (input.market !== undefined && !markets.includes(input.market)) throw invalid();
    if (input.source !== undefined && !sources.includes(input.source)) throw invalid();
    const market = input.market ?? draft.request.market;
    if (input.source !== undefined && !dataSourcesForMarket(market).includes(input.source)) throw invalid();
    for (const key of ["symbol", "start", "end"] as const) if (input[key] !== undefined && (typeof input[key] !== "string" || input[key]!.length > 100)) throw invalid();
    if (input.key !== undefined && input.key !== null && (typeof input.key !== "string" || !input.key.trim() || input.key.length > 4096 || /[\x00-\x1f\x7f]/.test(input.key))) throw invalid();
    if (input.endpoint !== undefined && input.endpoint !== null) {
      if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) throw invalid();
      try { validateDataEndpoint(input.endpoint); const url = new URL(input.endpoint);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw invalid();
      } catch { throw invalid(); }
    }
    if (input.market !== undefined) draft.setMarket(input.market);
    if (input.source !== undefined) draft.setSource(input.source);
    for (const key of ["symbol", "start", "end"] as const) if (input[key] !== undefined) draft.setSample(key, input[key]!);
    if (input.key === null) draft.removeKey(); else if (input.key !== undefined) draft.setKey(input.key);
    if (input.endpoint !== undefined) draft.setEndpoint(input.endpoint ?? "");
    value.version++; value.cancelled = false; return view(input.id);
  };
  const verify = async (id: string): Promise<DataDraftView> => { const value = entry(id); value.cancelled = false; await value.draft.verify(); return view(id); };
  const cancel = (id: string): DataDraftView => {
    const value = entry(id);
    if (value.draft.checking) { value.draft.cancel(); value.version++; value.cancelled = true; }
    return view(id);
  };
  const save = (input: DataDraftSave): void => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["id", "version"].includes(key))
      || !Number.isSafeInteger(input.version) || input.version < 0) throw invalid();
    const value = entry(input.id);
    if (value.version !== input.version) throw new WorkbenchError("DATA_DRAFT_CONFLICT", "数据源草稿已变化，请重新检查后保存。", 409);
    options.beforeSave();
    let settings; try { settings = value.draft.prepareSave(); } catch { throw new WorkbenchError("DATA_DRAFT_UNVERIFIED", "请先成功检查当前草稿。", 409); }
    port.save(settings); close(input.id); options.afterSave(); };
  return { start, edit, verify, cancel, save, close: (id: string) => { entry(id); close(id); }, dispose: () => { for (const id of entries.keys()) close(id); } };
}

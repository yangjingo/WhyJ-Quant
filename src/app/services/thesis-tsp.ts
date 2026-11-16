import { createHash } from "node:crypto";
import { esc, renderArtifactTemplate } from "../../artifact/src/template.ts";
import { artifactReference, loadArtifactSnapshot, saveArtifact } from "../../storage/index.ts";
import type { ArtifactRequest, ArtifactSummary, SessionSnapshot } from "../../types/workbench.ts";
import type { ThesisRetainedEvidence, ThesisTspArchive, ThesisTspSelection } from "../../types/thesis-archive.ts";
import type { ThesisEvidence, ThesisReviewInput } from "../../types/thesis-review.ts";
import { validateThesisPriceContext } from "../../artifact/src/thesis-review.ts";
import type { TspObservations } from "../../types/thesis-tsp.ts";
import type { ThesisTspRequest, ThesisTspView } from "../../types/thesis-workbench.ts";
import { WorkbenchError } from "../workbench/errors.ts";
import { artifactRequest, submitRequest } from "./requests.ts";
import { readThesisBaseline } from "./thesis-baseline.ts";
import { inspectTspBatch, shanghaiDay, validDay } from "./thesis-tsp-data.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new WorkbenchError("TSP_OBSERVATION_UNAVAILABLE", "TSP 观察的固定版本无法读取或验证，原记录已保留。", 409);
const conflict = () => new WorkbenchError("REQUEST_CONFLICT", "请求标识已用于不同的 TSP 采集，未重复采集或保存。", 409);
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function thesisTspRequest(value: unknown): ThesisTspRequest {
  const fields = ["workspaceId", "sessionId", "artifactId", "sha256", "requestId", "expectedRevision"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
    throw new WorkbenchError("INVALID_REQUEST", "TSP 采集请求无效。");
  const raw = value as Record<string, unknown>;
  const ref = artifactRequest({ workspaceId: raw.workspaceId, sessionId: raw.sessionId, artifactId: raw.artifactId, sha256: raw.sha256 });
  const request = submitRequest({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, requestId: raw.requestId, expectedRevision: raw.expectedRevision, text: "TSP observation" });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(request.requestId)) throw new WorkbenchError("INVALID_REQUEST", "TSP 采集请求无效。");
  return { ...ref, requestId: request.requestId, expectedRevision: request.expectedRevision };
}

/** Raw JSON validity is deliberately weaker than a verified financial observation. */
function validateBatch(batch: TspObservations, symbol: string, recordedAt: string): void {
  if (!batch || batch.version !== 1 || batch.server !== "tsp" || batch.symbol !== symbol
    || JSON.stringify(batch.configuredScopes) !== JSON.stringify(["read:market", "read:analysis"])
    || !Array.isArray(batch.observations) || batch.observations.length !== 2) throw unavailable();
  for (const [index, item] of batch.observations.entries()) {
    const tool = index === 0 ? "get_recent_alerts" : "get_kline";
    const parameters = index === 0 ? { limit: 20 } : { symbol, limit: 100 };
    if (item.tool !== tool || JSON.stringify(item.parameters) !== JSON.stringify(parameters) || !iso(item.retrievedAt) || item.retrievedAt > recordedAt) throw unavailable();
    const source = new URL(item.sourceUrl);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password || source.search || source.hash) throw unavailable();
    if (item.status === "available") {
      if (typeof item.content !== "string" || !item.content.length || Buffer.byteLength(item.content) > 512 * 1024 || digest(item.content) !== item.sha256 || item.reason !== null) throw unavailable();
      const parsed: unknown = JSON.parse(item.content);
      if (!parsed || typeof parsed !== "object") throw unavailable();
    } else if (item.status !== "unavailable" || item.content !== null || item.sha256 !== null || typeof item.reason !== "string" || item.reason.length > 1000) throw unavailable();
  }
}

function summary(saved: NonNullable<ReturnType<typeof loadArtifactSnapshot>>): ArtifactSummary {
  return { id: saved.meta.sessionId, kind: "tsp-observation", version: 1, title: saved.meta.title, sha256: saved.meta.revision!, createdAt: saved.meta.createdAt };
}

export function readThesisTspRecord(ref: ArtifactRequest, snapshot: SessionSnapshot): ThesisTspView {
  try {
    if (ref.workspaceId !== snapshot.identity.workspaceId || ref.sessionId !== snapshot.identity.sessionId
      || !snapshot.output.artifacts.some(item => item.id === ref.artifactId && item.sha256 === ref.sha256)) throw unavailable();
    const saved = loadArtifactSnapshot(`${ref.artifactId}@${ref.sha256}`), record = saved?.privateResearch;
    if (!saved || artifactReference(saved.meta) !== `${ref.artifactId}@${ref.sha256}` || record?.kind !== "tsp-observation"
      || record.workspaceId !== ref.workspaceId || record.sessionId !== ref.sessionId) throw unavailable();
    const baseline = { workspaceId: ref.workspaceId, sessionId: ref.sessionId, artifactId: record.baseline.artifactId, sha256: record.baseline.revision };
    const base = readThesisBaseline(baseline, snapshot);
    if (base.kind !== "baseline") throw unavailable();
    validateBatch(record.batch, base.symbol, record.recordedAt);
    const { rows: _rows, ...preview } = inspectTspBatch(record.batch);
    return { artifact: summary(saved), baseline, recordedAt: record.recordedAt, symbol: record.batch.symbol, configuredScopes: record.batch.configuredScopes,
      ...preview,
      observations: record.batch.observations.map(({ content, ...item }) => ({ ...item, bytes: content === null ? 0 : Buffer.byteLength(content) })) };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw unavailable(); }
}

/** Resolve an explicit selection from an authorized immutable batch; never trust UI-supplied bars. */
export function resolveThesisTsp(value: unknown, baseline: ArtifactRequest, snapshot: SessionSnapshot, review: Pick<ThesisReviewInput, "symbol" | "cutoff" | "event">) {
  const invalid = () => new WorkbenchError("TSP_SELECTION_INVALID", "TSP 选择与固定来源不匹配，请核对提醒、观察截止、日线范围和成交量单位。", 409);
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4
      || !["artifactId", "revision", "alertIndex", "price"].every(key => Object.hasOwn(value, key))) throw invalid();
    const selection = structuredClone(value) as ThesisTspSelection;
    const ref = artifactRequest({ workspaceId: baseline.workspaceId, sessionId: baseline.sessionId, artifactId: selection.artifactId, sha256: selection.revision });
    if (selection.alertIndex !== null && (!Number.isSafeInteger(selection.alertIndex) || selection.alertIndex < 0)) throw invalid();
    const view = readThesisTspRecord(ref, snapshot);
    if (view.baseline.artifactId !== baseline.artifactId || view.baseline.sha256 !== baseline.sha256 || view.symbol !== review.symbol
      || view.observations.some(item => item.retrievedAt > review.cutoff)) throw invalid();
    const record = loadArtifactSnapshot(`${ref.artifactId}@${ref.sha256}`)?.privateResearch;
    if (record?.kind !== "tsp-observation") throw unavailable();
    const retained: ThesisRetainedEvidence[] = [], evidence: ThesisEvidence[] = [];
    if (selection.alertIndex !== null) {
      const alert = view.alerts.find(item => item.index === selection.alertIndex);
      if (!alert || Object.entries(alert.event).some(([key, entry]) => review.event[key as keyof typeof review.event] !== entry)) throw invalid();
      if (alert.price !== null) {
        const source = record.batch.observations.find(item => item.tool === "get_recent_alerts")!;
        evidence.push({ id: "tsp-alert-price", symbol: view.symbol, kind: "price", sourceUrl: source.sourceUrl, origin: "source",
          publishedAt: alert.event.occurredAt, retrievedAt: source.retrievedAt, dataRef: { id: "tsp-alerts", sha256: source.sha256! },
          metric: { name: "alert_price", value: alert.price, period: shanghaiDay(alert.event.occurredAt), unit: "CNY", adjustment: "none", definition: "TSP 提醒声明的价格；未以独立原始行情核对" } });
        retained.push({ id: "tsp-alerts", mediaType: "application/json", content: source.content! });
      }
    }
    let price = null;
    if (selection.price !== null) {
      const window = selection.price;
      if (!window || typeof window !== "object" || Array.isArray(window) || Object.keys(window).length !== 3
        || !validDay(window.start) || !validDay(window.end) || !["shares", "lots"].includes(window.volumeUnit)
        || !view.daily || window.start < view.daily.start || window.end > view.daily.end || window.start > window.end) throw invalid();
      const source = record.batch.observations.find(item => item.tool === "get_kline")!;
      const rows = inspectTspBatch(record.batch).rows.filter(row => row.date >= window.start && row.date <= window.end);
      price = validateThesisPriceContext({ symbol: view.symbol, sourceUrl: source.sourceUrl, retrievedAt: source.retrievedAt, adjustment: "forward", currency: "CNY",
        volumeUnit: window.volumeUnit, dataRef: { id: "tsp-kline", sha256: source.sha256 }, rows }, review);
      retained.push({ id: "tsp-kline", mediaType: "application/json", content: source.content! });
    }
    return { selection, view, price, evidence, retained };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw invalid(); }
}

/** Authorizes the exact baseline before any connection, including retries of an orphaned save. */
export function prepareThesisTsp(value: unknown, snapshot: SessionSnapshot, clean: (text: string) => string) {
  const request = thesisTspRequest(value), base = readThesisBaseline(request, snapshot);
  if (base.kind !== "baseline") throw unavailable();
  const { expectedRevision: _revision, ...businessInput } = request;
  const fingerprint = digest(JSON.stringify({ kind: "tsp-observation", ...businessInput }));
  // Share the request-id namespace with manual baseline/review operations.
  const artifactId = "thesis-" + digest(JSON.stringify({ requestId: request.requestId, sessionId: request.sessionId, workspaceId: request.workspaceId }));
  const prior = loadArtifactSnapshot(artifactId);
  if (!prior && snapshot.output.artifacts.some(item => item.id === artifactId)) throw unavailable();
  let existing: ArtifactSummary | null = null;
  if (prior) {
    const record = prior.privateResearch;
    if (record?.kind !== "tsp-observation" || record.workspaceId !== request.workspaceId || record.sessionId !== request.sessionId
      || record.requestId !== request.requestId || record.requestFingerprint !== fingerprint) throw conflict();
    existing = summary(prior);
    readThesisTspRecord({ ...request, artifactId, sha256: existing.sha256 }, { ...snapshot, output: { ...snapshot.output, artifacts: [...snapshot.output.artifacts, existing] } });
  }
  return { request, fingerprint, artifactId, existing, symbol: base.symbol,
    save(batch: TspObservations): ArtifactSummary {
      if (existing) return existing;
      try {
        const now = new Date().toISOString(); validateBatch(batch, base.symbol, now);
        const archive: ThesisTspArchive = { version: 1, kind: "tsp-observation", workspaceId: request.workspaceId, sessionId: request.sessionId,
          requestId: request.requestId, requestFingerprint: fingerprint, recordedAt: now,
          baseline: { artifactId: request.artifactId, revision: request.sha256 }, batch };
        const encoded = JSON.stringify(archive);
        if (clean(encoded) !== encoded) throw new WorkbenchError("THESIS_PRIVATE_INPUT", "TSP 返回内容包含当前配置凭据，未保存。");
        const html = renderArtifactTemplate({ title: `${base.symbol} · TSP 固定观察`, sessionId: artifactId, model: "TSP read-only observation · no model run", messageCount: 0,
          description: "显式采集的原始工具结果，不是基本面事实认证或买卖建议。", createdAt: now, generatedAt: now,
          bodyHtml: `<section class="research-bound"><h2>TSP 固定观察</h2><p>${esc(base.symbol)} · ${esc(now)}</p><p>基线 ${esc(request.artifactId)} / ${request.sha256}</p><p>配置声明 read:market / read:analysis；实际授权由服务端验证。只调用下列两个工具，未生成公开分享副本。</p><p>提醒不代替原始披露。K 线接口可能包含当日未完成数据，limit 参数不保证返回窗口，成交量单位需另外核实。</p>${batch.observations.map(item => `<h3>${item.tool} · ${item.status === "available" ? "已保留原始 JSON，语义待核对" : "不可用"}</h3><p>${esc(item.sourceUrl)} · ${esc(item.retrievedAt)}</p><p>参数 ${esc(JSON.stringify(item.parameters))} · SHA256 ${item.sha256 ?? "无"}</p><pre>${esc(item.content ?? item.reason ?? "不可用")}</pre>`).join("")}</section>`,
          dockHtml: "", trajectoryHtml: "<p>用户显式采集，未运行模型。</p>" });
        const source = loadArtifactSnapshot(`${request.artifactId}@${request.sha256}`);
        if (!source) throw unavailable();
        const meta = saveArtifact(artifactId, html, { title: `${base.symbol} · TSP 固定观察`, sourceSessionId: source.meta.sourceSessionId ?? source.meta.sessionId, privateResearch: archive }, null);
        return summary({ version: 1, meta, html, privateResearch: archive });
      } catch (error) {
        if ((error as { code?: string })?.code === "ESTORAGECONFLICT") throw conflict();
        if (error instanceof WorkbenchError) throw error;
        throw unavailable();
      }
    } };
}

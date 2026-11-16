import { createHash } from "node:crypto";
import { compareThesisReview, validateThesisReview } from "../../research/thesis-review.ts";
import { esc, renderArtifactTemplate } from "../../artifact/src/template.ts";
import { renderThesisReviewArtifact, validateThesisPriceContext } from "../../artifact/src/thesis-review.ts";
import { loadArtifactSnapshot, saveArtifact } from "../../storage/index.ts";
import type { ArtifactRequest, ArtifactSummary, SessionSnapshot } from "../../types/workbench.ts";
import type { ThesisBaselineArchive, ThesisRetainedEvidence, ThesisReviewArchive } from "../../types/thesis-archive.ts";
import type { ThesisReviewInput } from "../../types/thesis-review.ts";
import type { ThesisBaselineRequest, ThesisReviewRequest, ThesisView } from "../../types/thesis-workbench.ts";
import { baselineInput, fixed, owned, readThesisBaseline, validateBaseline } from "./thesis-baseline.ts";
import { resolveThesisSources } from "./thesis-sources.ts";
import { resolveThesisTsp } from "./thesis-tsp.ts";
import { artifactRequest, submitRequest } from "./requests.ts";
import { WorkbenchError } from "../workbench/errors.ts";

const invalid = () => new WorkbenchError("THESIS_INPUT_INVALID", "复核输入无效，请检查对象、来源、日期和固定数据后重试。");
type ArtifactSnapshot = NonNullable<ReturnType<typeof loadArtifactSnapshot>>;
const unavailable = () => new WorkbenchError("THESIS_UNAVAILABLE", "基线或复核的固定版本无法读取或验证，原记录已保留。", 409);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const keys = (value: unknown, expected: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
};

export function thesisRequest(kind: "baseline", value: unknown): ThesisBaselineRequest;
export function thesisRequest(kind: "review", value: unknown): ThesisReviewRequest;
export function thesisRequest(kind: "baseline" | "review", value: unknown): ThesisBaselineRequest | ThesisReviewRequest {
  const common = ["workspaceId", "sessionId", "artifactId", "sha256", "requestId", "expectedRevision"];
  const optional = kind === "review" && value && typeof value === "object" ? ["tsp", "checks"].filter(key => Object.hasOwn(value, key)) : [];
  const raw = keys(value, [...common, ...(kind === "baseline" ? ["groupId", "symbol", "assumption"] : ["cutoff", "event", "evidence", "parameters", "decision", "retainedEvidence", "price"]), ...optional]);
  const ref = artifactRequest({ workspaceId: raw.workspaceId, sessionId: raw.sessionId, artifactId: raw.artifactId, sha256: raw.sha256 });
  const identity = submitRequest({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, requestId: raw.requestId, expectedRevision: raw.expectedRevision, text: "manual review" });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(identity.requestId)) throw invalid();
  // The semantic validators run against the stored baseline before writing.
  try { return structuredClone({ ...raw, ...ref, requestId: identity.requestId, expectedRevision: identity.expectedRevision }) as unknown as ThesisBaselineRequest | ThesisReviewRequest; }
  catch { throw invalid(); }
}

function retained(value: unknown, input: ThesisReviewInput, price: ThesisReviewArchive["price"]): ThesisRetainedEvidence[] {
  if (!Array.isArray(value) || value.length > 21) throw invalid();
  const items = value.map(entry => {
    const row = keys(entry, ["id", "mediaType", "content"]);
    if (typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(row.id)
      || !["text/plain", "application/json"].includes(String(row.mediaType)) || typeof row.content !== "string" || !row.content.length || Buffer.byteLength(row.content) > 512 * 1024) throw invalid();
    if (row.mediaType === "application/json") { try { JSON.parse(row.content); } catch { throw invalid(); } }
    return { id: row.id, mediaType: row.mediaType as ThesisRetainedEvidence["mediaType"], content: row.content };
  });
  if (new Set(items.map(item => item.id)).size !== items.length || Buffer.byteLength(JSON.stringify(items)) > 3 * 1024 * 1024) throw invalid();
  const refs = [...input.evidence.flatMap(item => item.dataRef ? [item.dataRef] : []), ...(price ? [price.dataRef] : [])];
  if (items.some(item => !refs.some(ref => ref.id === item.id))) throw invalid();
  for (const ref of refs) {
    const item = items.find(item => item.id === ref.id);
    if (!item || digest(item.content) !== ref.sha256) throw new WorkbenchError("THESIS_EVIDENCE_UNAVAILABLE", "证据版本缺少匹配的保留原文，未生成或替换报告。", 409);
  }
  return items;
}

/** Reads fixed private records; bodies stay in the archive rather than the generic UI projection. */
export function readThesisRecord(ref: ArtifactRequest, snapshot: SessionSnapshot): ThesisView {
  try {
    const { artifact, saved } = fixed(ref, snapshot), record = owned(saved, snapshot);
    if (record.kind === "baseline") return readThesisBaseline(ref, snapshot);
    if (record.kind !== "review") throw unavailable();
    const input = validateThesisReview(record.input), source = { workspaceId: ref.workspaceId, sessionId: ref.sessionId, artifactId: input.baseline.artifactId, sha256: input.baseline.revision };
    const priorRecord = owned(fixed(source, snapshot).saved, snapshot);
    if (priorRecord.kind !== "baseline") throw unavailable();
    const prior = readThesisBaseline(source, snapshot);
    if (prior.kind !== "baseline" || prior.groupId !== input.groupId || prior.symbol !== input.symbol
      || stable({ artifactId: source.artifactId, revision: source.sha256, ...prior.assumption }) !== stable(input.baseline)) throw unavailable();
    const price = record.price === null ? null : validateThesisPriceContext(record.price, input);
    const sources = retained(record.retainedEvidence, input, price);
    const tsp = Object.hasOwn(record, "tsp") ? resolveThesisTsp(record.tsp, source, snapshot, input) : null;
    if (tsp && (stable(input.evidence.filter(item => item.id.startsWith("tsp-"))) !== stable(tsp.evidence)
      || tsp.selection.price !== null && stable(price) !== stable(tsp.price)
      || tsp.retained.some(item => sources.find(source => source.id === item.id)?.content !== item.content))) throw unavailable();
    const checks = Object.hasOwn(record, "checks") ? resolveThesisSources(record.checks, source, snapshot, input, price) : null;
    if (checks && (stable(input.evidence.filter(item => item.id.startsWith("checks-"))) !== stable(checks.evidence)
      || checks.retained.some(item => sources.find(source => source.id === item.id)?.content !== item.content))) throw unavailable();
    return { kind: "review", artifact, recordedAt: record.recordedAt, source, result: compareThesisReview(input), price,
      ...(tsp ? { tsp: { ...tsp.view, selection: tsp.selection } } : {}),
      ...(checks ? { checks: { view: checks.view, selection: checks.selection, priceComparison: checks.priceComparison } } : {}),
      retainedEvidence: sources.map(item => ({ id: item.id, mediaType: item.mediaType, sha256: digest(item.content), bytes: Buffer.byteLength(item.content) })) };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw unavailable(); }
}

export interface PreparedThesis {
  request: ThesisBaselineRequest | ThesisReviewRequest;
  artifactId: string;
  fingerprint: string;
  existing: ArtifactSummary | null;
  save(): ArtifactSummary;
}

/** Preparation is synchronous and read-only; the service owns checkpoint serialization. */
export function prepareThesisRecord(kind: "baseline" | "review", value: unknown, snapshot: SessionSnapshot, clean: (text: string) => string, now = new Date().toISOString()): PreparedThesis {
  try {
    const request = kind === "baseline" ? thesisRequest("baseline", value) : thesisRequest("review", value);
    const { saved: sourceSaved } = fixed(request, snapshot);
    let archive: ThesisBaselineArchive | ThesisReviewArchive;
    const owner = { version: 1 as const, workspaceId: request.workspaceId, sessionId: request.sessionId, requestId: request.requestId, requestFingerprint: "", recordedAt: now };
    if (kind === "baseline") {
      const input = request as ThesisBaselineRequest;
      keys(input.assumption, ["assumptionId", "statement", "metric", "threshold"]);
      archive = validateBaseline({ ...owner, kind, source: { artifactId: input.artifactId, revision: input.sha256 }, groupId: input.groupId, symbol: input.symbol, assumption: { ...input.assumption, asOf: now } });
    } else {
      const input = request as ThesisReviewRequest, base = owned(sourceSaved, snapshot);
      if (base.kind !== "baseline") throw unavailable();
      readThesisRecord(request, snapshot);
      let review = validateThesisReview({ version: 1, id: input.requestId, groupId: base.groupId, symbol: base.symbol, cutoff: input.cutoff,
        baseline: baselineInput(base, input.artifactId, input.sha256), event: input.event, evidence: input.evidence, parameters: input.parameters, decision: input.decision });
      if (review.cutoff > now || review.decision && review.decision.decidedAt > now) throw invalid();
      const tsp = Object.hasOwn(input, "tsp") ? resolveThesisTsp(input.tsp, input, snapshot, review) : null;
      if (tsp && (review.evidence.some(item => item.id.startsWith("tsp-")) || input.retainedEvidence.some(item => item.id.startsWith("tsp-"))
        || tsp.selection.price !== null && input.price !== null)) throw invalid();
      if (tsp) review = validateThesisReview({ ...review, evidence: [...review.evidence, ...tsp.evidence] });
      const price = tsp?.price ?? (input.price === null ? null : validateThesisPriceContext(input.price, review));
      const checks = Object.hasOwn(input, "checks") ? resolveThesisSources(input.checks, input, snapshot, review, price) : null;
      if (checks && (review.evidence.some(item => item.id.startsWith("checks-")) || input.retainedEvidence.some(item => item.id.startsWith("checks-")))) throw invalid();
      if (checks) review = validateThesisReview({ ...review, evidence: [...review.evidence, ...checks.evidence] });
      archive = { ...owner, kind, input: review, price, retainedEvidence: retained([...input.retainedEvidence, ...(tsp?.retained ?? []), ...(checks?.retained ?? [])], review, price),
        ...(tsp ? { tsp: tsp.selection } : {}), ...(checks ? { checks: checks.selection } : {}) };
    }
    const { expectedRevision: _revision, ...businessInput } = request;
    const fingerprint = digest(stable({ kind, ...businessInput }));
    archive = { ...archive, requestFingerprint: fingerprint };
    const encoded = JSON.stringify(archive);
    if (clean(encoded) !== encoded) throw new WorkbenchError("THESIS_PRIVATE_INPUT", "复核输入包含当前配置凭据，未保存。请移除授权信息后重试。");
    const artifactId = "thesis-" + digest(stable({ workspaceId: request.workspaceId, sessionId: request.sessionId, requestId: request.requestId }));
    const previous = loadArtifactSnapshot(artifactId);
    const summary = (saved: ArtifactSnapshot): ArtifactSummary => ({ id: artifactId, title: saved.meta.title, kind: kind === "baseline" ? "thesis-baseline" : "thesis-review", version: 1, sha256: saved.meta.revision!, createdAt: saved.meta.createdAt });
    if (previous) {
      const record = owned(previous, snapshot);
      if (record.requestId !== request.requestId || record.requestFingerprint !== fingerprint || record.kind !== kind)
        throw new WorkbenchError("REQUEST_CONFLICT", "请求标识已用于不同的复核输入，未重复保存。", 409);
      const existing = summary(previous);
      readThesisRecord({ ...request, artifactId, sha256: existing.sha256 }, { ...snapshot, output: { ...snapshot.output, artifacts: [...snapshot.output.artifacts, existing] } });
      return { request, artifactId, fingerprint, existing, save: () => existing };
    }
    const report = archive.kind === "review"
      ? renderThesisReviewArtifact(archive.input, { reportId: artifactId, generatedAt: now, price: archive.price ? { ...archive.price, rows: archive.price.rows.map(row => ({ ...row })) } : null,
          ...(archive.tsp ? { tsp: { selection: archive.tsp, view: resolveThesisTsp(archive.tsp, request, snapshot, archive.input).view } } : {}),
          ...(archive.checks ? { checks: resolveThesisSources(archive.checks, request, snapshot, archive.input, archive.price) } : {}) }).html
      : renderArtifactTemplate({ title: `${archive.symbol} · 人工设立假设基线`, sessionId: artifactId, model: "Manual baseline · no model run", messageCount: 0,
        description: "本次人工明确登记的结构化假设，不代表历史报告已包含同样记录。", createdAt: now, generatedAt: now,
        bodyHtml: `<section class="research-bound"><h2>人工设立的基线</h2><p>生效时间 ${esc(now)} · 观察组 ${esc(archive.groupId)} · ${esc(archive.symbol)}</p><p>${esc(archive.assumption.statement)}</p><p>${esc(archive.assumption.metric.name)}：${archive.assumption.metric.value ?? "未提供"} ${esc(archive.assumption.metric.unit)} · ${esc(archive.assumption.metric.period)} · ${esc(archive.assumption.metric.definition)} · ${archive.assumption.metric.adjustment}</p><p>声明条件 ${archive.assumption.threshold.operator} ${archive.assumption.threshold.value}</p><p>参考既有报告 <code>${esc(archive.source.artifactId)}</code> / <code>${archive.source.revision}</code></p><p>生效前事件不能冒充后续新证据；后续复核保留此基线的精确版本。未生成公开分享副本。</p></section>`, dockHtml: "", trajectoryHtml: "<p>人工登记，未运行模型。</p>" });
    return { request, artifactId, fingerprint, existing: null, save() {
      try {
        const meta = saveArtifact(artifactId, report, { title: `${archive.kind === "baseline" ? "假设基线" : "事件复核"} · ${archive.kind === "baseline" ? archive.symbol : archive.input.symbol}`, sourceSessionId: sourceSaved.meta.sourceSessionId ?? sourceSaved.meta.sessionId, privateResearch: archive }, null);
        return summary({ version: 1, meta, html: report, privateResearch: archive });
      } catch (error) {
        if ((error as { code?: string })?.code === "ESTORAGECONFLICT") throw new WorkbenchError("REQUEST_CONFLICT", "复核版本已变化，请重新读取后重试。", 409);
        throw unavailable();
      }
    } };
  } catch (error) { if (error instanceof WorkbenchError) throw error; if ((error as { code?: string })?.code === "ESTORAGECONFLICT") throw new WorkbenchError("REQUEST_CONFLICT", "复核版本已变化，请重新读取后重试。", 409); throw invalid(); }
}

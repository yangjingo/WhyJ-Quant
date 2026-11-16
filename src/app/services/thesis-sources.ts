import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { esc, renderArtifactTemplate } from "../../artifact/src/template.ts";
import { normalizeBarSeries, validateDateRange } from "../../market/bars.ts";
import { loadArtifactSnapshot, loadDataset, saveArtifact } from "../../storage/index.ts";
import { compareThesisPrices } from "../../runtime/research/thesis-price-check.ts";
import type { ArtifactRequest, ArtifactSummary, SessionSnapshot } from "../../types/workbench.ts";
import type { ThesisPriceContext, ThesisRetainedEvidence, ThesisSourceArchive, ThesisSourceSelection } from "../../types/thesis-archive.ts";
import type { ThesisEvidence, ThesisReviewInput } from "../../types/thesis-review.ts";
import type { ThesisSourcesReadRequest, ThesisSourcesRequest, ThesisSourcesView } from "../../types/thesis-workbench.ts";
import { WorkbenchError } from "../workbench/errors.ts";
import { artifactRequest, submitRequest } from "./requests.ts";
import { fixed, owned, readThesisBaseline } from "./thesis-baseline.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const unavailable = () => new WorkbenchError("THESIS_SOURCES_UNAVAILABLE", "核对来源的固定版本无法读取或验证，原记录已保留。", 409);
const invalid = () => new WorkbenchError("THESIS_SOURCES_INVALID", "请核对固定日期、公告地址及引用页码和原文。");
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keys = (value: unknown, expected: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
};
const refFields = ["workspaceId", "sessionId", "artifactId", "sha256"];
function url(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2048) throw invalid();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search) throw invalid();
    parsed.hash = ""; return parsed.href;
  } catch { throw invalid(); }
}

export function thesisSourcesRequest(value: unknown): ThesisSourcesRequest {
  const raw = keys(value, [...refFields, "requestId", "expectedRevision", "start", "end", "disclosureUrl"]);
  const ref = artifactRequest(Object.fromEntries(refFields.map(key => [key, raw[key]])));
  const identity = submitRequest({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, requestId: raw.requestId, expectedRevision: raw.expectedRevision, text: "Source check" });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(identity.requestId) || typeof raw.start !== "string" || typeof raw.end !== "string") throw invalid();
  try { validateDateRange(raw.start, raw.end); } catch { throw invalid(); }
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (raw.end >= today || Date.parse(raw.end) - Date.parse(raw.start) > 365 * 86_400_000) throw invalid();
  return { ...ref, requestId: identity.requestId, expectedRevision: identity.expectedRevision, start: raw.start, end: raw.end, disclosureUrl: url(raw.disclosureUrl) };
}

export function thesisSourcesReadRequest(value: unknown): ThesisSourcesReadRequest {
  const hasPage = !!value && typeof value === "object" && Object.hasOwn(value, "page");
  const raw = keys(value, [...refFields, ...(hasPage ? ["page"] : [])]);
  const ref = artifactRequest(Object.fromEntries(refFields.map(key => [key, raw[key]])));
  if (hasPage && (typeof raw.page !== "number" || !Number.isSafeInteger(raw.page) || raw.page < 1 || raw.page > 400)) throw invalid();
  return { ...ref, ...(hasPage ? { page: raw.page as number } : {}) };
}

function validateRecord(record: ThesisSourceArchive, symbol: string): void {
  const price = record.price;
  if (!price || price.symbol !== symbol || !iso(price.checkedAt) || price.checkedAt > record.recordedAt) throw unavailable();
  validateDateRange(price.start, price.end);
  if (Date.parse(price.end) - Date.parse(price.start) > 365 * 86_400_000 || price.end >= new Date(Date.parse(price.checkedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)) throw unavailable();
  if (price.status === "available") {
    const dataset = price.dataset;
    if (!["provider", "cache", "stale-cache"].includes(price.origin) || !dataset || dataset.symbol !== symbol || dataset.market !== "A" || dataset.source !== price.source
      || dataset.requested.start !== price.start || dataset.requested.end !== price.end || !iso(dataset.snapshotAt) || dataset.snapshotAt > price.checkedAt
      || !price.bars.length || price.bars.length > 366 || !isDeepStrictEqual(normalizeBarSeries(price.bars, price.start, price.end), price.bars)
      || !isDeepStrictEqual(loadDataset(dataset), price.bars)) throw unavailable();
  } else if (price.status !== "unavailable" || typeof price.reason !== "string" || price.reason.length > 2000) throw unavailable();
  if (url(record.disclosureUrl) !== record.disclosureUrl) throw unavailable();
  const doc = record.disclosure;
  if (record.disclosureUrl === null) { if (doc !== null) throw unavailable(); return; }
  if (!doc || doc.symbol !== symbol || doc.method !== "unpdf-1.9.1-page-text" || !iso(doc.fetchedAt) || doc.fetchedAt > record.recordedAt
    || !["available", "truncated", "empty", "unsupported", "restricted", "unavailable"].includes(doc.status)
    || !["header-match", "unverified"].includes(doc.symbolMention) || typeof doc.reason !== "string" || doc.reason.length > 2000
    || !Array.isArray(doc.pages) || doc.pages.length > 400 || !Number.isSafeInteger(doc.totalPages) || doc.totalPages < 0 || doc.totalPages > 400
    || doc.pages.some((page, index) => page.page !== index + 1 || typeof page.text !== "string")
    || doc.pages.reduce((sum, page) => sum + page.text.length, 0) > 200_000) throw unavailable();
  if (["available", "truncated", "empty"].includes(doc.status)) {
    if (doc.requestedUrl !== record.disclosureUrl || !doc.finalUrl || url(doc.finalUrl) !== doc.finalUrl || !/^[a-f0-9]{64}$/.test(doc.originalSha256 ?? "")
      || !Number.isSafeInteger(doc.originalBytes) || doc.originalBytes < 1 || doc.originalBytes > 8 * 1024 * 1024
      || doc.textSha256 !== digest(JSON.stringify(doc.pages)) || !doc.pages.length || doc.pages.length > doc.totalPages) throw unavailable();
  } else if (doc.pages.length || doc.textSha256 !== null || doc.originalSha256 !== null || doc.originalBytes !== 0 || doc.totalPages !== 0
    || (doc.requestedUrl !== record.disclosureUrl && !(doc.status === "unsupported" && doc.requestedUrl === ""))) throw unavailable();
}

function sourceRecord(ref: ArtifactRequest, snapshot: SessionSnapshot) {
  const { artifact, saved } = fixed(ref, snapshot), record = owned(saved, snapshot);
  if (record.kind !== "source-check") throw unavailable();
  const baseline = { workspaceId: ref.workspaceId, sessionId: ref.sessionId, artifactId: record.baseline.artifactId, sha256: record.baseline.revision };
  const base = readThesisBaseline(baseline, snapshot);
  if (base.kind !== "baseline") throw unavailable();
  validateRecord(record, base.symbol); return { artifact, saved, record, baseline };
}

export function readThesisSourcesRecord(ref: ThesisSourcesReadRequest, snapshot: SessionSnapshot): ThesisSourcesView {
  try {
    const { artifact, record, baseline } = sourceRecord(ref, snapshot), doc = record.disclosure;
    const selected = ref.page === undefined ? null : doc?.pages.find(page => page.page === ref.page);
    if (ref.page !== undefined && !selected) throw invalid();
    const price = record.price.status === "unavailable" ? record.price : (({ bars, ...rest }) => ({ ...rest, barCount: bars.length }))(record.price);
    return { artifact, baseline, recordedAt: record.recordedAt, disclosureUrl: record.disclosureUrl, price,
      disclosure: doc ? { ...doc, pages: doc.pages.map(page => ({ page: page.page, characters: page.text.length })) } : null,
      page: selected ? { page: selected.page, text: selected.text.slice(0, 20_000), truncated: selected.text.length > 20_000 } : null };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw unavailable(); }
}

export function resolveThesisSources(value: unknown, baseline: ArtifactRequest, snapshot: SessionSnapshot, review: Pick<ThesisReviewInput, "symbol" | "cutoff">, price: ThesisPriceContext | null) {
  try {
    keys(value, ["artifactId", "revision", "disclosure"]);
    const selection = structuredClone(value) as ThesisSourceSelection;
    const ref = artifactRequest({ workspaceId: baseline.workspaceId, sessionId: baseline.sessionId, artifactId: selection.artifactId, sha256: selection.revision });
    const { record, baseline: base } = sourceRecord(ref, snapshot), view = readThesisSourcesRecord(ref, snapshot);
    if (base.artifactId !== baseline.artifactId || base.sha256 !== baseline.sha256 || record.price.symbol !== review.symbol
      || record.price.checkedAt > review.cutoff || record.disclosure && record.disclosure.fetchedAt > review.cutoff) throw invalid();
    const evidence: ThesisEvidence[] = [], retained: ThesisRetainedEvidence[] = [];
    if (selection.disclosure !== null) {
      keys(selection.disclosure, ["page", "quote", "publishedAt", "metric", "confirmed"]);
      const selected = selection.disclosure, doc = record.disclosure;
      if (!Number.isSafeInteger(selected.page) || typeof selected.quote !== "string" || !selected.quote.trim() || selected.quote.length > 4000
        || !iso(selected.publishedAt) || typeof selected.confirmed !== "boolean" || !doc || !["available", "truncated"].includes(doc.status)
        || !doc.pages.find(page => page.page === selected.page)?.text.includes(selected.quote)) throw invalid();
      const id = "checks-disclosure-quote";
      evidence.push({ id: "checks-disclosure", symbol: review.symbol, kind: "fundamental", sourceUrl: doc.finalUrl!, publishedAt: selected.publishedAt,
        retrievedAt: doc.fetchedAt, origin: selected.confirmed ? "source" : "interpretation", dataRef: { id, sha256: digest(selected.quote) }, metric: selected.metric });
      retained.push({ id, mediaType: "text/plain", content: selected.quote });
    }
    const priceComparison = price ? compareThesisPrices({ symbol: price.symbol, start: record.price.start, end: record.price.end, observedAt: price.retrievedAt,
      adjustment: price.adjustment === "forward" ? "forward-adjusted" : price.adjustment === "none" ? "unadjusted" : "provider-unspecified",
      rows: price.rows.map(({ date, open, high, low, close }) => ({ date, open, high, low, close })) }, record.price) : null;
    return { selection, view, priceComparison, evidence, retained };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw invalid(); }
}

export function prepareThesisSources(value: unknown, snapshot: SessionSnapshot, clean: (text: string) => string) {
  const request = thesisSourcesRequest(value), base = readThesisBaseline(request, snapshot);
  if (base.kind !== "baseline") throw unavailable();
  const { expectedRevision: _revision, ...businessInput } = request;
  const fingerprint = digest(JSON.stringify({ kind: "source-check", ...businessInput }));
  const artifactId = "thesis-" + digest(JSON.stringify({ requestId: request.requestId, sessionId: request.sessionId, workspaceId: request.workspaceId }));
  const prior = loadArtifactSnapshot(artifactId);
  if (!prior && snapshot.output.artifacts.some(item => item.id === artifactId)) throw unavailable();
  const summary = (meta: NonNullable<ReturnType<typeof loadArtifactSnapshot>>["meta"]): ArtifactSummary => ({ id: artifactId, kind: "source-check", version: 1, title: meta.title, sha256: meta.revision!, createdAt: meta.createdAt });
  let existing: ArtifactSummary | null = null;
  if (prior) {
    const record = owned(prior, snapshot);
    if (record.kind !== "source-check" || record.requestFingerprint !== fingerprint || record.requestId !== request.requestId)
      throw new WorkbenchError("REQUEST_CONFLICT", "请求标识已用于不同的来源核对，未重复取证。", 409);
    existing = summary(prior.meta);
    readThesisSourcesRecord({ ...request, artifactId, sha256: existing.sha256 }, { ...snapshot, output: { ...snapshot.output, artifacts: [...snapshot.output.artifacts, existing] } });
  }
  return { request, fingerprint, artifactId, existing, symbol: base.symbol,
    save(batch: Pick<ThesisSourceArchive, "price" | "disclosure">): ArtifactSummary {
      if (existing) return existing;
      try {
        const now = new Date().toISOString();
        const record: ThesisSourceArchive = { ...batch, version: 1, kind: "source-check", workspaceId: request.workspaceId, sessionId: request.sessionId,
          requestId: request.requestId, requestFingerprint: fingerprint, recordedAt: now, baseline: { artifactId: request.artifactId, revision: request.sha256 }, disclosureUrl: request.disclosureUrl };
        if (record.price.start !== request.start || record.price.end !== request.end) throw unavailable();
        validateRecord(record, base.symbol);
        const encoded = JSON.stringify(record); if (clean(encoded) !== encoded) throw new WorkbenchError("THESIS_PRIVATE_INPUT", "来源结果包含当前配置凭据，未保存。请检查数据源。");
        const html = renderArtifactTemplate({ title: `${base.symbol} · 固定来源核对`, sessionId: artifactId, model: "Source observations · no model run", messageCount: 0,
          description: "配置行情源与公告提取的固定观察；财务判断和披露口径仍需人工核对。", createdAt: now, generatedAt: now,
          bodyHtml: `<section class="research-bound"><h2>固定来源核对</h2><p>${esc(base.symbol)} · ${esc(now)}</p><p>基线 ${esc(request.artifactId)} / ${request.sha256}</p><h3>配置行情源</h3><pre>${esc(JSON.stringify(record.price, null, 2))}</pre><h3>公告原文提取</h3><p>${esc(record.disclosureUrl ?? "未请求公告")}</p>${record.disclosure ? `<p>${esc(record.disclosure.status)} · 原文件 SHA256 ${record.disclosure.originalSha256 ?? "无"} · 文本 SHA256 ${record.disclosure.textSha256 ?? "无"}</p><p>最终来源 ${esc(record.disclosure.finalUrl ?? "无")} · 取得 ${esc(record.disclosure.fetchedAt)} · 方法 ${esc(record.disclosure.method)} · 共 ${record.disclosure.totalPages} 页 · 代码线索 ${esc(record.disclosure.symbolMention)}</p><p>${esc(record.disclosure.reason)}</p>${record.disclosure.pages.map(page => `<h4>第 ${page.page} 页</h4><pre>${esc(page.text)}</pre>`).join("")}` : "<p>未读取披露，不据此生成基本面事实。</p>"}</section>`,
          dockHtml: "", trajectoryHtml: "<p>显式来源核对，未运行模型。固定文本不是原始 PDF 下载。</p>" });
        const source = fixed(request, snapshot).saved;
        return summary(saveArtifact(artifactId, html, { title: `${base.symbol} · 固定来源核对`, sourceSessionId: source.meta.sourceSessionId ?? source.meta.sessionId, privateResearch: record }, null));
      } catch (error) { if (error instanceof WorkbenchError) throw error; throw unavailable(); }
    } };
}

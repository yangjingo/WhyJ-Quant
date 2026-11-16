import { validateObservationCutoff } from "../market/observation-cutoff.ts";
import { normalizeSymbol } from "../market/symbols.ts";
import type { ThesisEvidence, ThesisMetric, ThesisReviewInput, ThesisReviewResult } from "../types/thesis-review.ts";

const invalid = (): never => { throw new Error("Invalid manual thesis review input."); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== keys.length || keys.some(key => !Object.hasOwn(entry, key))) return invalid();
  return entry;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) return invalid();
  return result;
}
function hash(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return invalid(); return value; }
function instant(value: unknown): string { const result = text(value, 24); validateObservationCutoff(result); return result; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) return invalid(); return value; }
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) return invalid(); return value as T;
}
function url(value: unknown): string {
  const result = text(value, 2048);
  let parsed: URL; try { parsed = new URL(result); } catch { return invalid(); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return invalid();
  return result;
}
function metric(value: unknown): ThesisMetric {
  const item = object(value, ["name", "value", "period", "unit", "definition", "adjustment"]);
  return { name: text(item.name, 160), value: item.value === null ? null : number(item.value), period: text(item.period, 160),
    unit: text(item.unit, 80), definition: text(item.definition), adjustment: choice(item.adjustment, ["none", "forward", "backward"]) };
}
function evidence(value: unknown): ThesisEvidence {
  const item = object(value, ["id", "symbol", "kind", "sourceUrl", "publishedAt", "retrievedAt", "origin", "dataRef", "metric"]);
  const ref = item.dataRef === null ? null : object(item.dataRef, ["id", "sha256"]);
  return { id: id(item.id), symbol: text(item.symbol, 20), kind: choice(item.kind, ["price", "fundamental"]), sourceUrl: url(item.sourceUrl),
    publishedAt: instant(item.publishedAt), retrievedAt: instant(item.retrievedAt), origin: choice(item.origin, ["source", "calculation", "interpretation"]),
    dataRef: ref ? { id: text(ref.id, 256), sha256: hash(ref.sha256) } : null, metric: metric(item.metric) };
}

/** Validate structure and copy it; unavailable evidence is a review state, not fabricated input. */
export function validateThesisReview(value: unknown): ThesisReviewInput {
  const item = object(value, ["version", "id", "groupId", "symbol", "cutoff", "baseline", "event", "evidence", "parameters", "decision"]);
  if (item.version !== 1 || typeof item.symbol !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(item.symbol)
    || normalizeSymbol(item.symbol, "A") !== item.symbol) return invalid();
  const base = object(item.baseline, ["artifactId", "revision", "asOf", "assumptionId", "statement", "metric", "threshold"]);
  const threshold = object(base.threshold, ["operator", "value"]);
  const event = object(item.event, ["id", "kind", "occurredAt", "sourceUrl", "summary"]);
  if (!Array.isArray(item.evidence) || item.evidence.length > 20) return invalid();
  const items = item.evidence.map(evidence);
  if (new Set(items.map(entry => entry.id)).size !== items.length) return invalid();
  if (!item.parameters || typeof item.parameters !== "object" || Array.isArray(item.parameters)) return invalid();
  const parameters: Record<string, string | number | boolean> = {};
  const entries = Object.entries(item.parameters);
  if (entries.length > 20) return invalid();
  for (const [key, value] of entries) {
    id(key); if (["__proto__", "constructor", "prototype"].includes(key)) return invalid();
    if (typeof value === "string") parameters[key] = text(value, 1000);
    else if (typeof value === "boolean") parameters[key] = value;
    else parameters[key] = number(value);
  }
  const decision = item.decision === null ? null : object(item.decision, ["action", "rationale", "decidedAt"]);
  return { version: 1, id: id(item.id), groupId: text(item.groupId, 160), symbol: item.symbol, cutoff: instant(item.cutoff),
    baseline: { artifactId: id(base.artifactId), revision: hash(base.revision), asOf: instant(base.asOf), assumptionId: id(base.assumptionId),
      statement: text(base.statement), metric: metric(base.metric), threshold: { operator: choice(threshold.operator, ["gt", "gte", "lt", "lte"]), value: number(threshold.value) } },
    event: { id: id(event.id), kind: choice(event.kind, ["price", "fundamental", "wording"]), occurredAt: instant(event.occurredAt), sourceUrl: url(event.sourceUrl), summary: text(event.summary) },
    evidence: items, parameters, decision: decision ? { action: choice(decision.action, ["maintain", "revise", "defer"]), rationale: text(decision.rationale), decidedAt: instant(decision.decidedAt) } : null };
}

/** Classify supplied records only. This does not authenticate sources or decide the user's thesis. */
export function compareThesisReview(value: unknown): ThesisReviewResult {
  const input = validateThesisReview(value), { baseline, event, cutoff, evidence } = input;
  const reasons: string[] = [];
  const result = (outcome: ThesisReviewResult["outcome"], comparison: ThesisReviewResult["comparison"] = null): ThesisReviewResult =>
    ({ input, outcome, reasons, evidenceIds: evidence.map(item => item.id), comparison });
  if (baseline.asOf > event.occurredAt || event.occurredAt > cutoff) reasons.push("event_outside_baseline_cutoff");
  if (input.decision && input.decision.decidedAt < event.occurredAt) reasons.push("decision_precedes_event");
  if (event.kind === "wording") {
    if (evidence.length) reasons.push("wording_event_contains_observations");
    if (reasons.length) return result("pending_verification");
    reasons.push("wording_does_not_change_evidence"); return result("no_material_change");
  }
  if (!evidence.length) reasons.push("missing_evidence");
  for (const item of evidence) {
    if (item.symbol !== input.symbol) reasons.push(`${item.id}:symbol_mismatch`);
    if (item.kind !== event.kind) reasons.push(`${item.id}:event_kind_mismatch`);
    if (!item.dataRef) reasons.push(`${item.id}:missing_retained_data`);
    if (item.origin === "interpretation") reasons.push(`${item.id}:interpretation_requires_source`);
    if (item.publishedAt > item.retrievedAt || item.retrievedAt > cutoff) reasons.push(`${item.id}:outside_cutoff`);
    if (item.retrievedAt < event.occurredAt || item.publishedAt < baseline.asOf) reasons.push(`${item.id}:stale_evidence`);
    if (item.metric.value === null) reasons.push(`${item.id}:missing_value`);
    if (event.kind === "fundamental") {
      for (const field of ["name", "period", "unit", "definition", "adjustment"] as const)
        if (item.metric[field] !== baseline.metric[field]) reasons.push(`${item.id}:incomparable_${field}`);
    }
  }
  if (event.kind === "fundamental" && baseline.metric.value === null) reasons.push("missing_baseline_value");
  if (reasons.length) return result("pending_verification");
  if (event.kind === "price") { reasons.push("price_does_not_invalidate_fundamental_assumption"); return result("price_observation"); }
  const values = new Set(evidence.map(item => item.metric.value!));
  if (values.size !== 1) { reasons.push("conflicting_observations"); return result("pending_verification"); }
  const before = baseline.metric.value!, after = evidence[0]!.metric.value!, { operator, value: threshold } = baseline.threshold;
  const holds = (value: number) => operator === "gt" ? value > threshold : operator === "gte" ? value >= threshold : operator === "lt" ? value < threshold : value <= threshold;
  reasons.push(before === after ? "unchanged_observation" : "assumption_has_new_comparable_evidence");
  return result(before === after ? "no_material_change" : "assumption_review", { before, after, heldBefore: holds(before), holdsAfter: holds(after) });
}

import { expect, test } from "bun:test";
import { compareThesisReview, validateThesisReview } from "../thesis-review.ts";
import type { ThesisReviewInput } from "../../types/thesis-review.ts";

function fixture(): ThesisReviewInput {
  return { version: 1, id: "review-1", groupId: "group-1", symbol: "600000.SH", cutoff: "2026-11-15T12:00:00.000Z",
    baseline: { artifactId: "report-1", revision: "a".repeat(64), asOf: "2026-11-01T00:00:00.000Z", assumptionId: "margin",
      statement: "Reported margin remains at least 20 percent.",
      metric: { name: "margin", value: 22, period: "2026-Q3", unit: "percent", definition: "consolidated gross margin", adjustment: "none" },
      threshold: { operator: "gte", value: 20 } },
    event: { id: "correction", kind: "fundamental", occurredAt: "2026-11-15T09:00:00.000Z", sourceUrl: "https://example.com/correction", summary: "Synthetic corrected disclosure for the same reporting period." },
    evidence: [{ id: "disclosure", symbol: "600000.SH", kind: "fundamental", sourceUrl: "https://example.com/disclosure", publishedAt: "2026-11-15T09:00:00.000Z", retrievedAt: "2026-11-15T10:00:00.000Z", origin: "source",
      dataRef: { id: "retained-disclosure", sha256: "b".repeat(64) },
      metric: { name: "margin", value: 18, period: "2026-Q3", unit: "percent", definition: "consolidated gross margin", adjustment: "none" } }],
    parameters: { synthetic: true, extraction: "disclosed table" }, decision: null };
}
const edit = (change: (value: any) => void): ThesisReviewInput => { const input = fixture(); change(input); return input; };

test("new comparable facts expose the threshold crossing but never invent a user decision", () => {
  const input = fixture(), before = structuredClone(input), result = compareThesisReview(input);
  expect(result.outcome).toBe("assumption_review");
  expect(result.comparison).toEqual({ before: 22, after: 18, heldBefore: true, holdsAfter: false });
  expect(result.input.decision).toBeNull(); expect(result.evidenceIds).toEqual(["disclosure"]);
  expect(result.input.evidence[0]?.sourceUrl).toBe(input.evidence[0]?.sourceUrl);
  expect(input).toEqual(before); expect(result.input).not.toBe(input);
  expect(result.input.evidence).not.toBe(input.evidence);
});
test("price moves do not imply a broken fundamental assumption", () => {
  const result = compareThesisReview(edit(value => {
    value.event.kind = "price"; value.evidence[0].kind = "price";
    value.evidence[0].metric = { name: "close", value: 8.2, period: "2026-11-15", unit: "CNY", definition: "daily close", adjustment: "forward" };
  }));
  expect(result.outcome).toBe("price_observation"); expect(result.comparison).toBeNull(); expect(result.input.decision).toBeNull();
});
test("wording-only changes and unchanged observations do not manufacture drift", () => {
  const wording = compareThesisReview(edit(value => { value.event.kind = "wording"; value.evidence = []; }));
  expect(wording.outcome).toBe("no_material_change"); expect(wording.comparison).toBeNull();
  expect(compareThesisReview(edit(value => { value.evidence[0].metric.value = 22; })).outcome).toBe("no_material_change");
  expect(compareThesisReview(edit(value => { value.event.kind = "wording"; })).outcome).toBe("pending_verification");
});
test("new values need review even when both values meet the threshold", () => {
  const result = compareThesisReview(edit(value => { value.evidence[0].metric.value = 21; }));
  expect(result.outcome).toBe("assumption_review"); expect(result.comparison?.holdsAfter).toBe(true);
});
for (const field of ["period", "unit", "definition", "adjustment", "name"] as const) test(`different ${field} cannot be compared`, () => {
  const result = compareThesisReview(edit(value => { value.evidence[0].metric[field] = field === "adjustment" ? "forward" : "different"; }));
  expect(result.outcome).toBe("pending_verification"); expect(result.comparison).toBeNull(); expect(result.reasons).toContain(`disclosure:incomparable_${field}`);
});
for (const [name, change] of [
  ["missing evidence", (value: any) => { value.evidence = []; }],
  ["wrong instrument", (value: any) => { value.evidence[0].symbol = "000001.SZ"; }],
  ["missing retained version", (value: any) => { value.evidence[0].dataRef = null; }],
  ["missing value", (value: any) => { value.evidence[0].metric.value = null; }],
  ["missing baseline value", (value: any) => { value.baseline.metric.value = null; }],
  ["stale disclosure", (value: any) => { value.evidence[0].publishedAt = "2026-10-01T00:00:00.000Z"; }],
  ["stale retrieval", (value: any) => { value.evidence[0].retrievedAt = "2026-11-14T00:00:00.000Z"; }],
  ["future evidence", (value: any) => { value.evidence[0].retrievedAt = "2026-11-16T00:00:00.000Z"; }],
  ["future event", (value: any) => { value.event.occurredAt = "2026-11-16T00:00:00.000Z"; }],
  ["pre-baseline event", (value: any) => { value.event.occurredAt = "2026-10-01T00:00:00.000Z"; }],
  ["interpretation only", (value: any) => { value.evidence[0].origin = "interpretation"; }],
  ["mismatched evidence", (value: any) => { value.evidence[0].kind = "price"; }],
  ["conflicting values", (value: any) => { value.evidence.push({ ...value.evidence[0], id: "second", metric: { ...value.evidence[0].metric, value: 30 } }); }],
] as const) test(`${name} remains pending with actionable reasons`, () => {
  const result = compareThesisReview(edit(change)); expect(result.outcome).toBe("pending_verification"); expect(result.reasons.length).toBeGreaterThan(0); expect(result.comparison).toBeNull();
});
for (const [operator, holds] of [["gte", true], ["gt", false], ["lte", true], ["lt", false]] as const) test(`${operator} handles equality without rounding across a threshold`, () => {
  const result = compareThesisReview(edit(value => { value.baseline.threshold.operator = operator; value.evidence[0].metric.value = 20; }));
  expect(result.comparison?.holdsAfter).toBe(holds);
});
test("maintain, revise and defer remain explicit decisions even when evidence is unavailable", () => {
  for (const action of ["maintain", "revise", "defer"] as const) {
    const decision = { action, rationale: "Human decision recorded separately", decidedAt: "2026-11-15T13:00:00.000Z" };
    const result = compareThesisReview(edit(value => { value.evidence = []; value.decision = decision; }));
    expect(result.outcome).toBe("pending_verification"); expect(result.input.decision).toEqual(decision);
  }
});
test("invalid or unbounded input cannot create a baseline or broaden scope", () => {
  for (const change of [
    (value: any) => { delete value.baseline; }, (value: any) => { value.version = 2; },
    (value: any) => { value.symbol = "AAPL"; }, (value: any) => { value.symbol = "600000"; },
    (value: any) => { value.baseline.revision = "latest"; }, (value: any) => { value.evidence.push(value.evidence[0]); },
    (value: any) => { value.evidence = Array(21).fill(value.evidence[0]); }, (value: any) => { value.event.sourceUrl = "javascript:alert(1)"; },
    (value: any) => { value.event.sourceUrl = "https://user:secret@example.com/"; }, (value: any) => { value.evidence[0].metric.value = NaN; },
    (value: any) => { value.cutoff = "2026-02-30T00:00:00.000Z"; }, (value: any) => { value.decision = { action: "maintain" }; },
    (value: any) => { value.parameters = { secret: { nested: true } }; }, (value: any) => { value.extra = "unsupported"; },
  ]) expect(() => validateThesisReview(edit(change))).toThrow();
});

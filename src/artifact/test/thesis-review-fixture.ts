import type { ThesisReviewInput } from "../../types/thesis-review.ts";
import type { ThesisPriceContext } from "../src/thesis-review.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export function thesisFixture(): Mutable<ThesisReviewInput> {
  return { version: 1, id: "review-1", groupId: "synthetic-group", symbol: "600000.SH", cutoff: "2026-11-15T12:00:00.000Z",
    baseline: { artifactId: "report-1", revision: "a".repeat(64), asOf: "2026-11-01T00:00:00.000Z", assumptionId: "margin",
      statement: "合成假设：同口径毛利率保持至少 20%。",
      metric: { name: "margin", value: 22, period: "2026-Q3", unit: "percent", definition: "consolidated gross margin", adjustment: "none" },
      threshold: { operator: "gte", value: 20 } },
    event: { id: "correction", kind: "fundamental", occurredAt: "2026-11-13T09:00:00.000Z", sourceUrl: "https://example.com/correction", summary: "合成示例：同一报告期的披露数值更正，不是真实证券事件。" },
    evidence: [{ id: "disclosure", symbol: "600000.SH", kind: "fundamental", sourceUrl: "https://example.com/disclosure", publishedAt: "2026-11-13T09:00:00.000Z", retrievedAt: "2026-11-13T10:00:00.000Z", origin: "source",
      dataRef: { id: "retained-disclosure", sha256: "b".repeat(64) },
      metric: { name: "margin", value: 18, period: "2026-Q3", unit: "percent", definition: "consolidated gross margin", adjustment: "none" } }],
    parameters: { synthetic: true, extraction: "disclosed table" }, decision: null };
}
export function thesisPriceFixture(): ThesisPriceContext {
  return { symbol: "600000.SH", sourceUrl: "https://example.com/fixed-bars", retrievedAt: "2026-11-13T10:00:00.000Z",
    adjustment: "forward", currency: "CNY", volumeUnit: "shares", dataRef: { id: "synthetic-bars", sha256: "c".repeat(64) },
    rows: [{ date: "2026-11-12", open: 20, high: 22, low: 19, close: 21, vol: 0 }, { date: "2026-11-13", open: 21, high: 23, low: 20, close: 22, vol: 1000 }] };
}

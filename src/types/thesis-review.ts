/** First manual slice: one A-share group, one numerical assumption, one event. */
export interface ThesisMetric {
  readonly name: string;
  readonly value: number | null;
  readonly period: string;
  readonly unit: string;
  readonly definition: string;
  readonly adjustment: "none" | "forward" | "backward";
}
export interface ThesisEvidence {
  readonly id: string;
  readonly symbol: string;
  readonly kind: "price" | "fundamental";
  readonly sourceUrl: string;
  readonly publishedAt: string;
  readonly retrievedAt: string;
  readonly origin: "source" | "calculation" | "interpretation";
  /** Version or retained snapshot identity; a URL alone does not pin evidence. */
  readonly dataRef: { readonly id: string; readonly sha256: string } | null;
  readonly metric: ThesisMetric;
}
export interface ThesisReviewInput {
  readonly version: 1;
  readonly id: string;
  readonly groupId: string;
  readonly symbol: string;
  readonly cutoff: string;
  readonly baseline: {
    readonly artifactId: string;
    readonly revision: string;
    readonly asOf: string;
    readonly assumptionId: string;
    readonly statement: string;
    readonly metric: ThesisMetric;
    /** A declared condition for the assumption; crossing it requests review, never a trade. */
    readonly threshold: { readonly operator: "gt" | "gte" | "lt" | "lte"; readonly value: number };
  };
  readonly event: { readonly id: string; readonly kind: "price" | "fundamental" | "wording"; readonly occurredAt: string; readonly sourceUrl: string; readonly summary: string };
  readonly evidence: readonly ThesisEvidence[];
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly decision: { readonly action: "maintain" | "revise" | "defer"; readonly rationale: string; readonly decidedAt: string } | null;
}
export interface ThesisReviewResult {
  readonly input: ThesisReviewInput;
  readonly outcome: "price_observation" | "assumption_review" | "pending_verification" | "no_material_change";
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly comparison: { readonly before: number; readonly after: number; readonly heldBefore: boolean; readonly holdsAfter: boolean } | null;
}

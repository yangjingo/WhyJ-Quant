import type { ThesisReviewInput } from "./thesis-review.ts";
import type { TspObservations } from "./thesis-tsp.ts";
import type { DisclosureDocument } from "./disclosure.ts";
import type { ThesisPriceCheck } from "./thesis-price-check.ts";

/** Private fixed inputs; never include these in generic Artifact metadata listings. */
export interface ThesisArchiveOwner {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly recordedAt: string;
}
export interface ThesisBaselineArchive extends ThesisArchiveOwner {
  readonly kind: "baseline";
  readonly source: { readonly artifactId: string; readonly revision: string };
  readonly groupId: string;
  readonly symbol: string;
  /** Explicitly established at recordedAt, not inferred from historical prose. */
  readonly assumption: Omit<ThesisReviewInput["baseline"], "artifactId" | "revision">;
}
export interface ThesisRetainedEvidence {
  readonly id: string;
  readonly mediaType: "text/plain" | "application/json";
  readonly content: string;
}
export interface ThesisPriceContext {
  readonly symbol: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly adjustment: "none" | "forward" | "backward";
  readonly currency: "CNY";
  readonly volumeUnit: "shares" | "lots";
  readonly dataRef: { readonly id: string; readonly sha256: string };
  readonly rows: readonly { readonly date: string; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly vol: number }[];
}
export interface ThesisReviewArchive extends ThesisArchiveOwner {
  readonly kind: "review";
  readonly input: ThesisReviewInput;
  readonly retainedEvidence: readonly ThesisRetainedEvidence[];
  readonly price: ThesisPriceContext | null;
  readonly tsp?: ThesisTspSelection;
  readonly checks?: ThesisSourceSelection;
}
export interface ThesisTspSelection {
  readonly artifactId: string;
  readonly revision: string;
  readonly alertIndex: number | null;
  readonly price: { readonly start: string; readonly end: string; readonly volumeUnit: "shares" | "lots" } | null;
}
export interface ThesisTspArchive extends ThesisArchiveOwner {
  readonly kind: "tsp-observation";
  readonly baseline: { readonly artifactId: string; readonly revision: string };
  readonly batch: TspObservations;
}
export interface ThesisSourceSelection {
  readonly artifactId: string;
  readonly revision: string;
  readonly disclosure: null | {
    readonly page: number;
    readonly quote: string;
    readonly publishedAt: string;
    readonly metric: ThesisReviewInput["baseline"]["metric"];
    /** Explicit user attestation of issuer, publication time, quote and metric meaning; not automatic fact authentication. */
    readonly confirmed: boolean;
  };
}
export interface ThesisSourceArchive extends ThesisArchiveOwner {
  readonly kind: "source-check";
  readonly baseline: { readonly artifactId: string; readonly revision: string };
  readonly disclosureUrl: string | null;
  readonly price: ThesisPriceCheck;
  readonly disclosure: DisclosureDocument | null;
}
export type ThesisArchive = ThesisBaselineArchive | ThesisReviewArchive | ThesisTspArchive | ThesisSourceArchive;

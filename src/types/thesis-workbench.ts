import type { ArtifactRequest, ArtifactSummary } from "./workbench.ts";
import type { ThesisBaselineArchive, ThesisPriceContext, ThesisRetainedEvidence, ThesisTspSelection, ThesisSourceSelection } from "./thesis-archive.ts";
import type { ThesisPriceCheck, ThesisPriceComparison } from "./thesis-price-check.ts";
import type { DisclosureDocument } from "./disclosure.ts";
import type { ThesisReviewInput, ThesisReviewResult } from "./thesis-review.ts";
import type { TspObservation, TspObservations } from "./thesis-tsp.ts";

export interface ThesisTspRequest extends ArtifactRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface ThesisSourcesRequest extends ThesisTspRequest {
  readonly start: string;
  readonly end: string;
  readonly disclosureUrl: string | null;
}
export interface ThesisSourcesReadRequest extends ArtifactRequest { readonly page?: number }
export interface ThesisSourcesView {
  readonly artifact: ArtifactSummary;
  readonly baseline: ArtifactRequest;
  readonly recordedAt: string;
  readonly disclosureUrl: string | null;
  readonly price: Extract<ThesisPriceCheck, { status: "unavailable" }>
    | (Omit<Extract<ThesisPriceCheck, { status: "available" }>, "bars"> & { readonly barCount: number });
  readonly disclosure: (Omit<DisclosureDocument, "pages"> & { readonly pages: readonly { readonly page: number; readonly characters: number }[] }) | null;
  readonly page: { readonly page: number; readonly text: string; readonly truncated: boolean } | null;
}
export interface ThesisTspView {
  readonly artifact: ArtifactSummary;
  readonly baseline: ArtifactRequest;
  readonly recordedAt: string;
  readonly symbol: string;
  readonly configuredScopes: TspObservations["configuredScopes"];
  readonly observations: readonly (Omit<TspObservation, "content"> & { readonly bytes: number })[];
  readonly alerts: readonly { readonly index: number; readonly event: ThesisReviewInput["event"]; readonly price: number | null }[];
  readonly omittedAlerts: number;
  readonly alertsReason: string | null;
  readonly daily: { readonly count: number; readonly start: string; readonly end: string } | null;
  readonly dailyReason: string | null;
}

export interface ThesisBaselineRequest extends ArtifactRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly groupId: string;
  readonly symbol: string;
  readonly assumption: Omit<ThesisBaselineArchive["assumption"], "asOf">;
}
export interface ThesisReviewRequest extends ArtifactRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly cutoff: string;
  readonly event: ThesisReviewInput["event"];
  readonly evidence: ThesisReviewInput["evidence"];
  readonly parameters: ThesisReviewInput["parameters"];
  readonly decision: ThesisReviewInput["decision"];
  readonly retainedEvidence: readonly ThesisRetainedEvidence[];
  readonly price: ThesisPriceContext | null;
  readonly tsp?: ThesisTspSelection;
  readonly checks?: ThesisSourceSelection;
}
export type ThesisView = { readonly artifact: ArtifactSummary; readonly recordedAt: string; readonly source: ArtifactRequest } & (
  { readonly kind: "baseline"; readonly groupId: string; readonly symbol: string; readonly assumption: ThesisBaselineArchive["assumption"] }
  | { readonly kind: "review"; readonly result: ThesisReviewResult; readonly price: ThesisPriceContext | null;
      readonly tsp?: ThesisTspView & { readonly selection: ThesisTspSelection };
      readonly checks?: { readonly view: ThesisSourcesView; readonly selection: ThesisSourceSelection; readonly priceComparison: ThesisPriceComparison | null };
      readonly retainedEvidence: readonly { readonly id: string; readonly mediaType: string; readonly sha256: string; readonly bytes: number }[] }
);

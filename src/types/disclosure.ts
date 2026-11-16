/** Retained text extraction, not an authenticated issuer statement or original binary download. */
export interface DisclosureDocument {
  readonly symbol: string;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly fetchedAt: string;
  readonly status: "available" | "truncated" | "unsupported" | "restricted" | "unavailable" | "empty";
  readonly method: "unpdf-1.9.1-page-text";
  readonly originalSha256: string | null;
  readonly originalBytes: number;
  readonly textSha256: string | null;
  readonly totalPages: number;
  readonly pages: readonly { readonly page: number; readonly text: string }[];
  readonly symbolMention: "header-match" | "unverified";
  readonly reason: string;
}

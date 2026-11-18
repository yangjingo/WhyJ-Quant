/** Stable failure categories for the additive selected Source contracts. */
export type SourceErrorCode = "unsupported" | "incompatible-basis" | "timeout" | "provider-failure";

export class SourceRequestError extends Error {
  constructor(readonly code: SourceErrorCode, message: string) {
    super(message);
    this.name = "SourceRequestError";
  }
}

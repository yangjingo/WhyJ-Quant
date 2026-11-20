import type { ThesisBaselineRequest, ThesisReviewRequest, ThesisView, ThesisTspRequest, ThesisTspView, ThesisSourcesRequest, ThesisSourcesReadRequest, ThesisSourcesView } from "./thesis-workbench.ts";
import type {
  HistoricalMinuteArchiveRef, ObservationArchiveRef, StoredHistoricalMinuteBar, StoredHistoricalMinuteBatch,
  StoredTradingDateBarObservation, TradingDateArchiveRef, TradingLimitArchiveRef,
} from "./observation.ts";
/**
 * The workbench's view of the Host.
 *
 * This file is the only place the UI learns how work is submitted, cancelled
 * and observed. Based on PR #81's interface slice, extended with scoped events,
 * session snapshots and presentation capabilities. It is a UI port, not a
 * finalized public protocol. #101 adds the initial local HTTP/SSE adapter;
 * #46/#75 retain the broader service extraction and Host lifecycle work.
 *
 * Two rules are encoded here rather than in prose:
 *
 * 1. Observations are subscriptions. `subscribe` returns a release function
 *    that only detaches the listener; it never cancels the run. Cancelling is
 *    a separate, explicit command.
 * 2. A run is identified by workspace, session and run, not by a component
 *    instance. Switching sessions detaches; it does not end work.
 *    Terminal state/turn events retain the runId of the run they finish;
 *    null means no associated run, never "finish whichever run is active".
 */

export type RunState = "idle" | "running" | "needs_input" | "settled" | "failed" | "cancelled" | "interrupted";

export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string | null;
}

export interface RunIdentity extends WorkspaceIdentity { readonly runId: string }

export interface WorkspaceSummary {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly code: string;
  readonly name: string;
  readonly runCount: number;
  readonly state: RunState;
}

export type TurnRole = "user" | "assistant";
export type AgentPhase = "waiting" | "thinking" | "preparing" | "tool" | "answering";

export interface Turn {
  readonly id: string;
  readonly role: TurnRole;
  readonly text: string;
  /** Optional provider-returned, non-redacted thinking text; distinct from the answer. */
  readonly thinking?: string;
  readonly state: RunState;
  readonly at: string;
  readonly activity?: readonly ToolActivity[];
  /** Public execution metadata only; never reasoning text. */
  readonly phase?: AgentPhase;
  readonly endedAt?: string;
  /** Accepted user action and its prior run; retained when later runs start. */
  readonly operation?: "submit" | "continue" | "followup" | "review";
  readonly previousRunId?: string;
}

export interface ToolActivity {
  /** Redacted model-visible tool text, not independently verified evidence. */
  readonly result?: { readonly text: string; readonly truncated: boolean; readonly omittedBlocks: number; readonly capturedAt: string };
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly context?: string;
  readonly state: "preparing" | "running" | "completed" | "failed" | "cancelled" | "not-run" | "unconfirmed";
  readonly elapsedMs?: number;
}

export interface MarketQuote {
  readonly basis?: "snapshot" | "daily";
  readonly asOfTime?: string;
  readonly group?: "watchlist" | "market";
  readonly code: string;
  readonly name: string;
  readonly value: number | null;
  readonly change: number | null;
  readonly asOfDate?: string | null;
  readonly provider?: string;
  readonly freshness?: "available" | "outside-window" | "unavailable" | "refreshing" | "stale";
}

export interface SourceStatus {
  readonly provider: string | null;
  readonly updatedAt: string | null;
  readonly available: number;
  readonly total: number;
}

export interface MarketSnapshot {
  readonly pollIntervalMs?: number;
  readonly colorScheme?: "red-up" | "green-up";
  readonly status?: "idle" | "fetching" | "success" | "partial" | "unavailable" | "timeout" | "error";
  readonly retryable?: boolean;
  readonly refreshedAt: string;
  readonly quotes: readonly MarketQuote[];
  readonly source: SourceStatus;
}

/** A conclusion is only settled when a run finished; drafts stay drafts. */
export interface Conclusion {
  readonly statement: string | null;
  readonly confidence: "low" | "medium" | "high" | null;
  /** What would break the reading. Empty means the author did not state it. */
  readonly boundary: string | null;
  readonly settled: boolean;
}

/** Evidence is a pointer to a source, not a restatement of its numbers. */
export interface EvidenceItem {
  readonly id: string;
  readonly label: string;
  readonly source: string | null;
  readonly asOf: string | null;
  readonly available: boolean;
}

/** Artifacts are immutable saved reports, referenced by hash. */
export interface ArtifactSummary {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly runId?: string;
  readonly kind?: "thesis-baseline" | "thesis-review" | "tsp-observation" | "source-check";
}

export interface WorkspaceOutput {
  readonly conclusion: Conclusion;
  readonly evidence: readonly EvidenceItem[];
  readonly artifacts: readonly ArtifactSummary[];
}

export interface SubmitRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Retry identity within the current Host instance; reconnect never resubmits automatically. */
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly text: string;
}

export interface SubmitResult {
  readonly sessionId: string;
  readonly runId: string;
}

export interface FollowupRequest extends SubmitRequest { readonly previousRunId: string }
export type ContinueRequest = Omit<FollowupRequest, "text">;

export interface SaveRequest extends RunIdentity {
  readonly expectedRevision: number;
  readonly expectedArtifactRevision: string | null;
}
export interface ArtifactRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly sha256: string;
}
/** Private original HTML, verified against a fixed stored snapshot; never a public-share projection. */
export interface OriginalReport {
  readonly artifact: ArtifactSummary;
  readonly html: string;
  readonly htmlSha256: string;
  readonly bytes: number;
}
export interface ReviewRequest extends ArtifactRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly text: string;
}
export interface DeleteSessionRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedRevision: number;
}
export interface RenameSessionRequest extends DeleteSessionRequest { readonly title: string }
export interface RunRevisionRequest extends RunIdentity { readonly expectedRevision: number }
/** Read-only saved research; opening it does not start or resume a run. */
export interface SavedResearch {
  readonly identity: RunIdentity;
  readonly artifact: ArtifactSummary;
  readonly turns: readonly Turn[];
  readonly evidence: readonly EvidenceItem[];
}

/**
 * Events are coarse on purpose: the Host decides how much detail to stream,
 * and the UI must not assume it receives provider-level deltas.
 */
export type WorkbenchEvent =
  | { readonly type: "connection"; readonly connected: boolean; readonly error?: string }
  | { readonly type: "session-error"; readonly identity: WorkspaceIdentity; readonly message: string }
  | { readonly type: "snapshot"; readonly identity: WorkspaceIdentity; readonly snapshot: SessionSnapshot }
  | { readonly type: "turn"; readonly identity: WorkspaceIdentity; readonly turn: Turn }
  | { readonly type: "state"; readonly identity: WorkspaceIdentity; readonly state: RunState }
  | { readonly type: "market"; readonly identity: WorkspaceIdentity; readonly snapshot: MarketSnapshot };

export interface SessionSnapshot {
  /** Monotonic within one stored conversation; full snapshots resynchronize missed events. */
  readonly revision?: number;
  readonly identity: WorkspaceIdentity;
  readonly state: RunState;
  readonly turns: readonly Turn[];
  readonly market: MarketSnapshot;
  readonly output: WorkspaceOutput;
  readonly recovery?: { readonly runId: string; readonly unconfirmedTools: number; readonly acknowledgementRequired: boolean };
  readonly source?: ArtifactRequest & { readonly runId: string };
}

export interface ReferenceCandidate {
  readonly id: string;
  readonly label: string;
  readonly token: string;
  readonly kind: "file" | "directory" | "session" | "evidence";
  readonly description: string;
}

export interface Preferences {
  /** Research-tool routing is separate from the overview feed below. No credential values. */
  readonly researchSource?: "akshare" | "tushare" | "tickflow" | "llmquant-data" | "financial-datasets";
  readonly researchSources?: readonly { id: NonNullable<Preferences["researchSource"]>; label: string; credentialConfigured: boolean; requiresCredential: boolean }[];
  /** Opaque storage revision for concurrent setting edits; never a credential. */
  readonly revision?: string;
  readonly modelProvider?: string;
  readonly modelProtocol?: string;
  readonly thinkingLevel?: string;
  readonly availableThinkingLevels?: readonly string[];
  readonly modelCredentialsConfigured?: boolean;
  readonly availablePortfolios?: readonly string[];
  readonly model: string;
  readonly source: "none" | "demo" | "akshare";
  readonly portfolio: string;
}

export type Release = () => void;

/** Host draft views never include stored or submitted credentials or endpoint text. */
export interface DataDraftView {
  id: string; version: number;
  sample: import("./data-readiness.ts").DataProbeRequest;
  credential: string; endpointConfigured: boolean; checking: boolean; cancelled: boolean; canSave: boolean;
  result: Pick<import("./data-readiness.ts").DataReadiness, "status" | "rowCount" | "asOfDate" | "observedAt" | "capability"> | null;
}
export interface DataDraftEdit {
  id: string; market?: import("./data-readiness.ts").DataMarket; source?: import("./config.ts").DataSource;
  symbol?: string; start?: string; end?: string; key?: string | null; endpoint?: string | null;
}
export interface DataDraftSave { id: string; version: number }
export interface RemoveDataCredential { source: import("./config.ts").DataSource; revision: string }

export type ModelDraftStatus = "ready" | "missing-credential" | "auth-failed" | "permission-denied" | "timeout" | "cancelled"
  | "invalid-config" | "unsupported" | "empty-response" | "unavailable";
export interface ModelDraftView {
  id: string; version: number; provider: string; model: string; protocol: string | null; thinkingLevel: string;
  providers: { id: string; name: string; canApiKey: boolean }[];
  models: { id: string; name: string; api: string; reasoning: boolean }[];
  protocols: string[]; thinkingLevels: string[];
  keyConfigured: boolean; oauthSelected: boolean; endpointConfigured: boolean;
  cloudflare?: { accountConfigured: boolean; gatewayConfigured: boolean };
  checking: boolean; canSave: boolean; status: ModelDraftStatus | null;
}
export interface ModelDraftEdit {
  id: string; provider?: string; model?: string; protocol?: import("./config.ts").ModelProtocol | null;
  endpoint?: string | null; key?: string | null; thinkingLevel?: string;
  cloudflareAccountId?: string | null; cloudflareGatewayId?: string | null;
}
export interface ModelDraftSave { id: string; version: number }
export interface RemoveModelCredential { provider: string; revision: string }

export interface WorkbenchClient {
  readonly mode: "demo" | "host" | "disconnected";
  session(sessionId: string): Promise<SessionSnapshot>;
  createSession(): Promise<WorkspaceSummary>;
  renameSession(request: RenameSessionRequest): Promise<void>;
  references(sessionId: string, query: string): Promise<readonly ReferenceCandidate[]>;
  preferences(): Promise<Preferences>;
  updatePreferences(preferences: Preferences): Promise<void>;
  startDataDraft?(): Promise<DataDraftView>;
  editDataDraft?(input: DataDraftEdit): Promise<DataDraftView>;
  verifyDataDraft?(id: string): Promise<DataDraftView>;
  cancelDataDraft?(id: string): Promise<DataDraftView>;
  saveDataDraft?(input: DataDraftSave): Promise<void>;
  closeDataDraft?(id: string): Promise<void>;
  removeDataCredential?(input: RemoveDataCredential): Promise<{ removed: boolean }>;
  startObservationJob?(input: ObservationJobRequest): Promise<ObservationJobView>;
  readObservationJob?(id: string): Promise<ObservationJobView>;
  cancelObservationJob?(id: string): Promise<ObservationJobView>;
  readObservationIndicators?(ref: TradingDateArchiveRef): Promise<ObservationIndicatorPreview>;
  readObservationExchangeIndicators?(input: ObservationExchangePreviewRequest): Promise<ObservationIndicatorPreview>;
  readObservationIntraday?(input: ObservationIntradayRequest): Promise<ObservationIntradayPreview>;
  readObservationAnalytics?(ref: TradingDateArchiveRef): Promise<ObservationAnalyticsPreview>;
  startModelDraft?(): Promise<ModelDraftView>;
  editModelDraft?(input: ModelDraftEdit): Promise<ModelDraftView>;
  verifyModelDraft?(id: string): Promise<ModelDraftView>;
  cancelModelDraft?(id: string): Promise<ModelDraftView>;
  saveModelDraft?(input: ModelDraftSave): Promise<void>;
  closeModelDraft?(id: string): Promise<void>;
  removeModelCredential?(input: RemoveModelCredential): Promise<{ removed: boolean }>;
  identity(): Promise<WorkspaceIdentity>;
  workspaces(): Promise<readonly WorkspaceSummary[]>;
  transcript(sessionId: string): Promise<readonly Turn[]>;
  market(): Promise<MarketSnapshot>;
  refreshMarket?(failedOnly: boolean): Promise<MarketSnapshot>;
  output(sessionId: string): Promise<WorkspaceOutput>;
  submit(request: SubmitRequest): Promise<SubmitResult>;
  continue?(request: ContinueRequest): Promise<SubmitResult>;
  followup?(request: FollowupRequest): Promise<SubmitResult>;
  save?(request: SaveRequest): Promise<ArtifactSummary>;
  reload?(request: ArtifactRequest): Promise<SavedResearch>;
  readReport?(request: ArtifactRequest): Promise<OriginalReport>;
establishThesis?(request: ThesisBaselineRequest): Promise<ArtifactSummary>;
  saveThesisReview?(request: ThesisReviewRequest): Promise<ArtifactSummary>;
  readThesis?(request: ArtifactRequest): Promise<ThesisView>;
  collectThesisTsp?(request: ThesisTspRequest): Promise<ThesisTspView>;
  readThesisTsp?(request: ArtifactRequest): Promise<ThesisTspView>;
  collectThesisSources?(request: ThesisSourcesRequest): Promise<ThesisSourcesView>;
  readThesisSources?(request: ThesisSourcesReadRequest): Promise<ThesisSourcesView>;
  review?(request: ReviewRequest): Promise<SubmitResult>;
  deleteSession?(request: DeleteSessionRequest): Promise<void>;
  /** Explicit user intent. Releasing a subscription must never do this. */
  cancel(identity: RunIdentity): Promise<void>;
  /** Acknowledges uncertain prior effects only; never resumes or replays work. */
  acknowledgeInterruption?(request: RunRevisionRequest): Promise<void>;
  subscribe(listener: (event: WorkbenchEvent) => void): Release;
}

export function isMarketSnapshot(value: unknown): value is MarketSnapshot {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const nullable = (v: unknown) => v === null || typeof v === "string";
  return object(value) && typeof value.refreshedAt === "string" && Array.isArray(value.quotes) && object(value.source)
    && nullable(value.source.provider) && nullable(value.source.updatedAt)
    && [value.source.available, value.source.total].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    && (value.status === undefined || ["idle", "fetching", "success", "partial", "unavailable", "timeout", "error"].includes(String(value.status)))
    && (value.retryable === undefined || typeof value.retryable === "boolean")
    && (value.pollIntervalMs === undefined || typeof value.pollIntervalMs === "number" && Number.isSafeInteger(value.pollIntervalMs) && value.pollIntervalMs >= 0 && value.pollIntervalMs <= 2147483647)
    && (value.colorScheme === undefined || value.colorScheme === "red-up" || value.colorScheme === "green-up")
    && value.quotes.every(q => object(q) && typeof q.code === "string" && typeof q.name === "string"
      && (q.basis === undefined || q.basis === "snapshot" || q.basis === "daily") && (q.asOfTime === undefined || typeof q.asOfTime === "string")
      && [q.value, q.change].every(v => v === null || typeof v === "number" && Number.isFinite(v))
      && (q.asOfDate === undefined || nullable(q.asOfDate)) && (q.provider === undefined || typeof q.provider === "string")
      && (q.group === undefined || q.group === "market" || q.group === "watchlist")
      && (q.freshness === undefined || ["available", "outside-window", "unavailable", "refreshing", "stale"].includes(String(q.freshness))));
}

/** Validate network snapshots before any view state is replaced. No IO or private runtime types. */
export function isWorkbenchSnapshot(value: unknown): value is SessionSnapshot {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const string = (item: unknown): item is string => typeof item === "string";
  const nullable = (item: unknown) => item === null || string(item);
  const states = ["idle", "running", "needs_input", "settled", "failed", "cancelled", "interrupted"];
  if (!object(value) || !object(value.identity) || !string(value.identity.workspaceId) || !string(value.identity.sessionId) || !nullable(value.identity.runId)
    || !states.includes(String(value.state)) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false;
  if (!Array.isArray(value.turns) || !value.turns.every(turn => object(turn) && string(turn.id) && ["user", "assistant"].includes(String(turn.role))
    && string(turn.text) && (turn.thinking === undefined || string(turn.thinking)) && string(turn.at) && states.includes(String(turn.state))
    && (turn.operation === undefined || ["submit", "continue", "followup", "review"].includes(String(turn.operation)))
    && (turn.previousRunId === undefined || string(turn.previousRunId) && turn.previousRunId.length > 0 && turn.previousRunId.length <= 160)
    && (turn.phase === undefined || ["waiting", "thinking", "preparing", "tool", "answering"].includes(String(turn.phase)))
    && (turn.endedAt === undefined || string(turn.endedAt) && Number.isFinite(Date.parse(turn.endedAt))) && (turn.activity === undefined || (Array.isArray(turn.activity)
      && turn.activity.every(item => object(item) && string(item.id) && string(item.name)
        && (item.result === undefined || object(item.result) && string(item.result.text) && item.result.text.length <= 16_000
          && typeof item.result.truncated === "boolean" && Number.isSafeInteger(item.result.omittedBlocks) && Number(item.result.omittedBlocks) >= 0
          && string(item.result.capturedAt) && Number.isFinite(Date.parse(item.result.capturedAt)))
        && (item.title === undefined || string(item.title) && item.title.length <= 100) && (item.context === undefined || string(item.context) && item.context.length <= 160)
        && ["preparing", "running", "completed", "failed", "cancelled", "not-run", "unconfirmed"].includes(String(item.state))
        && (item.elapsedMs === undefined || typeof item.elapsedMs === "number" && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0)))))) return false;
  if (value.recovery !== undefined && (!object(value.recovery) || !["interrupted", "cancelled", "failed", "settled", "needs_input"].includes(String(value.state)) || !string(value.recovery.runId) || value.recovery.runId !== value.identity.runId
    || !Number.isSafeInteger(value.recovery.unconfirmedTools) || Number(value.recovery.unconfirmedTools) < 0 || typeof value.recovery.acknowledgementRequired !== "boolean")) return false;
  const source = value.source;
  if (source !== undefined && (!object(source) || !["workspaceId", "sessionId", "runId", "artifactId"].every(key => string(source[key]) && source[key].length > 0 && source[key].length <= 160)
    || !string(source.sha256) || !/^[a-f0-9]{64}$/.test(source.sha256))) return false;
  if (!isMarketSnapshot(value.market)) return false;
  if (!object(value.output) || !object(value.output.conclusion) || !Array.isArray(value.output.evidence) || !Array.isArray(value.output.artifacts)) return false;
  const conclusion = value.output.conclusion;
  return nullable(conclusion.statement) && nullable(conclusion.boundary) && [null, "low", "medium", "high"].includes(conclusion.confidence as null | string) && typeof conclusion.settled === "boolean"
    && value.output.evidence.every(item => object(item) && string(item.id) && string(item.label) && nullable(item.source) && nullable(item.asOf) && typeof item.available === "boolean")
    && value.output.artifacts.every(item => object(item) && string(item.id) && string(item.title) && string(item.sha256) && /^[a-f0-9]{64}$/i.test(item.sha256) && string(item.createdAt) && typeof item.version === "number" && Number.isSafeInteger(item.version) && item.version > 0
      && (item.runId === undefined || string(item.runId) && item.runId.length > 0 && item.runId.length <= 160)
      && (item.kind === undefined || item.kind === "thesis-baseline" || item.kind === "thesis-review" || item.kind === "tsp-observation" || item.kind === "source-check"));
}
/** Requests contain no credentials; the Host uses the saved selected source. */
export type ObservationJobRequest =
  | { dataset: "daily"; symbol: string; startTime: number; endTime: number; adjustment: "none" | "forward" }
  | { dataset: "daily"; timeMode: "trading-date"; symbol: string; startDate: string; endDate: string; adjustment: "none" | "forward" }
  | { dataset: "minute"; symbol: string; startTime: number; endTime: number; adjustment: "none" | "forward"; interval: "1m" | "5m" | "10m" | "15m" | "30m" | "60m" }
  | { dataset: "daily-trading-limits"; symbol: string; startDate: string; endDate: string }
  | { dataset: "historical-minute-bars"; symbol: string; startDate: string; endDate: string }
  | { dataset: "factor"; symbol: string; startTime: number; endTime: number };
export interface ObservationJobView {
  id: string;
  request: ObservationJobRequest;
  status: "running" | "archived" | "empty" | "failed" | "cancelled";
  cancelRequested: boolean;
  receipt: {
    source: string;
    endpoint: string;
    observedAt: string;
    rowCount: number;
    ref: ObservationArchiveRef | TradingDateArchiveRef | TradingLimitArchiveRef | HistoricalMinuteArchiveRef | null;
  } | null;
  error: "COLLECTION_FAILED" | null;
}

export interface ObservationExchangePreviewRequest {
  archiveRef: TradingDateArchiveRef;
  rawArchiveRef?: TradingDateArchiveRef;
  tradingLimitArchiveRef: TradingLimitArchiveRef;
}

export interface ObservationIntradayRequest {
  archiveRef: HistoricalMinuteArchiveRef;
  tradeDate: string;
  previousClose?: { ref: TradingLimitArchiveRef; priceBasis: "caller-confirmed-same-basis" };
}

export interface ObservationIntradayPreview {
  archiveRef: HistoricalMinuteArchiveRef;
  tradeDate: string;
  producer: "whyj";
  formula: { id: "tsp_intraday"; version: number; revision: string };
  input: Omit<StoredHistoricalMinuteBatch, "rows"> & {
    labelConvention: "tushare-stk-mins-end-time-v1";
    previousClose: {
      archiveRef: TradingLimitArchiveRef;
      priceBasis: "caller-confirmed-same-basis";
      source: "tushare";
      endpoint: "stk_limit";
      observedAt: string;
      priceUnit: "CNY";
      requested: { startDate: string; endDate: string };
    } | null;
  };
  openingBoundaries: StoredHistoricalMinuteBar[];
  rows: {
    tradingDate: string;
    minute: string;
    originalTradeTime: string;
    values: Record<string, number | null>;
    signals: Record<string, boolean | null>;
  }[];
}

interface ExchangeInputEvidence<Ref> {
  ref: Ref;
  source: string;
  endpoint: string;
  observedAt: string;
  requested: { startDate: string; endDate: string };
}

export interface ObservationIndicatorPreview {
  archiveRef: TradingDateArchiveRef;
  formula: { version: number; revision: string };
  input: Pick<StoredTradingDateBarObservation,
    "symbol" | "source" | "endpoint" | "observedAt" | "calendarTimeZone" | "adjustment" | "requested" | "coverage"> & {
      firstTradeDate: string;
      lastTradeDate: string;
      finality: "unknown";
    };
  rows: { date: string; rsi6: number; rsi14: number; rsi24: number; atr14: number }[];
  /** Full WhyJ calculation for this archive. Older Hosts may return only the four-field series. */
  daily?: {
    producer: "whyj";
    formula: { id: "tsp_daily_ohlcv"; version: number; revision: string };
    fields: readonly string[];
    rows: { date: string; values: Record<string, number | null> }[];
  };
  /** WhyJ's daily rule decisions for this fixed archive. Missing inputs stay null. */
  dailySignals?: {
    producer: "whyj";
    formula: { id: "tsp_daily_signals"; version: number; revision: string };
    fields: readonly string[];
    rows: { date: string; values: Record<string, boolean | null> }[];
    exchangeInputs?: {
      raw: ExchangeInputEvidence<TradingDateArchiveRef>;
      limits: ExchangeInputEvidence<TradingLimitArchiveRef>;
    };
  };
}

export interface ObservationAnalyticsPreview {
  archiveRef: TradingDateArchiveRef;
  input: ObservationIndicatorPreview["input"] & Pick<StoredTradingDateBarObservation, "volumeUnit" | "amountUnit"> & {
    rowCount: number;
    usableCnyAmounts: number;
  };
  researchFactors: {
    producer: "whyj";
    formula: { id: "tsp_research_factors"; version: number; revision: string };
    asOf: string;
    values: Record<string, number | null>;
  };
  priceLevels: {
    producer: "whyj";
    formula: { id: "tsp_price_levels"; version: number; revision: string };
    asOf: string | null;
    volumeProfileBasis: "volume-only" | "turnover-decay" | "partial-turnover";
    levels: Record<string, {
      value: number;
      label: string;
      type: string;
      side: "resistance" | "support" | "neutral";
      strength: "strong" | "medium" | "weak";
      rank?: number;
    }[]>;
  };
}

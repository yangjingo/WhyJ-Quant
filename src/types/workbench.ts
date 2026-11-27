import type { ThesisBaselineRequest, ThesisReviewRequest, ThesisView, ThesisTspRequest, ThesisTspView, ThesisSourcesRequest, ThesisSourcesReadRequest, ThesisSourcesView } from "./thesis-workbench.ts";
import type {
  ArchiveAnalyticsBookValueBasis, ArchiveAnalyticsSupplements, ArchiveAnalyticsTurnoverInput, BenchmarkIndexArchiveRef,
  DatedEtfDailyArchiveRef, DatedStockMinuteArchiveRef, FinancialInputReplayRow, FinancialObservationArchiveRef, HistoricalMinuteArchiveRef,
  MarketCrossSectionArchiveRef, MarketRegimeManifestRef,
  ObservationArchiveRef, SectorObservationArchiveRef, StoredBenchmarkIndexBatch, StoredDailyTradingLimit, StoredDailyTradingLimitBatch,
  StoredDatedEtfDailyBatch, StoredDatedStockMinuteBatch, StoredHistoricalMinuteBar, StoredHistoricalMinuteBatch, StoredMarketCrossSection,
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
  readObservationListRows?(input: ObservationListRowsRequest): Promise<ObservationListRowsPreview>;
  readObservationListQuotes?(input: ObservationListRowsRequest): Promise<ObservationListQuotesPreview>;
  readObservationCurrentStockMinutes?(input: ObservationCurrentStockMinutesRequest): Promise<ObservationCurrentStockMinutesPreview>;
  readObservationCurrentEtfMinutes?(input: ObservationCurrentEtfMinutesRequest): Promise<ObservationCurrentEtfMinutesPreview>;
  readObservationListAuctionOverlay?(input: ObservationListAuctionOverlayRequest): Promise<ObservationListAuctionOverlayPreview>;
  readObservationAnalytics?(request: TradingDateArchiveRef | ObservationAnalyticsRequest): Promise<ObservationAnalyticsPreview>;
  readObservationMarketRegime?(ref: MarketRegimeManifestRef): Promise<ObservationMarketRegimePreview>;
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

export interface ObservationListIntradayRequest {
  ref: DatedStockMinuteArchiveRef;
  interpretation: {
    timestampLabel: "minute-start" | "minute-end";
    priceBasis: "caller-confirmed-unadjusted-CNY";
    volumeUnit?: "share" | "hand";
    amountUnit?: "CNY" | "CNY-thousand";
  };
  previousClose?: ObservationIntradayRequest["previousClose"];
}

export interface ObservationListScreenerScope {
  histories: readonly {
    symbol: string;
    ref: TradingDateArchiveRef;
    exchange?: Omit<ObservationExchangePreviewRequest, "archiveRef">;
  }[];
  strategies: readonly {
    strategy: { id: string; revision: string };
    weights: readonly { field: string; weight: number; direction?: "low" | "high" }[];
    signalGate?: { mode: "any" | "all"; signals: readonly string[] };
    orderBy?: string;
    descending?: boolean;
  }[];
}

export interface ObservationListRowsRequest {
  marketRef: MarketCrossSectionArchiveRef;
  adjustment: "none" | "forward";
  watchlistMembershipRevision?: string;
  screener?: ObservationListScreenerScope;
  limitCalendar?: { revision: string; sessions: readonly string[] };
  deviationCalendar?: { revision: string; sessions: readonly string[] };
  stocks: readonly {
    symbol: string;
    history?: { ref: TradingDateArchiveRef; exchange?: Omit<ObservationExchangePreviewRequest, "archiveRef">; candleBars?: number };
    financialArchives?: readonly FinancialObservationArchiveRef[];
    tradingLimitsRef?: TradingLimitArchiveRef;
    intraday?: ObservationListIntradayRequest;
    watchlistHistoryRef?: TradingDateArchiveRef;
    deviation?: { stockRef: TradingDateArchiveRef; benchmarkRef?: BenchmarkIndexArchiveRef };
  }[];
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

type DatedListDaily = NonNullable<ObservationIndicatorPreview["daily"]>;
type DatedListSignals = NonNullable<ObservationIndicatorPreview["dailySignals"]>;

type DeviationWindow = 3 | 10 | 30;
export interface ObservationListDeviationPreview {
  producer: "whyj";
  date: string;
  symbol: string;
  board: "SH" | "SZ" | "STAR" | "GEM" | "BJ";
  formula: { id: "tsp_price_deviation"; version: number; revision: string };
  outputUnit: "fraction";
  values: Record<`deviate_${DeviationWindow}d`, number | null>;
  comparisonDates: Record<DeviationWindow, string | null>;
  benchmark: string | null;
  benchmarkCandidates: readonly string[];
  input: {
    stock: Pick<StoredTradingDateBarObservation, "symbol" | "source" | "endpoint" | "observedAt" | "requested" | "adjustment" | "coverage"> & {
      ref: TradingDateArchiveRef;
      rowsUsed: number;
    };
    benchmark: (Pick<StoredBenchmarkIndexBatch, "symbol" | "source" | "endpoint" | "observedAt" | "requested" | "priceUnit" | "coverage"> & {
      ref: BenchmarkIndexArchiveRef;
      rowsUsed: number;
    }) | null;
  };
  proximity: {
    producer: "whyj";
    date: string;
    formula: { id: "tsp_deviation_proximity"; version: number; revision: string };
    basis: "completed-session";
    unit: "fraction";
    dominantWindow: DeviationWindow | null;
    maxCloseness: number | null;
    tier: "unavailable" | "below-watch" | "watch" | "edge" | "triggered";
    windows: { window: DeviationWindow; deviation: number | null; direction: "up" | "down" | null; threshold: number | null; closeness: number | null }[];
  };
}

export interface ObservationListRowsPreview extends Pick<StoredMarketCrossSection, "source" | "market" | "tradeDate"> {
  marketRef: MarketCrossSectionArchiveRef;
  adjustment: ObservationListRowsRequest["adjustment"];
  limitCalendar?: NonNullable<ObservationListRowsRequest["limitCalendar"]> & { zone: "Asia/Shanghai" };
  deviationCalendar?: NonNullable<ObservationListRowsRequest["deviationCalendar"]> & { zone: "Asia/Shanghai" };
  screener?: {
    scoped: number;
    matched: number;
    strategies: {
      strategy: { id: string; revision: string };
      formula: { id: "tsp_screener_score"; version: number; revision: string };
      candidateRevision: string;
      coverage: { scoped: number; matched: number; notMatched: number; unavailable: number };
      fieldSources: Record<string, { producer: string; endpoint?: string; formula?: string; unit?: string; nativeUnit?: string }>;
    }[];
  };
  observations: {
    roster: Omit<StoredMarketCrossSection["universe"], "members">;
    daily: Omit<StoredMarketCrossSection["bars"], "rows">;
    dailyBasic: Omit<StoredMarketCrossSection["basics"], "rows">;
  };
  rows: {
    instrument: StoredMarketCrossSection["universe"]["members"][number];
    membership?: { producer: "workspace"; revision: string; code: string; addedAt: string | null };
    observations: {
      bar: StoredMarketCrossSection["bars"]["rows"][number] | null;
      basic: StoredMarketCrossSection["basics"]["rows"][number] | null;
      quantities: { volumeShares: number | null; amountCny: number | null };
      financial?: FinancialInputReplayRow;
      tradingLimits?: Omit<StoredDailyTradingLimitBatch, "rows"> & { ref: TradingLimitArchiveRef; row: StoredDailyTradingLimit | null };
      dailyCandles?: ObservationIndicatorPreview["input"] & Pick<StoredTradingDateBarObservation, "volumeUnit" | "amountUnit"> & {
        ref: TradingDateArchiveRef;
        requestedBars: number;
        rows: (Pick<StoredTradingDateBarObservation, "tradeDate" | "sourceTimestamp"> & StoredTradingDateBarObservation["values"])[];
      };
      intraday?: StoredDatedStockMinuteBatch & {
        ref: DatedStockMinuteArchiveRef;
        rowCount: number;
        interpretation: Pick<ObservationListIntradayRequest["interpretation"], "timestampLabel" | "priceBasis"> & {
          volumeUnit: NonNullable<ObservationListIntradayRequest["interpretation"]["volumeUnit"]> | "unknown";
          amountUnit: NonNullable<ObservationListIntradayRequest["interpretation"]["amountUnit"]> | "unknown";
        };
        previousClose: (NonNullable<ObservationIntradayPreview["input"]["previousClose"]> & {
          rows: { tradeDate: string; price: number | null }[];
        }) | null;
        excluded: { tradeDate: string; sourceTimestamp: number; reason: "opening-boundary" | "outside-session" | "unaligned" }[];
      };
    };
    metrics: {
      deviation?: ObservationListDeviationPreview;
      screener?: {
        producer: "whyj";
        position: number | null;
        score: number | null;
        scoreStrategyId: string | null;
        hits: { strategyId: string; score: number | null }[];
        evaluations: { strategyId: string; status: "matched" | "not-matched" | "unavailable" | "outside-scope" }[];
      };
      watchlistReturn?: {
        producer: "whyj";
        formulaVersion: string;
        referenceRevision: string;
        status: "available" | "missing-baseline" | "missing-added-date" | "added-after-cutoff" | "unsupported-asset";
        asOf: string;
        addedAt: string | null;
        addedDate: string | null;
        returnUnit: "fraction";
        pctSinceAdded: number | null;
        baseline: { tradeDate: string; close: number } | null;
        latest: { tradeDate: string; close: number } | null;
        history: Pick<StoredTradingDateBarObservation,
          "symbol" | "source" | "endpoint" | "observedAt" | "requested" | "adjustment" | "coverage" | "calendarTimeZone"> & {
          ref: TradingDateArchiveRef;
        };
      } | null;
      intraday?: {
        producer: "whyj";
        formula: { id: "tsp_list_intraday"; version: number; revision: string };
        tradeDate: string;
        latestReturnFraction: number | null;
        plotBaseline: { kind: "previous-close" | "implied-from-last-return" | "first-observed-open" | "first-observed-close"; value: number } | null;
        points: { minute: string; sourceTimestamp: number; close: number; averageClose: number; previousCloseReturnFraction: number | null }[];
      };
      liquidity: {
        producer: "whyj";
        formula: { id: "tsp_list_liquidity"; version: number; revision: string };
        units: { floatValueCny: "CNY"; turnoverPct: "percentage-points" };
        floatValueCny: number | null;
        turnoverPct: number | null;
      };
      history: ({ ref: TradingDateArchiveRef } & ObservationIndicatorPreview["input"]) | null;
      daily: (Pick<DatedListDaily, "producer" | "formula"> & DatedListDaily["rows"][number]) | null;
      signals: (Pick<DatedListSignals, "producer" | "formula"> & DatedListSignals["rows"][number] & {
        exchangeInputs: NonNullable<DatedListSignals["exchangeInputs"]> | null;
      }) | null;
      limitStreaks?: {
        producer: "whyj";
        formula: { id: "tsp_limit_streaks"; version: number; revision: string };
        consecutiveLimitUps: number | null;
        consecutiveLimitDowns: number | null;
      };
    };
  }[];
}

export type ObservationListQuoteRow = { symbol: string } & (
  | { status: "missing"; sourceTimestamp: null }
  | { status: "missing-price" | "different-session" | "future-timestamp"; sourceTimestamp: number }
  | {
    status: "available";
    sourceTimestamp: number;
    snapshot: { symbol: string; timestamp: number; lastPrice: number; previousClose: number;
      open: number; high: number; low: number; volume: number; amount: number | null;
      reportedChangeAmount?: number; reportedChangeFraction?: number;
      reportedAmplitudeFraction?: number; reportedTurnoverFraction?: number };
    change: { producer: "whyj"; changeAmount: number | null; changeFraction: number | null };
  }
);

export interface ObservationListQuotesPreview {
  fixed: ObservationListRowsPreview;
  quotes: { status: "outside-current-day" | "empty" | "unavailable" } | {
    status: "observed";
    source: string;
    endpoint: string;
    observedAt: string;
    units: "unknown";
    rows: ObservationListQuoteRow[];
  };
}

export interface ObservationCurrentStockMinutesRequest {
  tradeDate: string;
  stocks: readonly { symbol: string; previousClose?: ObservationIntradayRequest["previousClose"] }[];
  interpretation?: Pick<ObservationListIntradayRequest["interpretation"], "timestampLabel" | "priceBasis">;
}

type CurrentStockMinuteStatus = "observed" | "empty" | "missing" | "different-session" | "future-timestamp";
type ListObservationRow = ObservationListRowsPreview["rows"][number];
type FixedListIntraday = NonNullable<ListObservationRow["observations"]["intraday"]>;
type ListIntradayMetrics = NonNullable<ListObservationRow["metrics"]["intraday"]>;

export interface ObservationCurrentStockMinutesPreview {
  input: {
    interpretation: NonNullable<ObservationCurrentStockMinutesRequest["interpretation"]> | null;
    minutes: Omit<StoredDatedStockMinuteBatch, "endpoint" | "symbol" | "adjustment" | "finality" | "rows"> & {
      endpoint: string;
      adjustment: "unknown";
      finality: "provisional";
      requestedSymbols: string[];
      rowLimitPerSymbol: number;
      frames: { symbol: string; status: CurrentStockMinuteStatus; sourceTradeDate: string | null; rows: StoredDatedStockMinuteBatch["rows"] }[];
    };
  };
  rows: {
    symbol: string;
    status: CurrentStockMinuteStatus;
    previousClose: FixedListIntraday["previousClose"];
    metrics: (ListIntradayMetrics & { finality: "provisional" }) | null;
    excluded: FixedListIntraday["excluded"];
  }[];
}

export interface ObservationCurrentEtfMinutesRequest {
  tradeDate: string;
  etfs: readonly { symbol: string; previousClose?: {
    dailyRef: DatedEtfDailyArchiveRef;
    calendar: { revision: string; previousTradeDate: string; tradeDate: string };
    priceBasis: "caller-confirmed-same-basis";
  } }[];
  interpretation?: ObservationCurrentStockMinutesRequest["interpretation"];
}

type EtfMinutePreviousClose = NonNullable<ObservationCurrentEtfMinutesRequest["etfs"][number]["previousClose"]>;
type StockMinuteInput = ObservationCurrentStockMinutesPreview["input"];
type StockMinuteRow = ObservationCurrentStockMinutesPreview["rows"][number];

export interface ObservationCurrentEtfMinutesPreview {
  input: Omit<StockMinuteInput, "minutes"> & { minutes: Omit<StockMinuteInput["minutes"], "assetType"> & { assetType: "etf" } };
  rows: (Omit<StockMinuteRow, "previousClose"> & {
    previousClose: (EtfMinutePreviousClose & Pick<StoredDatedEtfDailyBatch, "source" | "endpoint" | "observedAt" | "priceUnit" | "requested"> &
      { row: StoredDatedEtfDailyBatch["rows"][number] | null }) | null;
  })[];
}

export interface ObservationListAuctionOverlayRequest {
  datasetId: string;
  date: string;
  symbols: readonly string[];
  fields: { price: string; matchedQuantity?: string; unmatchedQuantity?: string };
  timeBasis: "caller-confirmed-shanghai-wall-clock";
}

interface AuctionOverlaySource {
  source: "tsp";
  originalPublisher: "unknown";
  observedAt: string;
  revision: string;
  field: string;
  valueUnit: "unknown";
  series: { symbol: string; status: "observed" | "empty" | "missing"; pointCount: number }[];
}

export interface ObservationListAuctionOverlayPreview {
  input: {
    datasetId: string;
    timeBasis: ObservationListAuctionOverlayRequest["timeBasis"];
    price: AuctionOverlaySource;
    matchedQuantity: AuctionOverlaySource | null;
    unmatchedQuantity: AuctionOverlaySource | null;
  };
  overlay: {
    producer: "whyj";
    version: 1;
    tradeDate: string;
    rows: {
      symbol: string;
      status: "observed" | "unavailable-price";
      ambiguous: { role: keyof ObservationListAuctionOverlayRequest["fields"]; time: string }[];
      points: { time: string; price: number | null; matchedQuantity: number | null; unmatchedQuantity: number | null;
        unmatchedSide: "buy" | "sell" | "balanced" | null }[];
    }[];
  };
}

export type ObservationRegimeState = "strong" | "lean_strong" | "range" | "lean_weak" | "weak";
export type ObservationRegimePhase = "ice" | "ignite" | "rally" | "climax" | "ebb" | "repair";
type RegimeFormula<Id extends string> = { id: Id; version: number; revision: string };
type RegimeMean = { value: number | null; observed: number; denominator: number };
type RegimeLimitCount = { count: number | null; observed: number; known: number; roster: number };

export interface ObservationMarketRegimePreview {
  manifestRef: MarketRegimeManifestRef;
  calendar: { zone: "Asia/Shanghai"; start: string | null; end: string | null; sessions: number };
  universe: "captured-market-roster" | "exclude-observed-risk-warnings";
  phase: { mode: "causal" | "retrospective-tsp"; formula: RegimeFormula<"tsp_market_phase"> };
  summary: {
    producer: "whyj";
    formula: RegimeFormula<"tsp_market_regime_summary">;
    window: { start: string | null; end: string | null; sessions: number; observedStates: number };
    distribution: { state: ObservationRegimeState | null; days: number; pct: number }[];
    stateSwitches: { count: number; observedPairs: number; fraction: number | null };
    momentum: { state: ObservationRegimeState | null; streak: number | null; scoreSlope: number | null;
      sessionsSinceLastObservedWeak: number | null } | null;
    latestPercentiles: { field: string; value: number | null; observed: number; percentilePct: number | null }[];
    segments: {
      phase: ObservationRegimePhase | null; start: string; end: string; days: number;
      means: Record<"height" | "firstBoardCount" | "twoOrMoreCount" | "promotionFraction" | "sealFraction", RegimeMean>;
      conceptDays: number;
      topConcepts: { name: string; topFiveDays: number; scoreSum: number; maxBoards: number; leaderSymbol: string | null }[];
    }[];
    currentPhase: { phase: ObservationRegimePhase; streak: number; segments: number; averageDays: number; maxDays: number;
      successors: { phase: ObservationRegimePhase | null; transitions: number; pct: number }[] } | null;
  };
  rows: {
    tradingDate: string;
    regime: {
      state: ObservationRegimeState | null; score: number | null; label: string | null;
      dimensions: { profit: number; speculation: number; resilience: number; trend: number } | null;
      formula: RegimeFormula<"tsp_market_regime">;
    } | null;
    phase: ObservationRegimePhase | null;
    phaseFutureFields: string[];
    daily: {
      breadth: {
        observedReturns: number; matchedBars: number; advances: number | null; declines: number | null; flat: number | null;
        strongAdvances: number | null; strongDeclines: number | null; advanceDeclineRatio: number | null;
        advanceFraction: number | null; declineFraction: number | null; strongAdvanceFraction: number | null;
        strongDeclineFraction: number | null; aboveMa20Fraction: number | null; observedMa20: number;
      };
      activity: { unit: "CNY"; sourceUnit: "CNY-thousand"; matchedBars: number; observedAmounts: number;
        totalAmountCny: number | null; meanAmountCny: number | null };
      exchange: Record<"limitUp" | "limitDown" | "brokenLimitUp", RegimeLimitCount> | null;
    } | null;
    ladder: {
      height: number; firstBoardCount: number; twoOrMoreCount: number; threeOrMoreCount: number; fiveOrMoreCount: number;
      completeness: number; promotionFraction: number | null; observedPromotionPool: number; sealFraction: number | null;
    } | null;
    market: { ref: MarketCrossSectionArchiveRef; source: "tushare"; observedAt: string } | null;
    benchmark: { ref: BenchmarkIndexArchiveRef; returnPct: number | null } | null;
    concepts: {
      catalogRef: SectorObservationArchiveRef; archivedGroups: number; catalogGroups: number;
      ranks: { name: string; score: number; rank: number; maxBoards: number; leaderSymbol: string | null }[] | null;
    } | null;
  }[];
}

export interface ObservationAnalyticsRequest extends ArchiveAnalyticsSupplements {
  archiveRef: TradingDateArchiveRef;
}

export interface ObservationAnalyticsPreview {
  archiveRef: TradingDateArchiveRef;
  input: ObservationIndicatorPreview["input"] & Pick<StoredTradingDateBarObservation, "volumeUnit" | "amountUnit"> & {
    rowCount: number;
    usableCnyAmounts: number;
    turnoverInputs?: ArchiveAnalyticsTurnoverInput[];
    financialInput?: FinancialInputReplayRow & {
      bookValueBasis?: ArchiveAnalyticsBookValueBasis & { compatible: boolean };
    };
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

import { isDailyDate } from "../../market/bars.ts";
import type { MarketEnvironmentReplayRequest } from "./market-environment-replay.ts";
import type { MarketLadderReplayRequest } from "./market-ladder-replay.ts";
import type { MarketMainlineReplayRequest } from "./market-mainline-replay.ts";
import type { MarketRegimeSummaryReplayRequest } from "./market-regime-summary-replay.ts";
import type { SectorRankReplayRequest } from "./sector-rank-replay.ts";

const revisionPattern = /^[a-f0-9]{64}$/;
const invalid = () => new Error("Invalid market archive manifest");

function manifestObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
export function validateRevisions(revisions: unknown): string[] {
  if (!Array.isArray(revisions) || revisions.length >= 7_000 || new Set(revisions).size !== revisions.length ||
    revisions.some(revision => typeof revision !== "string" || !revisionPattern.test(revision))) throw invalid();
  return revisions;
}

export function parseExchangeSessions(sessions: unknown): string[] {
  if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length >= 7_000 ||
    sessions.some((date, index) => typeof date !== "string" || !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]))) {
    throw invalid();
  }
  return sessions;
}

export function parseMarketReplayScope(value: Record<string, unknown>): MarketLadderReplayRequest {
  const sessions = parseExchangeSessions(value.sessions);
  const { marketRevisions, limitRevisions, riskWarningRevisions } = value;
  const market = validateRevisions(marketRevisions);
  if (market.length > sessions.length) throw invalid();
  return {
    sessions,
    marketRefs: market.map(revision => ({ version: 1, kind: "market-cross-section", revision })),
    limitRefs: validateRevisions(limitRevisions).map(revision => ({ version: 1, kind: "daily-trading-limits", revision })),
    ...(Object.hasOwn(value, "riskWarningRevisions") ? {
      riskWarningRefs: validateRevisions(riskWarningRevisions).map(revision => ({ version: 1 as const, kind: "dated-risk-warnings" as const, revision })),
    } : {}),
  };
}

export function parseEnvironmentManifest(value: unknown): MarketEnvironmentReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const manifest = value as Record<string, unknown>;
  const { priceHistory, benchmark, phaseMode } = manifest;
  const hasRiskWarnings = Object.hasOwn(value, "riskWarningRevisions");
  const scope = parseMarketReplayScope(manifest);
  if (Object.keys(value).length !== 5 + Number(Object.hasOwn(value, "phaseMode")) + Number(hasRiskWarnings) ||
    !Array.isArray(priceHistory) || priceHistory.length > scope.sessions.length ||
    !benchmark || typeof benchmark !== "object" || Array.isArray(benchmark) || Object.keys(benchmark).length !== 2 ||
    (phaseMode !== undefined && phaseMode !== "causal" && phaseMode !== "retrospective-tsp")) throw invalid();
  const { symbol, revisions } = benchmark as Record<string, unknown>;
  if (typeof symbol !== "string" || !/^(?:000\d{3}\.SH|399\d{3}\.SZ)$/.test(symbol)) throw invalid();
  const dates = new Set(scope.sessions);
  const priceDates = new Set<string>();
  const priceRefs = priceHistory.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 2 ||
      typeof item.tradeDate !== "string" || !dates.has(item.tradeDate) || priceDates.has(item.tradeDate)) throw invalid();
    priceDates.add(item.tradeDate);
    return { tradeDate: item.tradeDate, refs: validateRevisions(item.priceRevisions).map(revision => ({ version: 2 as const, revision })) };
  });
  return {
    ...scope, phaseMode, priceHistory: priceRefs,
    benchmark: { symbol, refs: validateRevisions(revisions).map(revision => ({ version: 1, kind: "benchmark-index", revision })) },
  };
}

function parseMainlineFilter(value: unknown): MarketMainlineReplayRequest["filter"] {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !["minMembers", "maxMembers", "blacklist"].includes(key))) throw invalid();
  const { minMembers, maxMembers, blacklist } = value as Record<string, unknown>;
  if ((minMembers !== undefined && (typeof minMembers !== "number" || !Number.isSafeInteger(minMembers) || minMembers < 1)) ||
    (maxMembers !== undefined && (typeof maxMembers !== "number" || !Number.isSafeInteger(maxMembers) || maxMembers < 1)) ||
    (maxMembers ?? 600) < (minMembers ?? 4) ||
    (blacklist !== undefined && (!Array.isArray(blacklist) || blacklist.some(name => typeof name !== "string" || !name.trim())))) throw invalid();
  return { minMembers, maxMembers, blacklist };
}

export function parseSectorRefs(catalogRevision: unknown, memberRevisions: unknown): Pick<SectorRankReplayRequest, "catalogRef" | "memberRefs"> {
  if (typeof catalogRevision !== "string" || !revisionPattern.test(catalogRevision)) throw invalid();
  const members = validateRevisions(memberRevisions);
  if (members.length >= 5_000) throw invalid();
  return { catalogRef: { version: 1, kind: "dated-sector-catalog", revision: catalogRevision },
    memberRefs: members.map(revision => ({ version: 1, kind: "dated-sector-members", revision })) };
}

export function parseMainlineManifest(value: unknown): MarketMainlineReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const manifest = value as Record<string, unknown>;
  const scope = parseMarketReplayScope(manifest);
  const { sectorHistory, filter } = manifest;
  const hasFilter = Object.hasOwn(manifest, "filter");
  if (Object.keys(manifest).length !== 4 + Number(Object.hasOwn(manifest, "riskWarningRevisions")) + Number(hasFilter)) throw invalid();
  return { ...scope, sectorHistory: parseSectorHistory(sectorHistory, scope.sessions),
    filter: hasFilter ? parseMainlineFilter(filter) : undefined };
}

function parseSectorHistory(sectorHistory: unknown, sessions: readonly string[]): MarketMainlineReplayRequest["sectorHistory"] {
  if (!Array.isArray(sectorHistory) || sectorHistory.length > sessions.length) throw invalid();
  const dates = new Set(sessions);
  const seen = new Set<string>();
  return sectorHistory.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 ||
      typeof item.tradeDate !== "string" || !dates.has(item.tradeDate) || seen.has(item.tradeDate)) throw invalid();
    seen.add(item.tradeDate);
    return { tradeDate: item.tradeDate, ...parseSectorRefs(item.catalogRevision, item.memberRevisions) };
  });
}

export function parseRegimeSummaryManifest(value: unknown): MarketRegimeSummaryReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { version, window, concepts, ...environment } = value as Record<string, unknown>;
  if (version !== undefined && version !== 1) throw invalid();
  const request: MarketRegimeSummaryReplayRequest = parseEnvironmentManifest(environment);
  if (window !== undefined) {
    const { start, end } = manifestObject(window, ["start", "end"]);
    if (typeof start !== "string" || typeof end !== "string" || start > end ||
      !request.sessions.includes(start) || !request.sessions.includes(end)) throw invalid();
    request.window = { start, end };
  }
  if (concepts !== undefined) {
    const { sectorHistory, filter } = manifestObject(concepts, ["sectorHistory", "filter"]);
    request.concepts = { sectorHistory: parseSectorHistory(sectorHistory, request.sessions),
      filter: filter === undefined ? undefined : parseMainlineFilter(filter) };
  }
  return request;
}

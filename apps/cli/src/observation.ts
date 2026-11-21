import { open } from "node:fs/promises";
import { isDailyDate } from "../../../src/market/bars.ts";
import { isAIndexSymbol, isDatedBenchmarkIndexSymbol } from "../../../src/market/symbols.ts";
import { deriveTspArchiveAnalytics } from "../../../src/runtime/data/archive-analytics.ts";
import { collectAuctionBenchmark, replayTspAuctionBenchmark, type AuctionBenchmarkReplayRequest } from "../../../src/runtime/data/auction-benchmark.ts";
import { collectBenchmarkIndexObservations } from "../../../src/runtime/data/benchmark-index-collection.ts";
import { collectDepthSnapshot } from "../../../src/runtime/data/depth-snapshot-collection.ts";
import { collectDragonTigerBoard, replayTspDragonTiger } from "../../../src/runtime/data/dragon-tiger.ts";
import { collectFinancialObservations, type FinancialCollectionRequest } from "../../../src/runtime/data/financial-collection.ts";
import { collectHistoricalMinuteObservations, deriveTspArchiveIntraday } from "../../../src/runtime/data/intraday-replay.ts";
import { collectMarketCrossSection, deriveTspMarketBreadthArchive } from "../../../src/runtime/data/market-cross-section.ts";
import { replayTspMarketEmotion, type MarketEmotionReplayRequest } from "../../../src/runtime/data/market-emotion-replay.ts";
import { replayTspMarketEnvironment, type MarketEnvironmentReplayRequest } from "../../../src/runtime/data/market-environment-replay.ts";
import type { MarketLadderReplayRequest } from "../../../src/runtime/data/market-ladder-replay.ts";
import { replayTspMarketMainline, type MarketMainlineReplayRequest } from "../../../src/runtime/data/market-mainline-replay.ts";
import { collectDatedMoneyFlow, replayDatedMoneyFlow } from "../../../src/runtime/data/money-flow.ts";
import { collectTradingDateObservations, collectTradingLimitObservations, deriveTspArchiveIndicators } from "../../../src/runtime/data/observation-collection.ts";
import { collectDatedPopularityList, replayDatedPopularityList } from "../../../src/runtime/data/popularity-list.ts";
import { replayTspPriceDeviation, type PriceDeviationReplayRequest } from "../../../src/runtime/data/price-deviation-replay.ts";
import { collectRiskWarningObservations } from "../../../src/runtime/data/risk-warning-collection.ts";
import { collectSectorObservations, type SectorCollectionRequest } from "../../../src/runtime/data/sector-collection.ts";
import { replayTspSectorRanking, type SectorRankReplayRequest } from "../../../src/runtime/data/sector-rank-replay.ts";
import { replayTspSectorRotation } from "../../../src/runtime/data/sector-rotation.ts";

const dayMs = 86_400_000;
const usage = 'Use "whyj --json observation collect-daily|collect-minutes --symbol CODE --start YYYY-MM-DD --end YYYY-MM-DD" '
  + 'or "whyj --json observation replay-daily|replay-intraday|replay-analytics --revision SHA256". '
  + 'See whyj --help for financial collection and optional flags.';
const revisionPattern = /^[a-f0-9]{64}$/;
const datedStock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const compatiblePriceBasis = "caller-confirmed-same-basis";
const compatibleBookValueBasis = "caller-confirmed-unadjusted-CNY";
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const maxRevisionFileBytes = 512_000;
const maxObservationManifestBytes = 24 * 1_024 * 1_024;

function invalid() {
  return Object.assign(new Error(usage), { code: "invalid_arguments" });
}

function parseOptions(args: readonly string[], allowed: readonly string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("-") || options.has(flag)) throw invalid();
    options.set(flag, value);
  }
  return options;
}

function validateRevisions(revisions: unknown): string[] {
  if (!Array.isArray(revisions) || revisions.length >= 7_000 || new Set(revisions).size !== revisions.length ||
    revisions.some(revision => typeof revision !== "string" || !revisionPattern.test(revision))) throw invalid();
  return revisions;
}

async function readObservationJsonFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  try {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw invalid();
      const json = await file.readFile({ encoding: "utf8", signal });
      if (Buffer.byteLength(json) > maxBytes) throw invalid();
      return JSON.parse(json);
    } finally { await file.close(); }
  } catch { throw invalid(); }
}

async function readRevisionFile(path: string, signal?: AbortSignal): Promise<string[]> {
  return validateRevisions(await readObservationJsonFile(path, maxRevisionFileBytes, signal));
}

function parseRotationManifest(value: unknown): SectorRankReplayRequest[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 ||
      typeof item.marketRevision !== "string" || !revisionPattern.test(item.marketRevision) ||
      typeof item.catalogRevision !== "string" || !revisionPattern.test(item.catalogRevision)) throw invalid();
    const revisions = validateRevisions(item.memberRevisions);
    if (revisions.length >= 5_000) throw invalid();
    return {
      marketRef: { version: 1, kind: "market-cross-section", revision: item.marketRevision },
      catalogRef: { version: 1, kind: "dated-sector-catalog", revision: item.catalogRevision },
      memberRefs: revisions.map(revision => ({ version: 1, kind: "dated-sector-members", revision })),
    };
  });
}

function parseExchangeSessions(sessions: unknown): string[] {
  if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length >= 7_000 ||
    sessions.some((date, index) => typeof date !== "string" || !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]))) {
    throw invalid();
  }
  return sessions;
}

function parseMarketReplayScope(value: Record<string, unknown>): MarketLadderReplayRequest {
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

function parseEnvironmentManifest(value: unknown): MarketEnvironmentReplayRequest {
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

function parseAuctionManifest(value: unknown): AuctionBenchmarkReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) throw invalid();
  const { auctionRevision, calendar, marketRevisions } = value as Record<string, unknown>;
  if (typeof auctionRevision !== "string" || !revisionPattern.test(auctionRevision)
    || !calendar || typeof calendar !== "object" || Array.isArray(calendar) || Object.keys(calendar).length !== 4) throw invalid();
  const { revision, tradeDate, previousTradeDate, nextTradeDate } = calendar as Record<string, unknown>;
  if (typeof revision !== "string" || !revision.trim() || typeof tradeDate !== "string" || !isDailyDate(tradeDate)
    || (previousTradeDate !== null && (typeof previousTradeDate !== "string" || !isDailyDate(previousTradeDate) || previousTradeDate >= tradeDate))
    || (nextTradeDate !== null && (typeof nextTradeDate !== "string" || !isDailyDate(nextTradeDate) || nextTradeDate <= tradeDate))) throw invalid();
  const revisions = validateRevisions(marketRevisions);
  if (revisions.length > 3) throw invalid();
  return {
    auctionRef: { version: 1, kind: "auction-benchmark", revision: auctionRevision },
    calendar: { revision, tradeDate, previousTradeDate, nextTradeDate },
    marketRefs: revisions.map(revision => ({ version: 1, kind: "market-cross-section", revision })),
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

function parseSectorRefs(catalogRevision: unknown, memberRevisions: unknown): Pick<SectorRankReplayRequest, "catalogRef" | "memberRefs"> {
  if (typeof catalogRevision !== "string" || !revisionPattern.test(catalogRevision)) throw invalid();
  const members = validateRevisions(memberRevisions);
  if (members.length >= 5_000) throw invalid();
  return { catalogRef: { version: 1, kind: "dated-sector-catalog", revision: catalogRevision },
    memberRefs: members.map(revision => ({ version: 1, kind: "dated-sector-members", revision })) };
}

function parseMainlineManifest(value: unknown): MarketMainlineReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const manifest = value as Record<string, unknown>;
  const scope = parseMarketReplayScope(manifest);
  const { sectorHistory, filter } = manifest;
  const hasFilter = Object.hasOwn(manifest, "filter");
  if (Object.keys(manifest).length !== 4 + Number(Object.hasOwn(manifest, "riskWarningRevisions")) + Number(hasFilter) ||
    !Array.isArray(sectorHistory) || sectorHistory.length > scope.sessions.length) throw invalid();
  const dates = new Set(scope.sessions);
  const seen = new Set<string>();
  const history: MarketMainlineReplayRequest["sectorHistory"] = sectorHistory.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 ||
      typeof item.tradeDate !== "string" || !dates.has(item.tradeDate) || seen.has(item.tradeDate)) throw invalid();
    seen.add(item.tradeDate);
    return { tradeDate: item.tradeDate, ...parseSectorRefs(item.catalogRevision, item.memberRevisions) };
  });
  return { ...scope, sectorHistory: history, filter: hasFilter ? parseMainlineFilter(filter) : undefined };
}

function parseEmotionDepth(value: unknown): NonNullable<MarketEmotionReplayRequest["depth"]> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) throw invalid();
  const { revision, asOf, maxAgeMs } = value as Record<string, unknown>;
  if (typeof revision !== "string" || !revisionPattern.test(revision) || typeof asOf !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(asOf) ||
    !isDailyDate(asOf.slice(0, 10)) || typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw invalid();
  const cutoff = Date.parse(asOf);
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) throw invalid();
  return { ref: { version: 1, kind: "depth-snapshot", revision }, asOf: cutoff, maxAgeMs };
}

function parseEmotionManifest(value: unknown): MarketEmotionReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const manifest = value as Record<string, unknown>;
  const allowed = ["sessions", "marketRevisions", "limitRevisions", "riskWarningRevisions", "priceRevisions", "indexRevisions", "sectors", "depth"];
  if (Object.keys(manifest).some(key => !allowed.includes(key))) throw invalid();
  const scope = parseMarketReplayScope(manifest);
  const sectors: NonNullable<MarketEmotionReplayRequest["sectors"]> = {};
  if (Object.hasOwn(manifest, "sectors")) {
    const { sectors: value } = manifest;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    for (const [kind, section] of Object.entries(value)) {
      if ((kind !== "concept" && kind !== "industry") || !section || typeof section !== "object" ||
        Array.isArray(section) || Object.keys(section).length !== 2) throw invalid();
      const { catalogRevision, memberRevisions } = section as Record<string, unknown>;
      sectors[kind] = parseSectorRefs(catalogRevision, memberRevisions);
    }
  }
  return { ...scope, sectors, ...(Object.hasOwn(manifest, "depth") ? { depth: parseEmotionDepth(manifest.depth) } : {}),
    priceRefs: validateRevisions(manifest.priceRevisions).map(revision => ({ version: 2, revision })),
    indexRefs: validateRevisions(manifest.indexRevisions).map(revision => ({ version: 1, kind: "benchmark-index", revision })) };
}

function parsePriceDeviationManifest(value: unknown): PriceDeviationReplayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const manifest = value as Record<string, unknown>;
  const { symbol, stockRevision, benchmarkRevision } = manifest;
  if (Object.keys(manifest).some(key => !["symbol", "sessions", "stockRevision", "benchmarkRevision"].includes(key)) ||
    typeof symbol !== "string" || !datedStock.test(symbol) ||
    typeof stockRevision !== "string" || !revisionPattern.test(stockRevision) ||
    (Object.hasOwn(manifest, "benchmarkRevision") &&
      (typeof benchmarkRevision !== "string" || !revisionPattern.test(benchmarkRevision)))) throw invalid();
  return { symbol, sessions: parseExchangeSessions(manifest.sessions), stockRef: { version: 2, revision: stockRevision },
    ...(typeof benchmarkRevision === "string" ? {
      benchmarkRef: { version: 1, kind: "benchmark-index", revision: benchmarkRevision },
    } : {}) };
}

export async function runObservationCommand(args: readonly string[], signal?: AbortSignal) {
  const [action, ...options] = args;
  if (action === "collect-depth") {
    const fields = parseOptions(options, ["--date", "--symbols-file"]);
    const tradeDate = fields.get("--date"), path = fields.get("--symbols-file");
    if (!tradeDate || !isDailyDate(tradeDate) || tradeDate !== shanghaiDate.format() || !path) throw invalid();
    const symbols = await readObservationJsonFile(path, maxRevisionFileBytes, signal);
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length >= 7_000 || new Set(symbols).size !== symbols.length ||
      symbols.some(symbol => typeof symbol !== "string" || !datedStock.test(symbol))) throw invalid();
    try { return await collectDepthSnapshot({ tradeDate, symbols }, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested market depth. Check the configured source with whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "collect-risk-warnings") {
    const date = parseOptions(options, ["--date"]).get("--date");
    if (!date || !isDailyDate(date) || date < "2000-01-01" || date > shanghaiDate.format()) throw invalid();
    try { return await collectRiskWarningObservations(date, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested risk-warning list. Check the configured source with whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "collect-benchmark" || action === "collect-limits") {
    const fields = parseOptions(options, ["--symbol", "--start", "--end"]);
    const symbol = fields.get("--symbol")?.toUpperCase(), start = fields.get("--start"), end = fields.get("--end");
    const benchmark = action === "collect-benchmark";
    if (!symbol || (benchmark
      ? !isDatedBenchmarkIndexSymbol(symbol)
      : isAIndexSymbol(symbol) || !datedStock.test(symbol)) ||
      !start || !end || !isDailyDate(start) || !isDailyDate(end) || start > end || Date.parse(end) - Date.parse(start) > 365 * dayMs) {
      throw invalid();
    }
    try {
      if (benchmark) return await collectBenchmarkIndexObservations({ symbol, start, end }, { signal });
      return await collectTradingLimitObservations({ symbol, startDate: start, endDate: end }, { signal });
    } catch {
      throw Object.assign(new Error("Could not collect the requested benchmark or exchange limits. Check the configured source with whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-market-environment") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseEnvironmentManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspMarketEnvironment(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market environment archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-auction") {
    const tradeDate = parseOptions(options, ["--date"]).get("--date");
    if (!tradeDate || !isDailyDate(tradeDate)) throw invalid();
    try { return await collectAuctionBenchmark(tradeDate, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested auction benchmark. Check the configured Fuyao credential and date."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-auction") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseAuctionManifest(await readObservationJsonFile(path, 4096, signal));
    try { return await replayTspAuctionBenchmark(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested auction benchmark and price archive revisions."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-dragon-tiger") {
    const fields = parseOptions(options, ["--date", "--board"]);
    const tradeDate = fields.get("--date"), board = fields.get("--board");
    if (!tradeDate || !isDailyDate(tradeDate) || (board !== "all" && board !== "org" && board !== "hot_money")) throw invalid();
    try { return await collectDragonTigerBoard(tradeDate, board, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested dragon-tiger board. Check the configured Fuyao credential and date."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-dragon-tiger") {
    const fields = parseOptions(options, ["--date", "--revisions"]);
    const tradeDate = fields.get("--date"), csv = fields.get("--revisions");
    if (!tradeDate || !isDailyDate(tradeDate) || !csv) throw invalid();
    const revisions = validateRevisions(csv.split(","));
    if (revisions.length > 3) throw invalid();
    try {
      return await replayTspDragonTiger({ tradeDate, refs: revisions.map(revision => ({ version: 1, kind: "dragon-tiger-board", revision })) }, signal);
    } catch {
      throw Object.assign(new Error("Could not replay the requested dragon-tiger board archive revisions."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-money-flow") {
    const tradeDate = parseOptions(options, ["--date"]).get("--date");
    if (!tradeDate || !isDailyDate(tradeDate) || tradeDate < "2010-01-01" || tradeDate > shanghaiDate.format()) throw invalid();
    try { return await collectDatedMoneyFlow(tradeDate, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested money flows. Check the selected Tushare source, credential and date."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-money-flow") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    try { return await replayDatedMoneyFlow({ version: 1, kind: "dated-money-flow", revision }, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested money-flow archive revision."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-popularity") {
    const calendarDate = parseOptions(options, ["--date"]).get("--date");
    if (!calendarDate || !isDailyDate(calendarDate) || calendarDate < "0001-01-01" || calendarDate > shanghaiDate.format()) throw invalid();
    try { return await collectDatedPopularityList(calendarDate, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested historical popularity list. Check Fuyao access and the provider date range."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-popularity") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    try { return await replayDatedPopularityList({ version: 1, kind: "dated-popularity-list", revision }, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested popularity archive revision."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-market-mainline") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseMainlineManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspMarketMainline(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market mainline archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-market-emotion") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parseEmotionManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspMarketEmotion(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market emotion archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-price-deviation") {
    const path = parseOptions(options, ["--manifest"]).get("--manifest");
    if (!path) throw invalid();
    const request = parsePriceDeviationManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspPriceDeviation(request, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested price deviation archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-sector-catalog" || action === "collect-sector-members") {
    const catalog = action === "collect-sector-catalog";
    const fields = parseOptions(options, ["--date", catalog ? "--kind" : "--sector-code"]);
    const tradeDate = fields.get("--date"), groupKind = fields.get("--kind"), sectorCode = fields.get("--sector-code");
    if (!tradeDate || !isDailyDate(tradeDate)) throw invalid();
    let request: SectorCollectionRequest;
    if (catalog) {
      if (groupKind !== "industry" && groupKind !== "concept") throw invalid();
      request = { kind: "dated-sector-catalog", groupKind, tradeDate };
    } else {
      if (!sectorCode || !/^BK\d{4,8}\.DC$/.test(sectorCode)) throw invalid();
      request = { kind: "dated-sector-members", sectorCode, tradeDate };
    }
    try {
      return await collectSectorObservations(request, { signal });
    } catch {
      throw Object.assign(new Error("Could not collect dated sector observations. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-sector-rank") {
    const fields = parseOptions(options, ["--market-revision", "--catalog-revision", "--members-file"]);
    const market = fields.get("--market-revision"), catalog = fields.get("--catalog-revision"), path = fields.get("--members-file");
    if (!market || !catalog || !path || !revisionPattern.test(market) || !revisionPattern.test(catalog)) throw invalid();
    const revisions = await readRevisionFile(path, signal);
    if (revisions.length >= 5_000) throw invalid();
    try {
      return await replayTspSectorRanking({
        marketRef: { version: 1, kind: "market-cross-section", revision: market },
        catalogRef: { version: 1, kind: "dated-sector-catalog", revision: catalog },
        memberRefs: revisions.map(revision => ({ version: 1, kind: "dated-sector-members", revision })),
      }, signal);
    } catch {
      throw Object.assign(new Error("Could not replay the requested market and sector archive revisions."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-sector-rotation") {
    const fields = parseOptions(options, ["--manifest", "--days"]);
    const path = fields.get("--manifest"), requestedDays = fields.get("--days") ?? "12";
    const days = Number(requestedDays);
    if (!path || !/^\d+$/.test(requestedDays) || !Number.isSafeInteger(days)) throw invalid();
    const requests = parseRotationManifest(await readObservationJsonFile(path, maxObservationManifestBytes, signal));
    try { return await replayTspSectorRotation(requests, days, signal); }
    catch {
      throw Object.assign(new Error("Could not replay the requested sector rotation archives."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-daily" || action === "collect-minutes") {
    const minutes = action === "collect-minutes";
    const flags = ["--symbol", "--start", "--end"];
    if (!minutes) flags.push("--adjustment");
    const fields = parseOptions(options, flags);
    const symbol = fields.get("--symbol"), startDate = fields.get("--start"), endDate = fields.get("--end");
    const adjustment = fields.get("--adjustment") ?? "none";
    if (!symbol || !datedStock.test(symbol) ||
      !startDate || !endDate || !isDailyDate(startDate) || !isDailyDate(endDate) ||
      startDate < (minutes ? "2010-01-01" : "0001-01-01") || endDate > "9998-12-31" || startDate > endDate ||
      Date.parse(endDate) - Date.parse(startDate) > (minutes ? 30 : 365) * dayMs ||
      (adjustment !== "none" && adjustment !== "forward")) {
      throw invalid();
    }
    if (minutes && endDate >= shanghaiDate.format()) throw invalid();
    try {
      if (minutes) return await collectHistoricalMinuteObservations({ symbol, startDate, endDate }, { signal });
      return await collectTradingDateObservations({ timeMode: "trading-date", symbol, assetType: "stock",
        interval: "1d", adjustment, startDate, endDate }, { signal });
    } catch {
      const dataset = minutes ? "historical minute" : "daily";
      throw Object.assign(new Error(`Could not collect ${dataset} observations. Check the configured source and use whyj --json doctor --phase data.`),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "collect-market") {
    const date = parseOptions(options, ["--date"]).get("--date");
    if (!date || !isDailyDate(date) || date < "2016-01-01" || date > shanghaiDate.format()) throw invalid();
    try { return await collectMarketCrossSection(date, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested market cross-section. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-market") {
    const fields = parseOptions(options, ["--revision", "--price-revisions", "--price-revisions-file", "--volume-revisions"]);
    const revision = fields.get("--revision"), priceList = fields.get("--price-revisions"), priceFile = fields.get("--price-revisions-file");
    if (!revision || !revisionPattern.test(revision) || (priceList && priceFile)) throw invalid();
    const volumeRevisions = validateRevisions(fields.get("--volume-revisions")?.split(",") ?? []);
    if (volumeRevisions.length > 5 || volumeRevisions.includes(revision)) throw invalid();
    const priceRevisions = priceFile ? await readRevisionFile(priceFile, signal) : validateRevisions(priceList?.split(",") ?? []);
    const history = priceRevisions.length || volumeRevisions.length ? {
      priceArchives: priceRevisions.map(value => ({ version: 2, revision: value } as const)),
      volumeArchives: volumeRevisions.map(value => ({ version: 1, kind: "market-cross-section", revision: value } as const)),
    } : undefined;
    try { return await deriveTspMarketBreadthArchive({ version: 1, kind: "market-cross-section", revision }, signal, history); }
    catch {
      throw Object.assign(new Error("Could not replay the requested market cross-section and its history."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "collect-financial-indicators" || action === "collect-disclosure-dates") {
    const indicators = action === "collect-financial-indicators";
    const fields = parseOptions(options, indicators ? ["--symbol", "--start", "--end"] : ["--symbol", "--period"]);
    const symbol = fields.get("--symbol");
    if (!symbol || !datedStock.test(symbol)) throw invalid();
    let request: FinancialCollectionRequest;
    if (indicators) {
      const startPeriod = fields.get("--start"), endPeriod = fields.get("--end");
      if (!startPeriod || !endPeriod || !isDailyDate(startPeriod) || !isDailyDate(endPeriod) || startPeriod > endPeriod) throw invalid();
      request = { kind: "report-financial-indicators", symbol, startPeriod, endPeriod };
    } else {
      const periodEnd = fields.get("--period");
      if (!periodEnd || !isDailyDate(periodEnd)) throw invalid();
      request = { kind: "financial-disclosure-dates", symbol, periodEnd };
    }
    try { return await collectFinancialObservations(request, { signal }); }
    catch {
      throw Object.assign(new Error("Could not collect the requested financial observations. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-analytics") {
    const fields = parseOptions(options, ["--revision", "--financial-report-revisions", "--financial-disclosure-revisions",
      "--turnover-revisions", "--confirm-unadjusted-cny-book-value"]);
    const revision = fields.get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    const reportRevisions = validateRevisions(fields.get("--financial-report-revisions")?.split(",") ?? []);
    const disclosureRevisions = validateRevisions(fields.get("--financial-disclosure-revisions")?.split(",") ?? []);
    const turnoverRevisions = validateRevisions(fields.get("--turnover-revisions")?.split(",") ?? []);
    if (turnoverRevisions.length > 366 || disclosureRevisions.some(value => reportRevisions.includes(value))) throw invalid();
    const confirmation = fields.get("--confirm-unadjusted-cny-book-value");
    let bookValueBasis;
    if (confirmation !== undefined) {
      const [reportRevision, periodEnd, ...extra] = confirmation.split(",");
      if (!reportRevision || !reportRevisions.includes(reportRevision) || !periodEnd || !isDailyDate(periodEnd) || extra.length) throw invalid();
      bookValueBasis = { reportRevision, periodEnd, basis: compatibleBookValueBasis } as const;
    }
    try {
      return await deriveTspArchiveAnalytics({ version: 2, revision }, signal, {
        financialArchives: [
          ...reportRevisions.map(value => ({ version: 1, kind: "report-financial-indicators", revision: value } as const)),
          ...disclosureRevisions.map(value => ({ version: 1, kind: "financial-disclosure-dates", revision: value } as const)),
        ],
        turnoverArchives: turnoverRevisions.map(value => ({ version: 1, kind: "market-cross-section", revision: value })),
        bookValueBasis,
      });
    } catch {
      throw Object.assign(new Error("Could not replay the requested daily analytics archive and its inputs."),
        { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-daily") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !revisionPattern.test(revision)) throw invalid();
    try {
      return await deriveTspArchiveIndicators({ version: 2, revision }, signal);
    } catch {
      throw Object.assign(new Error("Could not read the requested daily archive revision."), { code: "observation_archive_unavailable" });
    }
  }
  if (action === "replay-intraday") {
    const fields = parseOptions(options, ["--revision", "--previous-close-revision", "--price-basis"]);
    const revision = fields.get("--revision");
    const previousRevision = fields.get("--previous-close-revision");
    const priceBasis = fields.get("--price-basis");
    if (!revision || !revisionPattern.test(revision) ||
      (previousRevision ? !revisionPattern.test(previousRevision) || priceBasis !== compatiblePriceBasis : priceBasis !== undefined)) {
      throw invalid();
    }
    try {
      return await deriveTspArchiveIntraday({ version: 1, kind: "historical-minute-bars", revision }, {
        signal,
        previousClose: previousRevision ? {
          ref: { version: 1, kind: "daily-trading-limits", revision: previousRevision },
          priceBasis: compatiblePriceBasis,
        } : undefined,
      });
    } catch {
      throw Object.assign(new Error("Could not replay the requested minute archive and its supplementary inputs."),
        { code: "observation_archive_unavailable" });
    }
  }
  throw invalid();
}

import { open } from "node:fs/promises";
import { isDailyDate } from "../../../src/market/bars.ts";
import { collectHistoricalMinuteObservations, deriveTspArchiveIntraday } from "../../../src/runtime/data/intraday-replay.ts";
import { collectMarketCrossSection, deriveTspMarketBreadthArchive } from "../../../src/runtime/data/market-cross-section.ts";
import { collectTradingDateObservations, deriveTspArchiveIndicators } from "../../../src/runtime/data/observation-collection.ts";
import { collectSectorObservations, type SectorCollectionRequest } from "../../../src/runtime/data/sector-collection.ts";
import { replayTspSectorRanking, type SectorRankReplayRequest } from "../../../src/runtime/data/sector-rank-replay.ts";
import { replayTspSectorRotation } from "../../../src/runtime/data/sector-rotation.ts";

const dayMs = 86_400_000;
const usage = 'Use "whyj --json observation collect-daily|collect-minutes --symbol CODE --start YYYY-MM-DD --end YYYY-MM-DD" '
  + 'or "whyj --json observation replay-daily|replay-intraday --revision SHA256". See whyj --help for optional flags.';
const revisionPattern = /^[a-f0-9]{64}$/;
const compatiblePriceBasis = "caller-confirmed-same-basis";
const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const maxRevisionFileBytes = 512_000;
const maxRotationManifestBytes = 24 * 1_024 * 1_024;

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

export async function runObservationCommand(args: readonly string[], signal?: AbortSignal) {
  const [action, ...options] = args;
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
    const requests = parseRotationManifest(await readObservationJsonFile(path, maxRotationManifestBytes, signal));
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
    if (!symbol || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(symbol) ||
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

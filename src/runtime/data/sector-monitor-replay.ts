import { computeTspSectorMonitor, type TspSectorMonitorInput, type TspSectorMonitorRule } from "../../quant/index.ts";
import { loadQuotePollArchive, loadSectorObservationArchive, type QuotePollArchiveRef, type SectorObservationArchiveRef } from "../../storage/index.ts";
import { replayDatedIndexMinutes, type DatedIndexMinuteReplayRequest } from "./index-minute-observations.ts";

export type SectorMonitorReplayRequest = { rule?: TspSectorMonitorRule } & (
  ({ kind: "index"; name?: string } & DatedIndexMinuteReplayRequest) |
  { kind: "sector"; catalogRef: SectorObservationArchiveRef; memberRef: SectorObservationArchiveRef; quoteRefs: readonly QuotePollArchiveRef[] }
);

async function replaySector(
  request: Extract<SectorMonitorReplayRequest, { kind: "sector" }>,
  signal?: AbortSignal,
) {
  const { catalogRef, memberRef, quoteRefs, rule } = request;
  if (!Array.isArray(quoteRefs) || !quoteRefs.length) throw new Error("Sector monitor requires fixed quote polls");
  const [catalog, members] = await Promise.all([
    loadSectorObservationArchive(catalogRef, signal), loadSectorObservationArchive(memberRef, signal),
  ]);
  if (catalog.endpoint !== "dc_index" || members.endpoint !== "dc_member" || catalog.tradeDate !== members.tradeDate ||
    catalog.market !== members.market || catalog.source !== members.source || catalog.taxonomy !== members.taxonomy) {
    throw new Error("Sector monitor catalog and members do not match");
  }
  const group = catalog.groups.find(item => item.code === members.sectorCode);
  if (!group) throw new Error("Sector monitor group is outside its catalog");
  const names = new Map(members.members.map(member => [member.symbol, member.name]));
  const captures: TspSectorMonitorInput["captures"][number][] = [];
  const polls = [];
  let previousObservedAt = 0;
  let scope: readonly string[] | undefined;
  for (const ref of quoteRefs) {
    const { rows, ...capture } = await loadQuotePollArchive(ref, signal);
    const observedAt = Date.parse(capture.observedAt);
    const memberScope = capture.requestedSymbols.filter(symbol => names.has(symbol));
    if (capture.tradeDate !== catalog.tradeDate || capture.market !== catalog.market ||
      observedAt <= previousObservedAt || Date.parse(capture.startedAt) < previousObservedAt ||
      (names.size > 0 && !memberScope.length) || (scope && (memberScope.length !== scope.length ||
        memberScope.some((symbol, index) => symbol !== scope![index])))) {
      throw new Error("Sector monitor polls must match the date and member scope and be ordered and nonoverlapping");
    }
    scope = memberScope;
    previousObservedAt = observedAt;
    const matched = rows.filter(row => names.has(row.symbol));
    const quotes = matched.map(({ symbol, lastPrice, previousClose }) => {
      const change = lastPrice > 0 && previousClose > 0 ? lastPrice / previousClose - 1 : null;
      return { symbol, name: names.get(symbol) ?? null, changeFraction: change !== null && Number.isFinite(change) ? change : null };
    });
    captures.push({ observedAt, quotes });
    const sourceTimes = matched.map(row => row.timestamp);
    polls.push({
      ref, ...capture, requestedMembers: memberScope, returnedMembers: matched.map(row => row.symbol),
      sourceTimeRange: sourceTimes.length ? { earliest: Math.min(...sourceTimes), latest: Math.max(...sourceTimes) } : null,
    });
  }
  signal?.throwIfAborted();
  return {
    ...computeTspSectorMonitor({
      tradingDate: catalog.tradeDate, rule, captures,
      target: { id: group.code, name: group.name, kind: catalog.kind, membershipRevision: memberRef.revision, members: [...names.keys()] },
    }),
    input: {
      sampleTimeBasis: "quote-poll-receipt" as const,
      membership: {
        catalogRef, memberRef, source: catalog.source, taxonomy: catalog.taxonomy, kind: catalog.kind,
        catalogObservedAt: catalog.observedAt, memberObservedAt: members.observedAt, historicalAvailability: "unknown" as const,
      },
      polls,
    },
  };
}

/** Rebuild dated monitor metrics without resolving a provider or refreshing the input archives. */
export async function replayTspSectorMonitor(request: SectorMonitorReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const snapshot = structuredClone(request);
  if (snapshot.kind === "sector") return replaySector(snapshot, signal);
  if (snapshot.kind !== "index") throw new Error("Invalid sector monitor replay kind");
  const replay = await replayDatedIndexMinutes(snapshot, signal);
  const { rows, ...minutes } = replay.input.minutes;
  const { symbol, tradeDate } = minutes;
  const name = snapshot.name ?? symbol;
  signal?.throwIfAborted();
  return {
    ...computeTspSectorMonitor({
      tradingDate: tradeDate, rule: snapshot.rule, target: { kind: "index", id: symbol, name, symbol },
      captures: replay.metrics.points.map(({ sourceTimestamp, returnFraction }, index) => ({
        observedAt: sourceTimestamp,
        quotes: [{ symbol, name, pricePoints: rows[index]!.closePoints, changeFraction: returnFraction }],
      })),
    }),
    input: { sampleTimeBasis: minutes.timestampLabel, minutes: { ...minutes, rowCount: rows.length }, previousClose: replay.input.previousClose },
  };
}

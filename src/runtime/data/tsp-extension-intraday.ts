import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol } from "../../market/symbols.ts";
import { computeTspExtensionIntraday, type TspExtensionIntradayInput, type TspExtensionIntradaySeries } from "../../quant/index.ts";
import { loadObservationArchive, loadTradingDateArchive, loadTspExtensionPageArchive, type ObservationArchiveRef,
  type TradingDateArchiveRef, type TspExtensionPageArchiveRef } from "../../storage/index.ts";

export interface TspExtensionIntradayReplayRequest {
  tradeDate: string;
  previousDate: string | null;
  membership: { ref: TspExtensionPageArchiveRef; dimensionField: string; value: string; symbolField: string };
  universe: TspExtensionIntradayInput["universe"];
  histories: readonly { symbol: string; minuteRef: ObservationArchiveRef; previousCloseRef?: TradingDateArchiveRef }[];
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

export async function replayTspExtensionIntraday(request: TspExtensionIntradayReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { tradeDate, previousDate, membership, universe, histories } = structuredClone(request);
  if (!isDailyDate(tradeDate) || (previousDate !== null && (!isDailyDate(previousDate) || previousDate >= tradeDate)) ||
    !membership || !Array.isArray(histories) || typeof membership.value !== "string" || !membership.value.trim()) {
    throw new Error("Invalid extension minute replay scope");
  }
  const { ref, dimensionField, symbolField, value: rawValue } = membership;
  const value = rawValue.trim();
  const { rows: membershipRows, ...page } = await loadTspExtensionPageArchive(ref, signal);
  if ((page.request.selection.mode === "timeseries" && page.request.selection.date !== tradeDate) ||
    !page.fields.some(field => field.name === dimensionField) ||
    !page.fields.some(field => field.name === symbolField && field.dtype === "string")) {
    throw new Error("Mismatched extension minute membership");
  }
  const literal = value.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&");
  const memberMatch = new RegExp("(?:^|[、,，;；|/\\s-])" + literal + "(?=$|[、,，;；|/\\s-])", "u");
  const members = new Set<string>();
  let matchedRows = 0, missingSymbols = 0;
  for (const row of membershipRows) {
    const dimension = Object.hasOwn(row, dimensionField) ? row[dimensionField] : null;
    if (dimension == null || !memberMatch.test(String(dimension))) continue;
    matchedRows++;
    const symbol = Object.hasOwn(row, symbolField) ? row[symbolField] : null;
    if (typeof symbol !== "string" || !stock.test(symbol) || isAIndexSymbol(symbol)) { missingSymbols++; continue; }
    members.add(symbol);
  }

  const start = Date.parse(tradeDate + "T00:00:00+08:00"), end = start + 86_400_000;
  const resolved: TspExtensionIntradaySeries[] = [];
  const priceEvidence = [];
  for (const history of histories as TspExtensionIntradayReplayRequest["histories"]) {
    signal?.throwIfAborted();
    if (!history) throw new Error("Invalid extension minute history reference");
    const { symbol, minuteRef, previousCloseRef } = history;
    const minuteRows = await loadObservationArchive(minuteRef, signal);
    const bars = [];
    for (const row of minuteRows) {
      if (row.kind !== "minute_bar" || row.symbol !== symbol || row.interval !== "1m" || row.adjustment !== "none") {
        throw new Error("Mismatched extension minute archive");
      }
      if (row.timestamp >= start && row.timestamp < end) bars.push({ timestamp: row.timestamp, close: row.values.close });
    }
    if (!bars.length) throw new Error("Missing extension minute date in the supplied archive");
    const first = minuteRows[0]!;
    let previousClose: TspExtensionIntradaySeries["previousClose"] = null;
    let priorEvidence = null;
    if (previousCloseRef !== undefined) {
      if (previousDate === null) throw new Error("Extension minute prior close requires a date");
      const daily = await loadTradingDateArchive(previousCloseRef, signal);
      const day = daily[0]!;
      if (day.symbol !== symbol || day.adjustment !== "none" || previousDate < day.requested.startDate || previousDate > day.requested.endDate) {
        throw new Error("Mismatched extension minute prior-close archive");
      }
      const row = daily.find(item => item.tradeDate === previousDate);
      previousClose = { tradeDate: previousDate, revision: previousCloseRef.revision, price: row?.values.close ?? null };
      priorEvidence = { ref: previousCloseRef, source: day.source, endpoint: day.endpoint, observedAt: day.observedAt,
        tradeDate: previousDate, sourceTimestamp: row?.sourceTimestamp ?? null, price: previousClose.price };
    }
    resolved.push({ symbol, minuteRevision: minuteRef.revision, bars: bars.sort((a, b) => a.timestamp - b.timestamp), previousClose });
    priceEvidence.push({ symbol, minute: { ref: minuteRef, source: first.source, endpoint: first.endpoint,
      observedAt: first.observedAt, timestampBasis: "source-epoch-ms" as const, finality: first.finality, rowCount: bars.length },
    previousClose: priorEvidence });
  }
  signal?.throwIfAborted();
  return {
    ...computeTspExtensionIntraday({ tradeDate, previousDate, adjustment: "none", universe, histories: resolved,
      membership: { datasetId: page.request.datasetId, revision: ref.revision, field: dimensionField, value, symbols: [...members].sort() } }),
    input: { membership: { ref, ...page, dimensionField, symbolField, value, matchedRows, missingSymbols,
      historicalAvailability: "unknown" as const }, prices: priceEvidence },
  };
}

import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol } from "../../market/symbols.ts";
import { computeTspIntradaySignal, computeTspMonitorAlerts, parseTspIntradaySignalRule, tspMinuteIndex, TSP_INDICATOR_REVISION,
  TSP_INTRADAY_SIGNAL_FORMULA_VERSION, type TspCompletedMinuteBar, type TspIntradayRow, type TspIntradaySignalRule, type TspIntradaySignals, type TspIntradayValues,
  type TspMonitorAlertRule } from "../../quant/index.ts";
import type { HistoricalMinuteArchiveRef } from "../../storage/index.ts";
import { resolveTspArchiveIntraday, type IntradayReplayOptions } from "./intraday-replay.ts";
import { digestMonitorEvidence as digest, digestMonitorRule } from "./monitor-alert-identity.ts";
import { resolveTickFlowStockMinutes, type TickFlowStockMinuteReplayRequest } from "./tickflow-stock-minute-replay.ts";

export const TSP_INTRADAY_MONITOR_UNITS = {
  open: "CNY", high: "CNY", low: "CNY", close: "CNY", volume: "share", amount: "CNY",
  price: "CNY", vwap: "CNY", pct_vs_prev_close: "fraction", pct_from_open: "fraction", day_high_dist: "fraction",
  day_low_dist: "fraction", open_30m_high_dist: "fraction", open_30m_low_dist: "fraction", vol_ratio_1m_today: "ratio",
  vol_ratio_3m_today: "ratio", vol_ratio_5m_today: "ratio",
} as const satisfies Record<keyof TspIntradayValues | "open" | "high" | "low" | "close" | "volume" | "amount", string>;

export const TSP_INTRADAY_MONITOR_SIGNALS = [
  "signal_intraday_avg_cross_up", "signal_intraday_avg_cross_down", "signal_intraday_zero_cross_up", "signal_intraday_zero_cross_down",
] as const satisfies readonly (keyof TspIntradaySignals)[];

export interface IntradayMonitorAlertReplayRequest {
  rule: TspMonitorAlertRule;
  slots: readonly { tradeDate: string; minute: string }[];
  roster: readonly string[];
  histories: readonly IntradayMonitorHistory[];
  customSignals?: readonly TspIntradaySignalRule[];
}

type IntradayMonitorHistory = { symbol: string } & (
  { ref: HistoricalMinuteArchiveRef; previousClose?: IntradayReplayOptions["previousClose"] } |
  TickFlowStockMinuteReplayRequest
);
type MinuteRow = TspIntradayRow & ({ originalTradeTime: string } | { sourceTimestamp: number });
type MinuteEvidence = { row: MinuteRow; bar: TspCompletedMinuteBar; custom: Record<string, boolean> };
type MinuteNumericField = keyof typeof TSP_INTRADAY_MONITOR_UNITS;

function minuteOperand(observation: MinuteEvidence, field: string): number | boolean | null {
  const { row, bar, custom } = observation;
  if (Object.hasOwn(row.signals, field)) return row.signals[field as keyof TspIntradaySignals];
  if (Object.hasOwn(custom, field)) return custom[field]!;
  if (Object.hasOwn(row.values, field)) return row.values[field as keyof TspIntradayValues];
  if (field === "volume") return bar.volumeShares;
  if (field === "amount") return bar.amountCny;
  return bar[field as "open" | "high" | "low" | "close"];
}

async function resolveMonitorHistory(history: IntradayMonitorHistory, signal?: AbortSignal) {
  if ("refs" in history) {
    const { completed, preview } = await resolveTickFlowStockMinutes(history, signal);
    return { completed, rows: preview.rows,
      evidence: { ...preview.input, featureFormula: preview.formula, excluded: preview.excluded,
        openingBoundaryCount: preview.excluded.filter(row => row.reason === "opening-boundary").length },
      revision: [preview.input.symbol, "tickflow", preview.input.archives.map(({ ref }) => ref.revision),
        preview.input.previousClose?.archiveRef.revision ?? null, preview.formula, preview.input.interpretation],
    };
  }
  const { completed, preview } = await resolveTspArchiveIntraday(history.ref, { signal, previousClose: history.previousClose });
  return { completed, rows: preview.rows,
    evidence: { ref: preview.archiveRef, ...preview.input, featureFormula: preview.formula, openingBoundaryCount: preview.openingBoundaries.length },
    revision: [preview.input.symbol, preview.archiveRef.revision, preview.input.previousClose?.archiveRef.revision ?? null, preview.formula],
  };
}

/** Reconstruct monitored decisions at the close of explicitly selected minutes. */
export async function replayTspIntradayMonitorAlerts(request: IntradayMonitorAlertReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { rule, slots, roster, histories, customSignals = [] } = structuredClone(request);
  if (rule?.assetType !== "stock" || !Array.isArray(slots) || !slots.length || !Array.isArray(roster) ||
    !Array.isArray(histories) || !Array.isArray(customSignals)) throw new Error("Invalid intraday monitor rule or scope");
  let previousTime = 0;
  const timeline = (slots as IntradayMonitorAlertReplayRequest["slots"]).map(slot => {
    if (!slot || !isDailyDate(slot.tradeDate) || typeof slot.minute !== "string" || tspMinuteIndex(slot.minute) < 0) {
      throw new Error("Intraday monitor slots require a Shanghai trading-minute start");
    }
    const evaluatedAt = Date.parse(`${slot.tradeDate}T${slot.minute}:00+08:00`) + 60_000;
    if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt <= previousTime) throw new Error("Intraday monitor slots must be ordered and unique");
    previousTime = evaluatedAt;
    return { ...slot, evaluatedAt, key: `${slot.tradeDate} ${slot.minute}` };
  });
  const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
  const rosterIndex = new Map<string, number>(roster.map((symbol, index) => [symbol, index]));
  if (rosterIndex.size !== roster.length || roster.some(symbol => typeof symbol !== "string" || !stock.test(symbol) || isAIndexSymbol(symbol))) {
    throw new Error("Invalid or duplicate intraday monitor roster member");
  }
  if (rule.scope?.kind !== "all" && (!Array.isArray(rule.scope?.symbols) || rule.scope.symbols.some(symbol => !rosterIndex.has(symbol)))) {
    throw new Error("Intraday monitor scope must be contained in the supplied roster");
  }
  const definitions = customSignals.map(parseTspIntradaySignalRule).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(definitions.map(definition => definition.id)).size !== definitions.length) {
    throw new Error("Duplicate custom intraday signal definition");
  }
  const signalFields = new Set<string>([...TSP_INTRADAY_MONITOR_SIGNALS, ...definitions.map(({ id }) => `csgi_${id}`)]);
  if (!Array.isArray(rule.conditions) || !rule.conditions.length) throw new Error("Invalid intraday monitor conditions");
  const units: Record<string, string> = {};
  for (const condition of rule.conditions) {
    if (condition?.op === "truth" && signalFields.has(condition.field)) continue;
    if (!condition || condition.op === "truth" || !Object.hasOwn(TSP_INTRADAY_MONITOR_UNITS, condition.field)) {
      throw new Error("Unsupported intraday monitor field or operator");
    }
    const unit = TSP_INTRADAY_MONITOR_UNITS[condition.field as MinuteNumericField];
    if (condition.unit !== unit) throw new Error(`Incompatible intraday monitor unit for ${condition.field}`);
    units[condition.field] = unit;
  }
  const fields = [...new Set(rule.conditions.map(condition => condition.field))];
  const slotKeys = new Set(timeline.map(slot => slot.key));
  const resolved = new Map<string, Map<string, MinuteEvidence>>();
  const archives = [];
  const revisions = [];
  for (const history of [...histories as IntradayMonitorAlertReplayRequest["histories"]].sort((a, b) =>
    (a?.symbol ?? "").localeCompare(b?.symbol ?? ""))) {
    signal?.throwIfAborted();
    if (!history || !rosterIndex.has(history.symbol) || resolved.has(history.symbol)) throw new Error("Foreign or duplicate intraday monitor history");
    const { symbol } = history;
    const { completed, rows, evidence, revision } = await resolveMonitorHistory(history, signal);
    if (evidence.symbol !== symbol) throw new Error("Intraday monitor archive has a mismatched symbol");
    const projected = new Map<string, MinuteEvidence>();
    const calculatedSignals = definitions.map(definition => ({ field: `csgi_${definition.id}`, results: computeTspIntradaySignal(rows, definition) }));
    for (const [index, row] of rows.entries()) {
      const key = `${row.tradingDate} ${row.minute}`;
      if (!slotKeys.has(key)) continue;
      const custom = Object.fromEntries(calculatedSignals.map(({ field, results }) => [field, results[index]!.triggered]));
      projected.set(key, { row, bar: completed[index]!, custom });
    }
    resolved.set(symbol, projected);
    archives.push({ ...evidence, selectedMinuteCount: projected.size });
    revisions.push(revision);
  }
  const customSignalFormula = definitions.length ? {
    id: "tsp_intraday_custom_signal" as const, version: TSP_INTRADAY_SIGNAL_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION,
  } : null;
  const sourceRevision = digest(["completed-minute", roster, revisions, customSignalFormula, definitions]);
  const captures = timeline.map(({ key, evaluatedAt }) => {
    signal?.throwIfAborted();
    const observations = roster.map(symbol => resolved.get(symbol)?.get(key));
    const columns = Object.fromEntries(fields.map(field => [field, observations.map(observation => observation ? minuteOperand(observation, field) : null)]));
    return { revision: digest([sourceRevision, key]), evaluatedAt, symbols: roster, columns, units };
  });
  const result = computeTspMonitorAlerts({ rule, captures });
  const ruleDigest = digestMonitorRule(rule);
  return { ...result, producer: "whyj" as const, basis: "historical-reconstruction" as const, granularity: "1m" as const,
    rule, ruleDigest, roster, units, histories: archives, customSignals: definitions, customSignalFormula,
    evaluations: result.evaluations.map((evaluation, index) => {
      const { tradeDate, minute, key } = timeline[index]!;
      return { ...evaluation, tradeDate, minute, missingSymbols: roster.filter(symbol => !resolved.get(symbol)?.has(key)),
        events: evaluation.events.map(event => {
          const { row } = resolved.get(event.symbol)!.get(key)!;
          const position = rosterIndex.get(event.symbol)!;
          const { columns } = captures[index]!;
          const timeEvidence = "sourceTimestamp" in row ? { sourceTimestamp: row.sourceTimestamp } : { originalTradeTime: row.originalTradeTime };
          return { ...event, eventId: digest([result.referenceRevision, result.formulaVersion, ruleDigest, evaluation.captureRevision, event.symbol]),
            ...timeEvidence, priceCny: row.values.price, changeFraction: row.values.pct_vs_prev_close,
            operands: Object.fromEntries(fields.map(field => [field, columns[field]?.[position] ?? null])) };
        }) };
    }),
  };
}

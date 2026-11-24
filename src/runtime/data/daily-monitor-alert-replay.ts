import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol } from "../../market/symbols.ts";
import { computeTspMonitorAlerts, TSP_DAILY_SIGNAL_FIELDS, type TspDailyIndicatorRow, type TspDailySignalId,
  type TspMonitorAlertRule } from "../../quant/index.ts";
import type { StoredTradingDateBarObservation, TradingDateArchiveRef } from "../../storage/index.ts";
import { digestMonitorEvidence as digest, digestMonitorRule } from "./monitor-alert-identity.ts";
import { resolveTspArchiveIndicators, type DailySignalExchangeRefs } from "./observation-collection.ts";

type BarValues = StoredTradingDateBarObservation["values"];
type DailyField = keyof BarValues | Exclude<keyof TspDailyIndicatorRow, "date">;

export const TSP_DAILY_MONITOR_UNITS = {
  open: "CNY", high: "CNY", low: "CNY", close: "CNY", volume: "hand", amount: "CNY",
  prev_close: "CNY", change_pct: "fraction", change_amount: "CNY", amplitude: "fraction",
  ma5: "CNY", ma10: "CNY", ma20: "CNY", ma30: "CNY", ma60: "CNY",
  ema5: "CNY", ema10: "CNY", ema20: "CNY", ema30: "CNY", ema60: "CNY",
  macd_dif: "CNY", macd_dea: "CNY", macd_hist: "CNY", boll_upper: "CNY", boll_lower: "CNY",
  kdj_k: "oscillator-points", kdj_d: "oscillator-points", kdj_j: "oscillator-points", atr_14: "CNY",
  vol_ma5: "hand", vol_ma10: "hand", vol_ratio_5d: "ratio", high_60d: "CNY", low_60d: "CNY",
  momentum_5d: "fraction", momentum_10d: "fraction", momentum_20d: "fraction", momentum_30d: "fraction",
  momentum_60d: "fraction", annual_vol_20d: "fraction", rsi_6: "oscillator-points", rsi_14: "oscillator-points",
  rsi_24: "oscillator-points",
} as const satisfies Record<DailyField, string>;

export interface DailyMonitorAlertReplayRequest {
  rule: TspMonitorAlertRule;
  adjustment: "none" | "forward";
  sessions: readonly { tradeDate: string; evaluatedAt: number }[];
  roster: readonly string[];
  histories: readonly { symbol: string; ref: TradingDateArchiveRef; exchange?: DailySignalExchangeRefs }[];
}

type ResolvedHistory = Awaited<ReturnType<typeof resolveTspArchiveIndicators>>;
type DailyRow = ResolvedHistory["preview"]["daily"]["rows"][number]["values"];

function dailyValue(field: DailyField, bar: StoredTradingDateBarObservation, daily: DailyRow | undefined) {
  if (field === "amount") return bar.amountUnit === "CNY-thousand" && bar.values.amount !== null ? bar.values.amount * 1000 : null;
  if (field === "volume" || field === "vol_ma5" || field === "vol_ma10") {
    if (bar.volumeUnit !== "hand") return null;
    return field === "volume" ? bar.values.volume : daily?.[field] ?? null;
  }
  if (field === "open" || field === "high" || field === "low" || field === "close") return bar.values[field];
  return daily?.[field] ?? null;
}

/** Evaluate a fixed rule against reconstructed after-close snapshots. */
export async function replayTspDailyMonitorAlerts(request: DailyMonitorAlertReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { rule, adjustment, sessions, roster, histories } = structuredClone(request);
  if (rule?.assetType !== "stock" || (adjustment !== "none" && adjustment !== "forward") ||
    !Array.isArray(sessions) || !sessions.length || !Array.isArray(roster) || !Array.isArray(histories)) {
    throw new Error("Invalid daily monitor rule, scope or price basis");
  }
  for (const [index, session] of (sessions as DailyMonitorAlertReplayRequest["sessions"]).entries()) {
    if (!session || !isDailyDate(session.tradeDate) || (index > 0 && session.tradeDate <= sessions[index - 1]!.tradeDate) ||
      !Number.isSafeInteger(session.evaluatedAt) || session.evaluatedAt < Date.parse(session.tradeDate + "T15:00:00+08:00") ||
      session.evaluatedAt > Date.parse(session.tradeDate + "T23:59:59.999+08:00")) {
      throw new Error("Daily monitor sessions require ordered dates and Shanghai after-close times");
    }
  }
  const rosterIndex = new Map<string, number>(roster.map((symbol, index) => [symbol, index]));
  const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
  if (rosterIndex.size !== roster.length || roster.some(symbol => typeof symbol !== "string" || !stock.test(symbol) || isAIndexSymbol(symbol))) {
    throw new Error("Invalid or duplicate daily monitor roster member");
  }
  if (rule.scope?.kind !== "all" && (!Array.isArray(rule.scope?.symbols) || rule.scope.symbols.some(symbol => !rosterIndex.has(symbol)))) {
    throw new Error("Daily monitor scope must be contained in the supplied roster");
  }
  if (!Array.isArray(rule.conditions) || !rule.conditions.length) throw new Error("Invalid daily monitor conditions");
  const signalFields = new Set<string>(TSP_DAILY_SIGNAL_FIELDS);
  const units: Record<string, string> = {};
  for (const condition of rule.conditions) {
    if (condition?.op === "truth" && signalFields.has(condition.field)) continue;
    if (!condition || condition.op === "truth" || !Object.hasOwn(TSP_DAILY_MONITOR_UNITS, condition.field)) {
      throw new Error("Unsupported daily monitor field or operator");
    }
    const unit = TSP_DAILY_MONITOR_UNITS[condition.field as DailyField];
    if (condition.unit !== unit) throw new Error(`Incompatible daily monitor unit for ${condition.field}`);
    units[condition.field] = unit;
  }
  const fields = [...new Set(rule.conditions.map(condition => condition.field))];
  const resolved = new Map<string, { bars: Map<string, StoredTradingDateBarObservation>; daily: Map<string, DailyRow>;
    signals: Map<string, Record<TspDailySignalId, boolean | null>> }>();
  const evidence = [];
  // A stable order makes capture identities independent of the order of history references.
  for (const history of [...histories as DailyMonitorAlertReplayRequest["histories"]].sort((a, b) =>
    (a?.symbol ?? "").localeCompare(b?.symbol ?? ""))) {
    signal?.throwIfAborted();
    if (!history || !rosterIndex.has(history.symbol) || resolved.has(history.symbol)) {
      throw new Error("Foreign or duplicate daily monitor history");
    }
    const { symbol, ref, exchange } = history;
    const { records, preview } = await resolveTspArchiveIndicators(ref, signal, exchange);
    if (preview.input.symbol !== symbol || preview.input.adjustment !== adjustment || preview.input.lastTradeDate > sessions.at(-1)!.tradeDate) {
      throw new Error("Daily monitor archive has a mismatched symbol, basis or future date");
    }
    resolved.set(symbol, { bars: new Map(records.map(row => [row.tradeDate, row])),
      daily: new Map(preview.daily.rows.map(row => [row.date, row.values])),
      signals: new Map(preview.dailySignals.rows.map(row => [row.date, row.values])) });
    evidence.push({ ref, ...preview.input, volumeUnit: records[0]!.volumeUnit, amountUnit: records[0]!.amountUnit,
      dailyFormula: preview.daily.formula, signalFormula: preview.dailySignals.formula, exchange: preview.dailySignals.exchangeInputs ?? null });
  }

  const revisionInputs = evidence.map(({ symbol, ref, exchange, dailyFormula, signalFormula }) =>
    [symbol, ref.revision, exchange?.raw.ref.revision ?? null, exchange?.limits.ref.revision ?? null, dailyFormula.version, signalFormula.version]);
  const captures = (sessions as DailyMonitorAlertReplayRequest["sessions"]).map(({ tradeDate, evaluatedAt }) => {
    signal?.throwIfAborted();
    const columns = Object.fromEntries(fields.map(field => [field, roster.map(symbol => {
      const history = resolved.get(symbol);
      const bar = history?.bars.get(tradeDate);
      if (!bar) return null;
      return signalFields.has(field) ? history?.signals.get(tradeDate)?.[field as TspDailySignalId] ?? null
        : dailyValue(field as DailyField, bar, history?.daily.get(tradeDate));
    })]));
    return { revision: digest([adjustment, tradeDate, evaluatedAt, roster, revisionInputs]), evaluatedAt, symbols: roster, columns, units };
  });
  const result = computeTspMonitorAlerts({ rule, captures });
  const ruleDigest = digestMonitorRule(rule);
  return { ...result, producer: "whyj" as const, basis: "historical-reconstruction" as const,
    adjustment, rule, ruleDigest, roster, units, histories: evidence,
    evaluations: result.evaluations.map((row, index) => {
      const tradeDate = sessions[index]!.tradeDate;
      return { ...row, tradeDate, missingSymbols: roster.filter(symbol => !resolved.get(symbol)?.bars.has(tradeDate)),
        events: row.events.map(event => {
          const history = resolved.get(event.symbol)!;
          const position = rosterIndex.get(event.symbol)!;
          const { columns } = captures[index]!;
          return { ...event, eventId: digest([result.referenceRevision, result.formulaVersion, ruleDigest, row.captureRevision, event.symbol]),
            closeCny: history.bars.get(tradeDate)!.values.close, changeFraction: history.daily.get(tradeDate)?.change_pct ?? null,
            operands: Object.fromEntries(fields.map(field => [field, columns[field]?.[position] ?? null])) };
        }) };
    }),
  };
}

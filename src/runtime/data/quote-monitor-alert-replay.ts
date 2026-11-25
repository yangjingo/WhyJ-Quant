import { isAIndexSymbol } from "../../market/symbols.ts";
import { computeTspMonitorAlerts, type TspMonitorAlertRule } from "../../quant/index.ts";
import type { SourceRequestOptions } from "../../source/index.ts";
import { loadQuotePollArchive, type QuotePollArchiveRef, type StoredQuotePollCapture } from "../../storage/index.ts";
import { digestMonitorEvidence as digest, digestMonitorRule } from "./monitor-alert-identity.ts";
import { collectQuotePollCapture } from "./quote-poll-replay.ts";

export const TSP_QUOTE_MONITOR_UNITS = {
  price: "CNY", close: "CNY", prev_close: "CNY", change_amount: "CNY", change_pct: "fraction", volume: "hand", amount: "CNY",
} as const;

interface QuoteMonitorScope {
  rule: TspMonitorAlertRule;
  roster: readonly string[];
  maxAgeMs: number;
  priceBasis?: "caller-confirmed-unadjusted-CNY";
  volumeUnit?: "share" | "hand";
  amountUnit?: "CNY" | "CNY-thousand";
}

export interface QuoteMonitorReplayRequest extends QuoteMonitorScope {
  captureRefs: readonly QuotePollArchiveRef[];
}

export interface CurrentQuoteMonitorRequest extends QuoteMonitorScope {
  tradeDate: string;
  priorCaptureRefs?: readonly QuotePollArchiveRef[];
}

type QuoteField = keyof typeof TSP_QUOTE_MONITOR_UNITS;
type QuoteRow = StoredQuotePollCapture["rows"][number];
type FixedCapture = { ref: QuotePollArchiveRef; batch: StoredQuotePollCapture };
const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

function validateQuoteMonitorScope(scope: QuoteMonitorScope) {
  const { rule, roster, maxAgeMs, priceBasis, volumeUnit, amountUnit } = scope;
  if (rule?.assetType !== "stock" || !Array.isArray(roster) || !roster.length || roster.length > 6_999 ||
    new Set(roster).size !== roster.length || roster.some(symbol => typeof symbol !== "string" || !stock.test(symbol) || isAIndexSymbol(symbol)) ||
    !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || (priceBasis !== undefined && priceBasis !== "caller-confirmed-unadjusted-CNY") ||
    (volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw new Error("Invalid quote monitor scope or units");
  // Check the rule before a new collection can make a provider request.
  computeTspMonitorAlerts({ rule, captures: [] });
  const members = new Set(roster);
  if (rule.scope.kind !== "all" && rule.scope.symbols.some(symbol => !members.has(symbol))) {
    throw new Error("Quote monitor scope must be contained in the supplied roster");
  }
  for (const condition of rule.conditions) {
    if (condition.op === "truth" || !Object.hasOwn(TSP_QUOTE_MONITOR_UNITS, condition.field)) throw new Error("Unsupported quote monitor operand");
    if (condition.unit !== TSP_QUOTE_MONITOR_UNITS[condition.field as QuoteField]) throw new Error("Incompatible quote monitor operand unit");
  }
  return [...roster].sort();
}

async function readMonitorCaptures(refs: readonly QuotePollArchiveRef[], roster: readonly string[], signal?: AbortSignal) {
  if (!Array.isArray(refs) || new Set(refs.map(ref => ref?.revision)).size !== refs.length) {
    throw new Error("Invalid or duplicate quote monitor archive references");
  }
  let prior = 0;
  const captures: FixedCapture[] = [];
  for (const ref of refs) {
    signal?.throwIfAborted();
    const batch = await loadQuotePollArchive(ref, signal);
    if (batch.requestedSymbols.length !== roster.length || batch.requestedSymbols.some((symbol, index) => symbol !== roster[index])) {
      throw new Error("Quote monitor archives must use the exact supplied roster");
    }
    const observedAt = Date.parse(batch.observedAt);
    if (observedAt <= prior || Date.parse(batch.startedAt) < prior) throw new Error("Quote monitor captures must be increasing and nonoverlapping");
    prior = observedAt;
    captures.push({ ref, batch });
  }
  return captures;
}

function quoteOperands(row: QuoteRow, scope: QuoteMonitorScope): Record<QuoteField, number | null> {
  const price = scope.priceBasis && row.lastPrice > 0 ? row.lastPrice : null;
  const previousClose = scope.priceBasis && row.previousClose > 0 ? row.previousClose : null;
  const change = price === null || previousClose === null ? null : price - previousClose;
  const fraction = change === null || previousClose === null ? null : change / previousClose;
  const amount = scope.amountUnit && row.amount !== null ? row.amount * (scope.amountUnit === "CNY-thousand" ? 1000 : 1) : null;
  return { price, close: price, prev_close: previousClose, change_amount: change,
    change_pct: fraction !== null && Number.isFinite(fraction) ? fraction : null,
    volume: scope.volumeUnit ? row.volume / (scope.volumeUnit === "share" ? 100 : 1) : null,
    amount: amount !== null && Number.isFinite(amount) ? amount : null };
}

function evaluateMonitorCaptures(scope: QuoteMonitorScope, roster: readonly string[], archives: readonly FixedCapture[], signal?: AbortSignal) {
  const { rule, maxAgeMs } = scope;
  const basis = { price: scope.priceBasis ?? "unknown", volume: scope.volumeUnit ?? "unknown", amount: scope.amountUnit ?? "unknown" };
  const fields = [...new Set(rule.conditions.map(condition => condition.field as QuoteField))];
  const units = Object.fromEntries(fields.map(field => [field, TSP_QUOTE_MONITOR_UNITS[field]]));
  const frames = archives.map(({ ref, batch }) => {
    signal?.throwIfAborted();
    const { rows, ...receipt } = batch;
    const evaluatedAt = Date.parse(batch.observedAt);
    const observed = new Map(rows.map(row => [row.symbol, row]));
    const present = rows.filter(row => evaluatedAt - row.timestamp <= maxAgeMs);
    const fresh = new Map(present.map(row => [row.symbol, quoteOperands(row, scope)]));
    const columns = Object.fromEntries(fields.map(field => [field, roster.map(symbol => fresh.get(symbol)?.[field] ?? null)]));
    return { archive: { ref, ...receipt }, observed, fresh, columns, evaluatedAt,
      revision: digest(["quote-poll", ref.revision, maxAgeMs, basis]) };
  });
  const result = computeTspMonitorAlerts({ rule, captures: frames.map(({ revision, evaluatedAt, columns }) =>
    ({ revision, evaluatedAt, columns, symbols: roster, units })) });
  const ruleDigest = digestMonitorRule(rule);
  return { ...result, producer: "whyj" as const, basis, rule, ruleDigest, maxAgeMs, roster, units,
    evaluations: result.evaluations.map((row, index) => {
      const { archive, observed, fresh } = frames[index]!;
      return { ...row, archive, missingSymbols: roster.filter(symbol => !observed.has(symbol)),
        staleSymbols: roster.filter(symbol => observed.has(symbol) && !fresh.has(symbol)),
        events: row.events.map(event => {
          const observation = observed.get(event.symbol)!;
          const values = fresh.get(event.symbol)!;
          return { ...event, eventId: digest([result.referenceRevision, result.formulaVersion, ruleDigest, row.captureRevision, event.symbol]),
            quoteTimestamp: observation.timestamp, receivedAt: observation.receivedAt, ageMs: row.evaluatedAt - observation.timestamp,
            priceCny: values.price, changeFraction: values.change_pct,
            operands: Object.fromEntries(fields.map(field => [field, values[field]])) };
        }) };
    }),
  };
}

export async function replayTspQuoteMonitorAlerts(request: QuoteMonitorReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const scope = structuredClone(request);
  const roster = validateQuoteMonitorScope(scope);
  const captures = await readMonitorCaptures(scope.captureRefs, roster, signal);
  if (!captures.length) throw new Error("Provide at least one quote monitor capture");
  return evaluateMonitorCaptures(scope, roster, captures, signal);
}

/** Capture one current poll and return the current decisions with an explicit cooldown history. */
export async function collectTspQuoteMonitorAlerts(request: CurrentQuoteMonitorRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  control.signal?.throwIfAborted();
  const scope = structuredClone(request);
  const roster = validateQuoteMonitorScope(scope);
  const priorRefs = scope.priorCaptureRefs === undefined ? [] : scope.priorCaptureRefs;
  const prior = await readMonitorCaptures(priorRefs, roster, control.signal);
  const last = prior.at(-1);
  if (last && Date.parse(last.batch.observedAt) >= Date.now()) throw new Error("Prior quote monitor capture must end before the new poll");
  const capture = await collectQuotePollCapture({ tradeDate: scope.tradeDate, symbols: roster }, control);
  if (last && Date.parse(last.batch.observedAt) > Date.parse(capture.startedAt)) throw new Error("Current quote monitor poll overlaps a prior capture");
  const batch = await loadQuotePollArchive(capture.ref, control.signal);
  const { evaluations, ...report } = evaluateMonitorCaptures(scope, roster, [...prior, { ref: capture.ref, batch }], control.signal);
  return { ...report, capture, priorCaptureRefs: priorRefs, evaluation: evaluations.at(-1)! };
}

import { isDailyDate } from "../../market/bars.ts";
import {
  computeTspDailyLadderFlags, computeTspFactorGroups, computeTspFactorInformation, computeTspResearchFactors,
  tspTradingLimitThresholds, TSP_INDICATOR_REVISION, TSP_RESEARCH_FACTOR_FORMULA_VERSION,
  type TspFactorGroupsInput, type TspFactorInformationRow, type TspFactorRegimeObservation, type TspResearchFactorId,
} from "../../quant/index.ts";
import {
  loadDailyTradingLimitArchive, loadMarketCrossSectionArchive, loadTradingDateArchive, type FinancialObservationArchiveRef,
  type MarketCrossSectionArchiveRef, type StoredTradingDateBarObservation, type TradingDateArchiveRef, type TradingLimitArchiveRef,
} from "../../storage/index.ts";
import { researchFactorBar, researchFinancialReport, type ArchiveAnalyticsSupplements } from "./archive-analytics.ts";
import { replayFinancialResearchInputs } from "./financial-input-replay.ts";
import { replayTspMarketEnvironment, type MarketEnvironmentReplayRequest } from "./market-environment-replay.ts";

export interface FactorEvaluationSymbolInput {
  symbol: string;
  dailyRefs: readonly TradingDateArchiveRef[];
  financialRefs?: readonly FinancialObservationArchiveRef[];
  bookValueBasis?: readonly NonNullable<ArchiveAnalyticsSupplements["bookValueBasis"]>[];
  exchange?: {
    rawRefs?: readonly TradingDateArchiveRef[];
    limitRefs: readonly TradingLimitArchiveRef[];
  };
}

export interface FactorEvaluationReplayRequest {
  factorId: string;
  rebalance: TspFactorGroupsInput["rebalance"];
  sessions: readonly string[];
  evaluationStart?: string;
  symbols: readonly FactorEvaluationSymbolInput[];
  turnoverRefs?: readonly MarketCrossSectionArchiveRef[];
  marketEnvironment?: Omit<MarketEnvironmentReplayRequest, "phaseMode">;
  groups?: Pick<TspFactorGroupsInput, "groupCount" | "weight" | "feesFraction" | "commissionFraction" | "stampTaxFraction" | "slippageBps">;
}

const financialFactors = new Set<string>(["pb_latest", "roe_latest", "gross_margin_latest", "net_margin_latest",
  "revenue_yoy_latest", "net_income_yoy_latest", "debt_ratio_latest"] satisfies TspResearchFactorId[]);

async function readPrices(symbol: string, refs: readonly TradingDateArchiveRef[],
  inScope: (date: string) => boolean, signal?: AbortSignal, raw = false) {
  if (!refs.length) throw new Error("Factor evaluation requires a daily revision for each selected symbol");
  const byDate = new Map<string, StoredTradingDateBarObservation>();
  const evidence = [];
  let basis: Pick<StoredTradingDateBarObservation, "adjustment" | "source"> | undefined;
  for (const ref of refs) {
    const batch = await loadTradingDateArchive(ref, signal);
    const { source, adjustment, observedAt, endpoint, requested, volumeUnit, amountUnit, coverage } = batch[0]!;
    if (batch[0]!.symbol !== symbol || (raw && adjustment !== "none") ||
      (basis && (basis.source !== source || basis.adjustment !== adjustment))) throw new Error("Incompatible factor evaluation price archive");
    basis = { source, adjustment };
    let rowsUsed = 0;
    for (const row of batch) {
      if (!inScope(row.tradeDate)) continue;
      if (byDate.has(row.tradeDate)) throw new Error("Ambiguous factor evaluation price date");
      byDate.set(row.tradeDate, row);
      rowsUsed++;
    }
    evidence.push({ ref, source, endpoint, adjustment, observedAt, requested, volumeUnit, amountUnit, coverage, rowsUsed });
  }
  return { byDate, evidence, adjustment: basis!.adjustment };
}

async function readExchange(symbolInput: FactorEvaluationSymbolInput, prices: Awaited<ReturnType<typeof readPrices>>,
  inScope: (date: string) => boolean, signal?: AbortSignal) {
  if (!symbolInput.exchange) return null;
  const { limitRefs, rawRefs } = symbolInput.exchange;
  if (!limitRefs.length || (prices.adjustment !== "none" && !rawRefs?.length)) {
    throw new Error("Factor limit evidence requires dated limits and unadjusted prices");
  }
  const raw = rawRefs ? await readPrices(symbolInput.symbol, rawRefs, inScope, signal, true) : prices;
  const flags = new Map<string, boolean | null>();
  const limits = [];
  for (const ref of limitRefs) {
    const { symbol, source, endpoint, observedAt, requested, rows } = await loadDailyTradingLimitArchive(ref, signal);
    if (symbol !== symbolInput.symbol) throw new Error("Factor limit archive symbol mismatch");
    for (const row of rows) {
      if (!inScope(row.tradeDate)) continue;
      if (flags.has(row.tradeDate)) throw new Error("Ambiguous factor evaluation limit date");
      const price = raw.byDate.get(row.tradeDate)?.values;
      const thresholds = tspTradingLimitThresholds(row.limitUp, row.limitDown);
      const result = computeTspDailyLadderFlags({ raw_close: price?.close, ...thresholds });
      flags.set(row.tradeDate, result.signal_limit_up);
    }
    limits.push({ ref, source, endpoint, observedAt, requested });
  }
  return { limits, raw: raw.evidence, flags };
}

async function readFactorRegimes(
  request: NonNullable<FactorEvaluationReplayRequest["marketEnvironment"]>,
  evaluationSessions: readonly string[],
  warmUpPredecessor: string | undefined,
  signal?: AbortSignal,
) {
  const first = request.sessions.indexOf(evaluationSessions[0]!);
  const precedingSession = request.sessions[first - 1];
  if (first < 0 || evaluationSessions.some((date, index) => request.sessions[first + index] !== date) ||
    (warmUpPredecessor !== undefined && warmUpPredecessor !== precedingSession)) {
    throw new Error("Market environment calendar does not match factor evaluation");
  }
  const scope = { ...request, phaseMode: "causal" as const };
  const replay = await replayTspMarketEnvironment(scope, signal);
  const firstInput = Math.max(0, first - 1);
  const lastInput = first + evaluationSessions.length - 1;
  const observations = replay.rows.slice(firstInput, lastInput).flatMap(({ tradingDate, regime }): TspFactorRegimeObservation[] =>
    regime?.state == null || regime.score === null ? [] : [{ tradeDate: tradingDate, state: regime.state, score: regime.score }]);
  return { scope, precedingSession, observations };
}

export async function replayTspFactorEvaluation(request: FactorEvaluationReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { factorId, rebalance, sessions, evaluationStart: requestedStart, symbols, turnoverRefs = [], groups,
    marketEnvironment } = structuredClone(request);
  const start = sessions[0], end = sessions.at(-1);
  const evaluationStart = requestedStart ?? start;
  if (!start || !end || sessions.length >= 7000 || sessions.some((date, i) => !isDailyDate(date) || (i > 0 && date <= sessions[i - 1]!)) ||
    typeof factorId !== "string" || !factorId || !["daily", "weekly", "monthly"].includes(rebalance) ||
    !evaluationStart || !sessions.includes(evaluationStart) || !symbols.length || new Set(symbols.map(entry => entry.symbol)).size !== symbols.length) {
    throw new Error("Invalid factor evaluation scope");
  }
  const calendar = new Set(sessions);
  const inScope = (date: string) => {
    if (date < start || date > end) return false;
    if (!calendar.has(date)) throw new Error("Factor evaluation archive contains an off-calendar observation");
    return true;
  };
  const selectedSymbols = new Set(symbols.map(input => input.symbol));
  const turnover = new Map<string, Map<string, number | null>>();
  const turnoverEvidence = [];
  for (const ref of turnoverRefs) {
    const { tradeDate, source, basics } = await loadMarketCrossSectionArchive(ref, signal);
    if (!inScope(tradeDate) || turnover.has(tradeDate)) throw new Error("Ambiguous or incompatible factor turnover date");
    turnover.set(tradeDate, new Map(basics.rows.filter(row => selectedSymbols.has(row.symbol)).map(row => [row.symbol, row.turnoverPct])));
    turnoverEvidence.push({ ref, tradeDate, source, endpoint: basics.endpoint, observedAt: basics.observedAt, coverage: basics.coverage });
  }

  const rows: TspFactorInformationRow[] = [];
  const inputs = [];
  let adjustment: StoredTradingDateBarObservation["adjustment"] | undefined;
  for (const input of symbols) {
    signal?.throwIfAborted();
    const { symbol, dailyRefs, financialRefs = [], bookValueBasis = [] } = input;
    const prices = await readPrices(symbol, dailyRefs, inScope, signal);
    if (!prices.byDate.size || (adjustment && adjustment !== prices.adjustment)) throw new Error("Incompatible factor evaluation price basis");
    adjustment = prices.adjustment;
    const exchange = await readExchange(input, prices, inScope, signal);
    const bars = [...prices.byDate.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)).map(row => {
      const hit = exchange?.flags.get(row.tradeDate);
      return researchFactorBar(row, { turnoverPct: turnover.get(row.tradeDate)?.get(symbol) ?? null,
        consecutiveLimitUps: hit == null ? null : Number(hit) });
    });
    const volumeUnit = prices.evidence[0]!.volumeUnit === "hand" ? "hand" as const : undefined;
    const research = computeTspResearchFactors(bars, { volumeUnit });
    if (!Object.hasOwn(research[0]!.values, factorId)) throw new Error("Unknown TSP research factor");
    const id = factorId as TspResearchFactorId;
    for (const { reportRevision, periodEnd, basis } of bookValueBasis) {
      if (basis !== "caller-confirmed-unadjusted-CNY" || !isDailyDate(periodEnd) ||
        !financialRefs.some(ref => ref.kind === "report-financial-indicators" && ref.revision === reportRevision)) {
        throw new Error("Invalid factor evaluation book-value confirmation");
      }
    }
    const eligibleBars = bars.filter(bar => bar.date >= evaluationStart);
    const financial = financialRefs.length ? await replayFinancialResearchInputs({
      symbol, tradingDates: eligibleBars.map(bar => bar.date), references: financialRefs,
    }, signal) : [];
    const financeByDate = new Map(financial.map(row => [row.tradingDate, row]));
    for (const [index, bar] of bars.entries()) {
      if (bar.date < evaluationStart) continue;
      let factor = research[index]!.values[id];
      const facts = financeByDate.get(bar.date);
      if (facts?.status === "available" && financialFactors.has(id)) {
        const confirmed = adjustment === "none" && bookValueBasis.some(entry => entry.periodEnd === facts.periodEnd &&
          facts.reportEvidence.some(({ ref }) => ref.revision === entry.reportRevision));
        factor = computeTspResearchFactors([bar], {
          volumeUnit, financialReports: [researchFinancialReport(facts, confirmed)],
        })[0]!.values[id];
      }
      rows.push({ symbol, tradeDate: bar.date, close: bar.close, factor });
    }
    inputs.push({ symbol, daily: prices.evidence, financialRefs, bookValueBasis, financial,
      exchange: exchange && { raw: exchange.raw, limits: exchange.limits } });
  }
  signal?.throwIfAborted();
  const evaluationIndex = sessions.indexOf(evaluationStart);
  const evaluationSessions = sessions.slice(evaluationIndex);
  const regimes = marketEnvironment && await readFactorRegimes(marketEnvironment, evaluationSessions, sessions[evaluationIndex - 1], signal);
  signal?.throwIfAborted();
  const panel = { factorId, rebalance, sessions: evaluationSessions, rows };
  return {
    input: { exchangeTimeZone: "Asia/Shanghai" as const, sessions, evaluationStart, adjustment, symbols: inputs, turnover: turnoverEvidence,
      ...(regimes && { marketEnvironment: regimes }) },
    factorFormula: { producer: "whyj" as const, version: TSP_RESEARCH_FACTOR_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    panel,
    information: computeTspFactorInformation(panel, regimes),
    grouping: computeTspFactorGroups({ ...groups, ...panel }),
  };
}

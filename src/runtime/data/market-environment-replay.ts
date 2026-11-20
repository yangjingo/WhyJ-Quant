import { isAIndexSymbol } from "../../market/symbols.ts";
import { computeTspDailyIndicators, computeTspMarketPhaseSeries, computeTspMarketRegime,
  type TspMarketPhaseInput, type TspMarketPhaseMode } from "../../quant/index.ts";
import { loadBenchmarkIndexArchive, loadMarketCrossSectionArchive, loadTradingDateArchive,
  type BenchmarkIndexArchiveRef, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";
import { replayTspMarketLadders, type MarketLadderReplayRequest } from "./market-ladder-replay.ts";

export interface MarketEnvironmentReplayRequest extends MarketLadderReplayRequest {
  priceHistory: readonly { tradeDate: string; refs: readonly TradingDateArchiveRef[] }[];
  benchmark: { symbol: string; refs: readonly BenchmarkIndexArchiveRef[] };
  phaseMode?: TspMarketPhaseMode;
}

async function loadBenchmarkInputs(
  symbol: string, refs: readonly BenchmarkIndexArchiveRef[], dates: ReadonlySet<string>, signal?: AbortSignal,
) {
  const byDate = new Map<string, { ref: BenchmarkIndexArchiveRef; returnPct: number | null }>();
  const evidence = [];
  const seen = new Set<string>();
  if (!isAIndexSymbol(symbol) || !/\.(SH|SZ)$/.test(symbol)) throw new Error("Invalid market environment benchmark");
  for (const ref of refs) {
    const { rows, ...capture } = await loadBenchmarkIndexArchive(ref, signal);
    if (capture.symbol !== symbol || seen.has(ref.revision) ||
      ![...dates].some(date => date >= capture.requested.start && date <= capture.requested.end)) {
      throw new Error("Duplicate or unrelated market environment benchmark archive");
    }
    seen.add(ref.revision);
    for (const { tradeDate, returnPct } of rows) {
      if (!dates.has(tradeDate)) continue;
      if (byDate.has(tradeDate)) throw new Error("Duplicate market environment benchmark observation date");
      byDate.set(tradeDate, { ref, returnPct });
    }
    evidence.push({ ref, ...capture, rowCount: rows.length });
  }
  return { byDate, evidence };
}

export async function* readMarketAdjustedPriceArchives(tradeDate: string, matched: ReadonlySet<string>,
  priceRefs: readonly TradingDateArchiveRef[], signal?: AbortSignal) {
  if (priceRefs.length > matched.size) throw new Error("Too many market environment price archives");
  const seen = new Set<string>();
  for (const archiveRef of priceRefs) {
    const records = await loadTradingDateArchive(archiveRef, signal);
    records.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
    const last = records.at(-1)!;
    const { symbol, adjustment } = last;
    if (!matched.has(symbol) || seen.has(symbol) || last.tradeDate !== tradeDate ||
      last.requested.endDate !== tradeDate || adjustment !== "forward" || last.market !== "A") {
      throw new Error("Incompatible market environment price archive");
    }
    seen.add(symbol);
    yield { archiveRef, records, last };
  }
}

async function marketPriceMetrics(ref: MarketCrossSectionArchiveRef, priceRefs: readonly TradingDateArchiveRef[],
  excluded: ReadonlySet<string>, signal?: AbortSignal) {
  const { tradeDate, universe, bars } = await loadMarketCrossSectionArchive(ref, signal);
  const roster = new Set(universe.members.map(member => member.symbol));
  const matched = new Set(bars.rows.filter(row => roster.has(row.symbol)).map(row => row.symbol));
  const returns: number[] = [];
  let ma20Count = 0, aboveMa20 = 0;
  const priceEvidence = [];
  for await (const { archiveRef, records, last } of readMarketAdjustedPriceArchives(tradeDate, matched, priceRefs, signal)) {
    const { symbol, source, endpoint, observedAt, adjustment, coverage } = last;
    if (excluded.has(symbol)) continue;
    const { change_pct: change, ma20 } = computeTspDailyIndicators(
      records.slice(-20).map(row => ({ date: row.tradeDate, ...row.values })),
    ).at(-1)!;
    if (change !== null && Number.isFinite(change)) returns.push(change);
    if (ma20 !== null && ma20 > 0 && Number.isFinite(ma20)) {
      ma20Count++;
      if (last.values.close > ma20) aboveMa20++;
    }
    priceEvidence.push({ ref: archiveRef, symbol, source, endpoint, observedAt, coverage, adjustment, barCount: records.length });
  }

  for (const symbol of excluded) {
    roster.delete(symbol);
    matched.delete(symbol);
  }
  returns.sort((left, right) => left - right);
  const count = returns.length;
  const lower = returns[Math.floor((count - 1) / 2)];
  const upper = returns[Math.floor(count / 2)];
  const strongDown = returns.filter(value => value <= -0.03).length;
  const strongUp = returns.filter(value => value >= 0.03).length;
  return {
    metrics: {
      upFraction: count ? returns.filter(value => value > 0).length / matched.size : null,
      averageFraction: count ? returns.reduce((sum, value) => sum + value / count, 0) : null,
      medianFraction: lower === undefined || upper === undefined ? null : lower / 2 + upper / 2,
      strongDifferenceFraction: count ? (strongUp - strongDown) / matched.size : null,
      strongDownFraction: count ? strongDown / matched.size : null,
      aboveMa20Fraction: ma20Count ? aboveMa20 / ma20Count : null,
    },
    evidence: { rowCount: matched.size, missingBars: roster.size - matched.size, returnCount: count, ma20Count, aboveMa20, prices: priceEvidence },
  };
}

/** Replay the pinned environment formulas on the exact captured stock universe. */
export async function replayTspMarketEnvironment(request: MarketEnvironmentReplayRequest, signal?: AbortSignal) {
  const filterRiskWarnings = request.riskWarningRefs !== undefined;
  const priceHistory = request.priceHistory.map(({ tradeDate, refs }) => ({ tradeDate, refs: refs.map(ref => ({ ...ref })) }));
  const benchmark = { symbol: request.benchmark.symbol, refs: request.benchmark.refs.map(ref => ({ ...ref })) };
  const mode = request.phaseMode ?? "causal";
  if (mode !== "causal" && mode !== "retrospective-tsp") throw new Error("Invalid market phase mode");
  const ladders = await replayTspMarketLadders(request, signal);
  const rowsByDate = new Map(ladders.rows.map(row => [row.tradingDate, row]));
  const pricesByDate = new Map<string, TradingDateArchiveRef[]>();
  for (const { tradeDate, refs } of priceHistory) {
    if (!rowsByDate.get(tradeDate)?.market || pricesByDate.has(tradeDate)) {
      throw new Error("Duplicate or unrelated market environment price history date");
    }
    pricesByDate.set(tradeDate, refs);
  }
  const index = await loadBenchmarkInputs(benchmark.symbol, benchmark.refs, new Set(ladders.calendar.sessions), signal);
  const phaseInput: TspMarketPhaseInput[] = [];
  const rows = [];
  for (const row of ladders.rows) {
    signal?.throwIfAborted();
    const { tradingDate, market, metrics: ladder, riskWarnings } = row;
    const excluded = new Set(riskWarnings?.status === "matched" ? riskWarnings.excludedSymbols : []);
    const available = market && riskWarnings?.status !== "missing";
    const price = available ? await marketPriceMetrics(market.ref, pricesByDate.get(tradingDate) ?? [], excluded, signal) : null;
    const indexRow = index.byDate.get(tradingDate) ?? null;
    const completeLimitUps = ladder && ladder.coverage.roster > 0 && ladder.coverage.limitUpsKnown === ladder.coverage.roster;
    const regime = available && (!filterRiskWarnings || (ladder?.coverage.roster ?? 0) > 0) ? computeTspMarketRegime(tradingDate, {
      ...price?.metrics,
      limitUpCount: completeLimitUps ? ladder.seal.observedLimitUps : null,
      sealFraction: ladder?.seal.regimeFraction ?? null,
      maxStreak: ladder?.ladder?.height ?? null,
      indexChangeFraction: indexRow?.returnPct == null ? null : indexRow.returnPct / 100,
    }) : null;
    phaseInput.push({ tradingDate, state: regime?.state ?? null, height: ladder?.ladder?.height ?? null,
      firstBoardCount: ladder?.ladder?.firstBoardCount ?? null, twoOrMoreCount: ladder?.ladder?.twoOrMoreCount ?? null,
      promotionFraction: ladder?.promotion.fraction ?? null,
      sealFraction: ladder?.seal.fraction ?? (ladder?.seal.basis === "regime-zero-events-default" ? 0.5 : null) });
    rows.push({ tradingDate, regime, ladder, inputs: { market, prices: price?.evidence ?? null, benchmark: indexRow,
      ...(riskWarnings ? { riskWarnings } : {}) } });
  }
  const phases = computeTspMarketPhaseSeries(phaseInput, mode);
  return {
    producer: "whyj" as const, calendar: ladders.calendar,
    universe: filterRiskWarnings ? "exclude-observed-risk-warnings" as const : "captured-market-roster" as const,
    inputs: { tradingLimits: ladders.input.tradingLimits, benchmark: { symbol: benchmark.symbol, archives: index.evidence } },
    phase: { mode, formula: phases.formula },
    rows: rows.map((row, index) => ({ ...row, phase: phases.rows[index]! })),
  };
}

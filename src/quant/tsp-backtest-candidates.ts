import { isDailyDate } from "../market/bars.ts";
import { normalizeSymbol } from "../market/symbols.ts";
import { finiteStatistic, mean, roundDecimalTiesToEven as round, sampleDeviation } from "./statistics.ts";
import { computeTspBacktestRobustness } from "./tsp-backtest-robustness.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_BACKTEST_CANDIDATE_FORMULA_VERSION = "tsp-backtest-candidate-execution-v1";

export interface TspBacktestCandidateInput {
  candidateCount: number;
  trades: readonly { symbol: string; exitDate: string; pnlFraction: number; holdingDays: number }[];
  execution: Readonly<Record<string, number>>;
  includeMonteCarlo?: boolean;
}

// NumPy linspace constructs the interior edges in this operation order.
const histogramEdges = Array.from({ length: 21 }, (_, i) => i === 20 ? 0.2 : i * (0.4 / 20) - 0.2);
const histogramUpperEdges = histogramEdges.slice(1, -1);

function returnDistribution(returns: number[]) {
  const counts = Array<number>(20).fill(0);
  for (const value of returns) {
    const bin = histogramUpperEdges.findIndex(upper => value < upper);
    const index = bin === -1 ? counts.length - 1 : bin;
    counts[index] = counts[index]! + 1;
  }
  return counts.map((count, index) => ({
    lowerFraction: histogramEdges[index]!,
    upperFraction: histogramEdges[index + 1]!,
    count,
    ratio: round(count / returns.length),
  }));
}

export function computeTspBacktestCandidates(input: TspBacktestCandidateInput) {
  const { candidateCount, trades, execution, includeMonteCarlo = true } = input;
  if (!Array.isArray(trades) || !Number.isSafeInteger(candidateCount) || candidateCount < trades.length ||
    !execution || typeof execution !== "object" || Array.isArray(execution) || typeof includeMonteCarlo !== "boolean") {
    throw new Error("Invalid independent candidate backtest evidence");
  }
  const counters = Object.entries(execution);
  if (counters.some(([name, count]) => !/^[a-z][a-z0-9_]*$/.test(name) || !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Invalid candidate execution counter");
  }
  const evidence = {
    producer: "whyj" as const,
    formulaVersion: TSP_BACKTEST_CANDIDATE_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    basis: "independent-exits" as const,
    candidateCount,
    tradeCount: trades.length,
    execution: Object.fromEntries(counters),
  };
  if (!trades.length) return { ...evidence, status: "unavailable" as const, reason: "no-executable-trades" as const };

  const byExit = new Map<string, number[]>();
  const bySymbol = new Map<string, number[]>();
  const returns: number[] = [], wins: number[] = [], nonWins: number[] = [];
  for (const trade of trades) {
    if (!trade || typeof trade.symbol !== "string" || normalizeSymbol(trade.symbol) !== trade.symbol ||
      typeof trade.exitDate !== "string" || trade.exitDate < "0001-01-01" || !isDailyDate(trade.exitDate) ||
      !Number.isFinite(trade.pnlFraction) || trade.pnlFraction < -1 ||
      !Number.isSafeInteger(trade.holdingDays) || trade.holdingDays < 0) {
      throw new Error("Invalid candidate trade observation");
    }
    const { symbol, exitDate, pnlFraction } = trade;
    const exits = byExit.get(exitDate) ?? [];
    exits.push(pnlFraction);
    byExit.set(exitDate, exits);
    const symbolReturns = bySymbol.get(symbol) ?? [];
    symbolReturns.push(pnlFraction);
    bySymbol.set(symbol, symbolReturns);
    returns.push(pnlFraction);
    (pnlFraction > 0 ? wins : nonWins).push(pnlFraction);
  }

  const dailyReturns: number[] = [];
  const curve = [];
  let equity = 1, chartPeak = 1, summaryPeak = 0;
  let maxDrawdown: number | null = 0;
  for (const exitDate of [...byExit.keys()].sort()) {
    const observations = byExit.get(exitDate)!;
    const averageReturn = mean(observations);
    dailyReturns.push(averageReturn);
    equity = finiteStatistic(equity * (1 + averageReturn));
    const value = round(equity);
    chartPeak = Math.max(chartPeak, equity);
    summaryPeak = Math.max(summaryPeak, value);
    // The summary starts at the first rounded curve point. The chart starts at one.
    maxDrawdown = summaryPeak > 0 && maxDrawdown !== null ? Math.min(maxDrawdown, value / summaryPeak - 1) : null;
    curve.push({ exitDate, tradeCount: observations.length, averageReturn, value, drawdown: round((equity - chartPeak) / chartPeak) });
  }
  const deviation = sampleDeviation(dailyReturns);
  const { sortino, perTrade, monteCarlo } = computeTspBacktestRobustness({ trades, periodicReturns: dailyReturns, includeMonteCarlo });
  const averageLoss = nonWins.length ? Math.abs(mean(nonWins)) : 0;
  const perSymbol = [...bySymbol].map(([symbol, observations]) => {
    let value = 1, winCount = 0, best = -1, worst = Infinity;
    for (const pnl of observations) {
      value = finiteStatistic(value * (1 + pnl));
      winCount += Number(pnl > 0);
      best = Math.max(best, pnl);
      worst = Math.min(worst, pnl);
    }
    return { symbol, tradeCount: observations.length, totalReturn: round(value - 1),
      winRate: round(winCount / observations.length), best: round(best), worst: round(worst) };
  }).sort((left, right) => right.totalReturn - left.totalReturn);
  return {
    ...evidence,
    status: "available" as const,
    exitDayCount: curve.length,
    averageDailyCandidates: round(trades.length / curve.length, 1),
    averageReturn: round(mean(returns)),
    medianReturn: perTrade.medianPnl,
    winRate: round(wins.length / returns.length),
    profitFactor: averageLoss > 0 ? round((wins.length ? mean(wins) : 0) / averageLoss, 2) : null,
    best: perTrade.best,
    worst: perTrade.worst,
    averageHoldingDays: perTrade.avgHoldingDays,
    totalReturn: round(curve.at(-1)!.value - 1),
    maxDrawdown: maxDrawdown === null ? null : round(maxDrawdown),
    sharpe: deviation > 0 ? round(mean(dailyReturns) / deviation * Math.sqrt(252), 2) : 0,
    sortino,
    curve,
    perSymbol,
    returnDistribution: returnDistribution(returns),
    ...(monteCarlo && { monteCarlo }),
  };
}

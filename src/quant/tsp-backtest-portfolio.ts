import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, mean, roundDecimalTiesToEven as round, sampleDeviation } from "./statistics.ts";
import { computeTspBacktestRobustness, type TspBacktestRobustnessInput } from "./tsp-backtest-robustness.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_BACKTEST_PORTFOLIO_FORMULA_VERSION = "tsp-backtest-portfolio-v1";
const periodsPerYear = 252;

export interface TspBacktestPortfolioInput {
  initialCapital: number;
  /** One marked portfolio value and observed exposure per included trading date. */
  equityCurve: readonly { date: string; equity: number; exposureFraction: number }[];
  trades: TspBacktestRobustnessInput["trades"];
  includeMonteCarlo?: boolean;
}

export function computeTspBacktestPortfolio(input: TspBacktestPortfolioInput) {
  const { initialCapital, equityCurve, trades, includeMonteCarlo = true } = input;
  if (!Number.isFinite(initialCapital) || initialCapital <= 0 || !Array.isArray(equityCurve) ||
    !Array.isArray(trades) || typeof includeMonteCarlo !== "boolean") {
    throw new Error("Invalid portfolio backtest evidence");
  }
  if (trades.some(trade => !trade || !Number.isFinite(trade.pnlFraction) ||
    (trade.holdingDays !== null && (!Number.isSafeInteger(trade.holdingDays) || trade.holdingDays < 0)))) {
    throw new Error("Invalid realized trade observation");
  }

  const evidence = {
    producer: "whyj" as const,
    formulaVersion: TSP_BACKTEST_PORTFOLIO_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    periodsPerYear,
    equitySamples: equityCurve.length,
    tradeSamples: trades.length,
  };
  if (!equityCurve.length) return { ...evidence, status: "unavailable" as const, reason: "empty-equity-curve" as const };

  const returns: number[] = [];
  const exposures: number[] = [];
  let previousDate = "";
  let previousEquity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxExposure = 0;
  for (const [index, sample] of equityCurve.entries()) {
    if (!sample || typeof sample.date !== "string" || !isDailyDate(sample.date) || sample.date <= previousDate ||
      !Number.isFinite(sample.equity) || sample.equity < 0 ||
      (sample.equity === 0 && (index === 0 || index < equityCurve.length - 1)) ||
      !Number.isFinite(sample.exposureFraction) || sample.exposureFraction < 0) {
      throw new Error("Invalid or unordered portfolio equity observation");
    }
    if (previousDate) returns.push(finiteStatistic(sample.equity / previousEquity - 1));
    previousDate = sample.date;
    previousEquity = sample.equity;
    peak = Math.max(peak, sample.equity);
    maxDrawdown = Math.min(maxDrawdown, sample.equity / peak - 1);
    exposures.push(sample.exposureFraction);
    maxExposure = Math.max(maxExposure, sample.exposureFraction);
  }

  const totalReturn = finiteStatistic(previousEquity / initialCapital - 1);
  const annualReturn = (1 + totalReturn) ** (periodsPerYear / equityCurve.length) - 1;
  const deviation = sampleDeviation(returns);
  const sharpe = deviation > 0 ? mean(returns) / deviation * Math.sqrt(periodsPerYear) : 0;
  const { sortino, perTrade, monteCarlo } = computeTspBacktestRobustness({
    trades, periodicReturns: returns, periodsPerYear, includeMonteCarlo,
  });
  const pnls = trades.map(trade => trade.pnlFraction);
  const wins = pnls.filter(pnl => pnl > 0);
  const nonWins = pnls.filter(pnl => pnl <= 0);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = nonWins.length ? Math.abs(mean(nonWins)) : 0;

  return {
    ...evidence,
    status: "available" as const,
    firstDate: equityCurve[0]!.date,
    lastDate: previousDate,
    portfolio: {
      initialCapital: round(initialCapital, 2),
      finalEquity: round(previousEquity, 2),
      totalReturn: round(totalReturn),
      annualReturn: round(annualReturn),
      maxDrawdown: round(maxDrawdown),
      sharpe: round(sharpe, 2),
      sortino,
      calmar: Math.abs(maxDrawdown) > 0.001 ? round(annualReturn / Math.abs(maxDrawdown), 2) : 0,
      avgExposure: round(mean(exposures)),
      maxExposure: round(maxExposure),
    },
    realizedTrades: {
      ...perTrade,
      winRate: pnls.length ? round(wins.length / pnls.length) : 0,
      avgPnl: pnls.length ? round(mean(pnls)) : 0,
      avgWin: round(avgWin),
      avgLoss: round(avgLoss),
      profitFactor: avgLoss > 0 ? round(avgWin / avgLoss, 2) : null,
    },
    ...(monteCarlo && { monteCarlo }),
  };
}

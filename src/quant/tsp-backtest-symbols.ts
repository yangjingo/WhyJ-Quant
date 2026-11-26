import { finiteStatistic, roundDecimalTiesToEven as round } from "./statistics.ts";

/** Groups contain realized return fractions in execution order. */
export function summarizeTspBacktestSymbols(bySymbol: ReadonlyMap<string, readonly number[]>) {
  return [...bySymbol].map(([symbol, observations]) => {
    let equity = 1, wins = 0, best = -Infinity, worst = Infinity;
    for (const pnl of observations) {
      equity = finiteStatistic(equity * (1 + pnl));
      wins += Number(pnl > 0);
      best = Math.max(best, pnl);
      worst = Math.min(worst, pnl);
    }
    return { symbol, tradeCount: observations.length, totalReturn: round(equity - 1),
      winRate: round(wins / observations.length), best: round(best), worst: round(worst) };
  }).sort((left, right) => right.totalReturn - left.totalReturn);
}

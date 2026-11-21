import { mean, rootMeanSquare, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_BACKTEST_ROBUSTNESS_FORMULA_VERSION = "tsp-trade-robustness-v1";

export interface TspBacktestRobustnessInput {
  trades: readonly { pnlFraction: number; holdingDays: number | null }[];
  /** Periodic returns from the equity curve, excluding the initial equity snapshot. */
  periodicReturns?: readonly number[];
  periodsPerYear?: number;
  includeMonteCarlo?: boolean;
}

const seed = 42;
const uint32Mask = 0xffff_ffffn;

/** NumPy PCG64's initial state for seed 42 and its bounded uint32 sampler. */
function numpyTradeIndex(length: number) {
  let state = 274674114334540486603088602300644985544n;
  const increment = 332724090758049132448979897138935081983n;
  const multiplier = 47026247687942121848144207491837523525n;
  const bound = BigInt(length);
  const threshold = (1n << 32n) % bound;
  let upper: bigint | undefined;
  function uint32(): bigint {
    if (upper !== undefined) {
      const next = upper;
      upper = undefined;
      return next;
    }
    state = BigInt.asUintN(128, state * multiplier + increment);
    const xorshifted = BigInt.asUintN(64, (state >> 64n) ^ state);
    const rotation = state >> 122n;
    const value = BigInt.asUintN(64, (xorshifted >> rotation) | (xorshifted << (64n - rotation)));
    upper = value >> 32n;
    return value & uint32Mask;
  }
  return () => {
    let product: bigint;
    do { product = uint32() * bound; } while ((product & uint32Mask) < threshold);
    return Number(product >> 32n);
  };
}

function percentile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const weight = index - lower;
  return weight === 0 ? sorted[lower]! : (1 - weight) * sorted[lower]! + weight * sorted[lower + 1]!;
}

function bootstrapDrawdown(pnls: number[]) {
  const metadata = { sampler: "numpy-pcg64" as const, seed, sampleCount: pnls.length };
  if (pnls.length < 3) return { ...metadata, simulations: 0, drawdownP50: null, drawdownP95: null };
  const simulations = Math.min(1000, Math.max(200, Math.floor(2_000_000 / pnls.length)));
  if (pnls.every(pnl => pnl >= 0)) return { ...metadata, simulations, drawdownP50: 0, drawdownP95: 0 };
  const sample = numpyTradeIndex(pnls.length);
  const logReturns = pnls.map(pnl => Math.log1p(Math.max(-0.9999, pnl)));
  const drawdowns = new Array<number>(simulations);
  for (let simulation = 0; simulation < simulations; simulation++) {
    // TSP starts tracking the peak at the first simulated post-trade equity.
    let equity = logReturns[sample()]!;
    let high = equity;
    let worst = 0;
    for (let trade = 1; trade < pnls.length; trade++) {
      equity += logReturns[sample()]!;
      high = Math.max(high, equity);
      worst = Math.min(worst, equity - high);
    }
    drawdowns[simulation] = Math.expm1(worst);
  }
  drawdowns.sort((left, right) => left - right);
  return { ...metadata, simulations, drawdownP50: roundDecimalTiesToEven(percentile(drawdowns, 0.5)),
    drawdownP95: roundDecimalTiesToEven(percentile(drawdowns, 0.05)) };
}

export function computeTspBacktestRobustness(input: TspBacktestRobustnessInput) {
  const { trades, periodicReturns, periodsPerYear = 252, includeMonteCarlo = true } = input;
  if (!Array.isArray(trades) || (periodicReturns !== undefined && !Array.isArray(periodicReturns)) ||
    !Number.isSafeInteger(periodsPerYear) || periodsPerYear <= 0 || typeof includeMonteCarlo !== "boolean") {
    throw new Error("Invalid backtest robustness scope");
  }
  const pnls: number[] = [];
  const durations: number[] = [];
  for (const trade of trades) {
    if (!trade || typeof trade.pnlFraction !== "number" ||
      (trade.holdingDays !== null && typeof trade.holdingDays !== "number") ||
      (Number.isFinite(trade.holdingDays) && (!Number.isSafeInteger(trade.holdingDays) || trade.holdingDays! < 0))) {
      throw new Error("Invalid realized trade observation");
    }
    if (Number.isFinite(trade.pnlFraction)) pnls.push(trade.pnlFraction);
    if (trade.holdingDays !== null && Number.isFinite(trade.holdingDays)) durations.push(trade.holdingDays);
  }
  if (periodicReturns?.some(value => typeof value !== "number")) throw new Error("Invalid periodic return observation");
  const returns = periodicReturns === undefined ? pnls : periodicReturns.filter(Number.isFinite);
  const downside = returns.length >= 2 ? rootMeanSquare(returns.map(value => Math.min(value, 0))) : 0;
  const sortino = downside > 0 ? roundDecimalTiesToEven(mean(returns) / downside * Math.sqrt(periodsPerYear), 2)
    : returns.length < 2 ? 0 : null;
  const sorted = pnls.toSorted((left, right) => left - right);
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_BACKTEST_ROBUSTNESS_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    sortino,
    sortinoBasis: periodicReturns === undefined ? "realized-trades" as const : "periodic-returns" as const,
    periodsPerYear,
    returnSamples: returns.length,
    perTrade: { tradeSamples: pnls.length, durationSamples: durations.length,
      best: roundDecimalTiesToEven(sorted.at(-1) ?? 0),
      worst: roundDecimalTiesToEven(sorted[0] ?? 0),
      medianPnl: pnls.length ? roundDecimalTiesToEven(percentile(sorted, 0.5)) : 0,
      avgHoldingDays: pnls.length && durations.length ? roundDecimalTiesToEven(mean(durations), 1) : 0 },
    ...(includeMonteCarlo && { monteCarlo: bootstrapDrawdown(pnls) }),
  };
}

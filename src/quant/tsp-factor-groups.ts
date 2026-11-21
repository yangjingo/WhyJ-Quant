import { mean, sampleDeviation, finiteStatistic } from "./statistics.ts";
import {
  averageTspFactorRanks, prepareTspFactorPanel, roundTspFactorStatistic, tspFactorCrossSection,
  tspFactorForwardReturn, type TspFactorInformationInput,
} from "./tsp-factor-information.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_FACTOR_GROUPS_FORMULA_VERSION = "tsp-factor-v2-groups-v1";

export interface TspFactorGroupsInput extends TspFactorInformationInput {
  groupCount?: number;
  weight?: "equal" | "factor_weight";
  feesFraction?: number;
  commissionFraction?: number | null;
  stampTaxFraction?: number;
  slippageBps?: number;
}

interface Holding {
  symbol: string;
  outcome: number;
  weight: number;
}

interface ObservedGroup {
  netReturn: number;
  weights: Map<string, number>;
}

interface ObservedPeriod {
  tradeDate: string;
  outcomeDate: string;
  groups: Map<number, ObservedGroup>;
}

function roundTripCost(input: TspFactorGroupsInput): number {
  const { feesFraction = 0.0002, commissionFraction, stampTaxFraction = 0, slippageBps = 5 } = input;
  const commission = commissionFraction ?? feesFraction;
  if ([feesFraction, commission, stampTaxFraction, slippageBps].some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("Factor group costs must be finite and nonnegative");
  }
  return finiteStatistic(2 * commission + stampTaxFraction + 2 * (slippageBps / 10_000));
}

function drawdown(nav: number[]): number {
  let peak = 1, worst = 0;
  for (const value of nav) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, (value - peak) / peak);
  }
  return worst;
}

function zeroTargetSharpe(returns: number[], frequency: number, minimumDeviation: number): number {
  const deviation = sampleDeviation(returns);
  return deviation > minimumDeviation ? (mean(returns) / deviation) * Math.sqrt(frequency) : 0;
}

function groupReturns(nav: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < nav.length; i++) {
    const previous = nav[i - 1]!;
    if (previous > 0) returns.push(finiteStatistic(nav[i]! / previous - 1));
  }
  return returns;
}

function turnover(periods: ObservedPeriod[], top: number): number {
  const changes: number[] = [];
  let previous: Map<string, number> | undefined;
  for (const period of periods) {
    const current = period.groups.get(top)?.weights;
    if (!current) continue;
    if (previous) {
      let distance = 0;
      for (const [symbol, weight] of previous) distance += Math.abs(weight - (current.get(symbol) ?? 0));
      for (const [symbol, weight] of current) if (!previous.has(symbol)) distance += weight;
      changes.push(0.5 * distance);
    }
    previous = current;
  }
  return changes.length ? mean(changes) : 0;
}

function theoreticalSpread(periods: ObservedPeriod[], top: number[], bottom: number[], frequency: number, cost: number) {
  let cumulative = 1, previousTop = 1, previousBottom = 1;
  const returns: number[] = [];
  const balances = periods.map((_period, i) => {
    const topReturn = previousTop > 0 ? top[i]! / previousTop - 1 : 0;
    const bottomReturn = previousBottom > 0 ? bottom[i]! / previousBottom - 1 : 0;
    previousTop = top[i]!;
    previousBottom = bottom[i]!;
    const spread = finiteStatistic((topReturn - bottomReturn) / 2 - cost);
    returns.push(spread);
    cumulative = finiteStatistic(cumulative * (1 + spread));
    return cumulative;
  });
  return {
    totalReturn: roundTspFactorStatistic(cumulative - 1),
    maxDrawdown: roundTspFactorStatistic(drawdown(balances)),
    sharpe: roundTspFactorStatistic(zeroTargetSharpe(returns, frequency, 1e-8)),
    nav: periods.map(({ tradeDate, outcomeDate }, i) => ({ tradeDate, outcomeDate, value: roundTspFactorStatistic(balances[i]!) })),
  };
}

export function computeTspFactorGroups(input: TspFactorGroupsInput) {
  const { groupCount = 5, weight = "equal", factorId, rebalance, sessions } = input;
  if (!Number.isSafeInteger(groupCount) || groupCount < 1 || (weight !== "equal" && weight !== "factor_weight")) {
    throw new Error("Invalid factor grouping parameters");
  }
  const cost = roundTripCost(input);
  const { panel, targets } = prepareTspFactorPanel(input);
  const observedGroups = new Set<number>();
  const periods: ObservedPeriod[] = [];
  for (const [start, end] of targets) {
    const { factors } = tspFactorCrossSection(panel[start]!);
    const ranks = averageTspFactorRanks(factors.map(row => row.factor));
    const holdings = new Map<number, Holding[]>();
    factors.forEach((row, i) => {
      const outcome = tspFactorForwardReturn(row, panel[end]!);
      if (outcome === null) return;
      const rank = ranks[i]!;
      const bucket = Math.min(groupCount, Math.floor((rank - 1) * groupCount / factors.length) + 1);
      const size = weight === "factor_weight" ? Math.abs(rank - (factors.length + 1) / 2) + 0.5 : 1;
      if (!holdings.has(bucket)) holdings.set(bucket, []);
      holdings.get(bucket)!.push({ symbol: row.symbol, outcome, weight: size });
    });
    if (!holdings.size) continue;
    const groups = new Map<number, ObservedGroup>();
    for (const [bucket, positions] of holdings) {
      const totalWeight = positions.reduce((sum, position) => sum + position.weight, 0);
      const weights = new Map(positions.map(position => [position.symbol, position.weight / totalWeight]));
      const gross = positions.reduce((total, position) => total + position.outcome * weights.get(position.symbol)!, 0);
      groups.set(bucket, { netReturn: finiteStatistic(gross - cost), weights });
      observedGroups.add(bucket);
    }
    periods.push({ tradeDate: sessions[start]!, outcomeDate: sessions[end]!, groups });
  }

  const buckets = [...observedGroups].sort((left, right) => left - right);
  const running = new Map(buckets.map(bucket => [bucket, 1]));
  const navByBucket = new Map(buckets.map(bucket => [bucket, [] as number[]]));
  const groupNav = periods.map(({ tradeDate, outcomeDate, groups }) => ({
    tradeDate, outcomeDate,
    groups: buckets.map(bucket => {
      const netReturn = groups.get(bucket)?.netReturn ?? null;
      const nav = finiteStatistic(running.get(bucket)! * (1 + (netReturn ?? 0)));
      running.set(bucket, nav);
      navByBucket.get(bucket)!.push(nav);
      return { label: "Q" + bucket, netReturn, value: roundTspFactorStatistic(nav) };
    }),
  }));

  const years = Math.max((Date.parse(sessions.at(-1)!) - Date.parse(sessions[0]!)) / 86_400_000 / 365.25, 0.01);
  const frequency = { daily: 252, weekly: 52, monthly: 12 }[rebalance];
  const groupStats = buckets.map((bucket, i) => {
    const values = navByBucket.get(bucket)!;
    const last = values.at(-1)!;
    const returns = groupReturns(values);
    return {
      group: i + 1, label: "Q" + bucket,
      totalReturn: roundTspFactorStatistic(last - 1),
      annualReturn: roundTspFactorStatistic(last > 0 ? last ** (1 / years) - 1 : 0),
      maxDrawdown: roundTspFactorStatistic(drawdown(values)),
      sharpe: roundTspFactorStatistic(zeroTargetSharpe(returns, frequency, 0), 2),
      winRate: returns.length ? roundTspFactorStatistic(returns.filter(value => value > 0).length / returns.length) : 0,
    };
  });
  const top = buckets.at(-1), bottom = buckets[0];
  const longShort = top !== undefined && bottom !== undefined && top !== bottom
    ? {
      topGroup: "Q" + top, bottomGroup: "Q" + bottom, portfolioType: "theoretical_factor_spread" as const, executableShort: false as const,
      ...theoreticalSpread(periods, navByBucket.get(top)!, navByBucket.get(bottom)!, frequency, cost),
    }
    : null;
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_FACTOR_GROUPS_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    factorId, rebalance, groupCount, weight, roundTripCost: cost,
    groupNav, groupStats, turnover: top === undefined ? null : roundTspFactorStatistic(turnover(periods, top)),
    longShort,
  };
}

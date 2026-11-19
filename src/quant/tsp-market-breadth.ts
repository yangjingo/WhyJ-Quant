import { isDailyDate } from "../market/bars.ts";

export const TSP_MARKET_BREADTH_FORMULA_VERSION = 1;

export interface TspBreadthUniverse {
  id: string;
  revision: string;
  tradingDate: string;
  symbols: readonly string[];
}

export interface TspBreadthMemberObservation {
  tradingDate: string;
  symbol: string;
  name: string | null;
  close: number | null;
  changeFraction: number | null;
  volumeShares: number | null;
  amountCny: number | null;
  turnoverPct: number | null;
  volumeRatio5d: number | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  high60d: number | null;
  low60d: number | null;
  newHighSignal: boolean | null;
  newLowSignal: boolean | null;
}

const bands = [
  ["<-5%", null, -0.05],
  ["-5~-3%", -0.05, -0.03],
  ["-3~-1%", -0.03, -0.01],
  ["-1~0%", -0.01, 0],
  ["0~1%", 0, 0.01],
  ["1~3%", 0.01, 0.03],
  ["3~5%", 0.03, 0.05],
  [">5%", 0.05, null],
] as const;

function proportion(count: number, denominator: number) {
  return { count, denominator, fraction: denominator > 0 ? count / denominator : null };
}

function measuredRate(values: readonly (boolean | null)[]) {
  return proportion(values.filter(value => value === true).length, values.filter(value => value !== null).length);
}

function statistics(values: readonly number[]) {
  const total = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  if (total !== null && !Number.isFinite(total)) throw new Error("Market breadth aggregate exceeds numeric range");
  return { total, average: total === null ? null : total / values.length, denominator: values.length };
}

const known = (value: number | null): value is number => value !== null;
const stockSymbol = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

function compare(close: number | null, reference: number | null, direction: "up" | "down"): boolean | null {
  if (close === null || reference === null) return null;
  return direction === "up" ? close >= reference : close <= reference;
}

function validObservation(row: TspBreadthMemberObservation): boolean {
  return [row.close, row.ma5, row.ma20, row.ma60, row.high60d, row.low60d]
    .every(value => value === null || (Number.isFinite(value) && value > 0))
    && [row.volumeShares, row.amountCny, row.turnoverPct, row.volumeRatio5d]
      .every(value => value === null || (Number.isFinite(value) && value >= 0))
    && (row.changeFraction === null || (Number.isFinite(row.changeFraction) && row.changeFraction >= -1))
    && [row.newHighSignal, row.newLowSignal].every(value => value === null || typeof value === "boolean")
    && (row.name === null || typeof row.name === "string");
}

/** Aggregate a caller-supplied dated cross-section and report how many inputs each result used. */
export function computeTspMarketBreadth(universe: TspBreadthUniverse, observations: readonly TspBreadthMemberObservation[]) {
  const { id, revision, tradingDate, symbols } = universe;
  const members = new Set(symbols);
  if (!id.trim() || !revision.trim() || !isDailyDate(tradingDate) || members.size !== symbols.length ||
    symbols.some(symbol => !stockSymbol.test(symbol))) throw new Error("Invalid market breadth universe");

  const seen = new Set<string>();
  const eligible: TspBreadthMemberObservation[] = [];
  let suspendedByRule = 0;
  for (const row of observations) {
    if (row.tradingDate !== tradingDate || !members.has(row.symbol) || seen.has(row.symbol) || !validObservation(row)) {
      throw new Error("Invalid market breadth member observation");
    }
    seen.add(row.symbol);
    if ((row.volumeShares !== null && row.volumeShares > 0) || (row.changeFraction !== null && row.changeFraction !== 0)) {
      eligible.push(row);
    } else if (row.volumeShares === 0 && row.changeFraction === 0) {
      suspendedByRule++;
    }
  }

  const changes = eligible.map(row => row.changeFraction).filter(known).sort((left, right) => left - right);
  const breadth = {
    observedReturns: changes.length,
    up: proportion(changes.filter(value => value > 0).length, changes.length),
    down: proportion(changes.filter(value => value < 0).length, changes.length),
    flat: proportion(changes.filter(value => value === 0).length, changes.length),
    strongUp: proportion(changes.filter(value => value >= 0.03).length, changes.length),
    strongDown: proportion(changes.filter(value => value <= -0.03).length, changes.length),
    average: statistics(changes).average,
    median: changes[Math.floor(changes.length / 2)] ?? null,
  };
  const distribution = bands.map(([label, lower, upper]) => ({
    label, lower, upper,
    ...proportion(changes.filter(value => (lower === null || value >= lower) && (upper === null || value < upper)).length, changes.length),
  }));
  const trend = {
    aboveMa5: measuredRate(eligible.map(row => compare(row.close, row.ma5, "up"))),
    aboveMa20: measuredRate(eligible.map(row => compare(row.close, row.ma20, "up"))),
    aboveMa60: measuredRate(eligible.map(row => compare(row.close, row.ma60, "up"))),
    newHigh: measuredRate(eligible.map(row => row.newHighSignal === true ? true : compare(row.close, row.high60d, "up"))),
    newLow: measuredRate(eligible.map(row => row.newLowSignal === true ? true : compare(row.close, row.low60d, "down"))),
  };
  const ranked = (key: "changeFraction" | "amountCny" | "turnoverPct", direction: 1 | -1) =>
    eligible.flatMap(row => {
      const value = row[key];
      return value === null ? [] : [{ symbol: row.symbol, name: row.name, close: row.close, changeFraction: row.changeFraction, value }];
    }).sort((left, right) => direction * (left.value - right.value) || left.symbol.localeCompare(right.symbol)).slice(0, 8);

  return {
    tradingDate, universe: { id, revision },
    coverage: {
      members: members.size, observed: seen.size, missing: members.size - seen.size,
      eligible: eligible.length, excludedBySuspensionRule: suspendedByRule, unknownEligibility: seen.size - eligible.length - suspendedByRule,
    },
    breadth, distribution, trend,
    amount: statistics(eligible.map(row => row.amountCny).filter(known)),
    activity: {
      turnover: statistics(eligible.map(row => row.turnoverPct).filter(known)),
      volumeRatio: statistics(eligible.map(row => row.volumeRatio5d).filter(known)),
      highTurnover: measuredRate(eligible.map(row => row.turnoverPct === null ? null : row.turnoverPct >= 5)),
      highVolume: measuredRate(eligible.map(row => row.volumeRatio5d === null ? null : row.volumeRatio5d >= 1.5)),
    },
    leaders: {
      gainers: ranked("changeFraction", -1), losers: ranked("changeFraction", 1),
      amount: ranked("amountCny", -1), turnover: ranked("turnoverPct", -1),
    },
  };
}

export type TspMarketBreadth = ReturnType<typeof computeTspMarketBreadth>;

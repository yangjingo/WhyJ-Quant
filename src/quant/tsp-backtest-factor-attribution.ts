import { isDailyDate } from "../market/bars.ts";
import { normalizeSymbol } from "../market/symbols.ts";
import { finiteStatistic, mean, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_BACKTEST_FACTOR_ATTRIBUTION_FORMULA_VERSION = "tsp-backtest-entry-factor-attribution-v1";

export interface TspBacktestFactorAttributionInput {
  factors: readonly string[];
  snapshots: readonly {
    symbol: string;
    tradeDate: string;
    values: Readonly<Record<string, number | null>>;
  }[];
  trades: readonly {
    symbol: string;
    entrySignalDate?: string | null;
    entryDate: string | null;
    pnlFraction: number;
  }[];
}

const validDate = (date: unknown): date is string => typeof date === "string" && date >= "0001-01-01" && isDailyDate(date);
const validSymbol = (symbol: unknown): symbol is string => typeof symbol === "string" && normalizeSymbol(symbol) === symbol;
const key = (symbol: string, tradeDate: string) => `${symbol}:${tradeDate}`;

export function computeTspBacktestFactorAttribution(input: TspBacktestFactorAttributionInput) {
  const { factors, snapshots, trades } = input;
  if (!Array.isArray(factors) || !Array.isArray(snapshots) || !Array.isArray(trades) ||
    factors.some(factor => typeof factor !== "string" || !factor.trim() || factor.trim() !== factor)) {
    throw new Error("Invalid backtest factor attribution evidence");
  }

  const groups = new Map<string, { wins: number[]; nonWins: number[] }>();
  for (const factor of factors) {
    if (groups.has(factor)) throw new Error("Duplicate backtest attribution factor");
    groups.set(factor, { wins: [], nonWins: [] });
  }

  const observations = new Map<string, Readonly<Record<string, number | null>>>();
  const snapshotRows: TspBacktestFactorAttributionInput["snapshots"] = snapshots;
  for (const snapshot of snapshotRows) {
    if (!snapshot || !validSymbol(snapshot.symbol) || !validDate(snapshot.tradeDate) ||
      !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values) ||
      Object.entries(snapshot.values).some(([name, value]) => !groups.has(name) || (value !== null && !Number.isFinite(value)))) {
      throw new Error("Invalid signal-day factor snapshot");
    }
    const id = key(snapshot.symbol, snapshot.tradeDate);
    if (observations.has(id)) throw new Error("Duplicate signal-day factor snapshot");
    observations.set(id, snapshot.values);
  }

  let winTrades = 0, nonWinTrades = 0, undatedTrades = 0, matchedTrades = 0;
  for (const trade of trades) {
    if (!trade || !validSymbol(trade.symbol) || !Number.isFinite(trade.pnlFraction) || trade.pnlFraction < -1 ||
      (trade.entrySignalDate != null && !validDate(trade.entrySignalDate)) ||
      (trade.entryDate !== null && !validDate(trade.entryDate)) ||
      (trade.entrySignalDate != null && trade.entryDate !== null && trade.entrySignalDate > trade.entryDate)) {
      throw new Error("Invalid backtest attribution trade");
    }
    const date = trade.entrySignalDate ?? trade.entryDate;
    if (date === null) {
      undatedTrades++;
      continue;
    }
    const win = trade.pnlFraction > 0;
    if (win) winTrades++;
    else nonWinTrades++;
    const values = observations.get(key(trade.symbol, date));
    if (!values) continue;
    matchedTrades++;
    for (const [name, value] of Object.entries(values)) {
      if (value === null) continue;
      const group = groups.get(name)!;
      (win ? group.wins : group.nonWins).push(value);
    }
  }

  const metrics = [];
  for (const [factor, { wins, nonWins }] of groups) {
    if (!wins.length && !nonWins.length) continue;
    const winMean = wins.length ? roundDecimalTiesToEven(mean(wins), 6) : null;
    const nonWinMean = nonWins.length ? roundDecimalTiesToEven(mean(nonWins), 6) : null;
    metrics.push({ factor, winMean, nonWinMean, winSamples: wins.length, nonWinSamples: nonWins.length,
      difference: winMean === null || nonWinMean === null ? null : finiteStatistic(winMean - nonWinMean) });
  }

  return {
    producer: "whyj" as const,
    formulaVersion: TSP_BACKTEST_FACTOR_ATTRIBUTION_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    status: metrics.length ? "available" as const : "unavailable" as const,
    coverage: { trades: trades.length, matchedTrades, undatedTrades, winTrades, nonWinTrades },
    factors: metrics,
  };
}

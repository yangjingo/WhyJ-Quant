import { isDailyDate } from "../market/bars.ts";
import { normalizeSymbol } from "../market/symbols.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_BACKTEST_DAILY_TRADES_FORMULA_VERSION = "tsp-backtest-daily-trades-v1";

export interface TspBacktestDailyTradesInput {
  currency: "CNY";
  trades: readonly {
    symbol: string;
    entryDate: string;
    exitDate: string;
    entryValue: number | null;
    exitValue: number | null;
    pnlAmount: number | null;
  }[];
}

type TradeReference = { tradeIndex: number; symbol: string };
type AmountSamples = { observed: number; sum: number };
type DailyTrades = {
  buys: TradeReference[];
  sells: TradeReference[];
  buyValue: AmountSamples;
  sellValue: AmountSamples;
  realizedPnl: AmountSamples;
};

const validDate = (value: unknown): value is string =>
  typeof value === "string" && value >= "0001-01-01" && isDailyDate(value);

function collectAmount(samples: AmountSamples, value: number | null) {
  if (value === null) return;
  samples.sum = finiteStatistic(samples.sum + value);
  samples.observed++;
}

export function computeTspBacktestDailyTrades(input: TspBacktestDailyTradesInput) {
  if (input.currency !== "CNY" || !Array.isArray(input.trades)) throw new Error("Invalid daily backtest trade evidence");
  const trades: TspBacktestDailyTradesInput["trades"] = input.trades;
  const days = new Map<string, DailyTrades>();
  const getDay = (date: string) => {
    const observed = days.get(date);
    if (observed) return observed;
    const created: DailyTrades = {
      buys: [], sells: [],
      buyValue: { observed: 0, sum: 0 },
      sellValue: { observed: 0, sum: 0 },
      realizedPnl: { observed: 0, sum: 0 },
    };
    days.set(date, created);
    return created;
  };

  for (const [tradeIndex, trade] of trades.entries()) {
    if (!trade || typeof trade.symbol !== "string" || normalizeSymbol(trade.symbol) !== trade.symbol ||
      !validDate(trade.entryDate) || !validDate(trade.exitDate) || trade.entryDate > trade.exitDate ||
      (trade.entryValue !== null && (!Number.isFinite(trade.entryValue) || trade.entryValue < 0)) ||
      (trade.exitValue !== null && (!Number.isFinite(trade.exitValue) || trade.exitValue < 0)) ||
      (trade.pnlAmount !== null && !Number.isFinite(trade.pnlAmount))) {
      throw new Error("Invalid daily backtest trade evidence");
    }
    const reference = { symbol: trade.symbol, tradeIndex };
    const entry = getDay(trade.entryDate);
    entry.buys.push(reference);
    collectAmount(entry.buyValue, trade.entryValue);

    const exit = getDay(trade.exitDate);
    exit.sells.push(reference);
    collectAmount(exit.sellValue, trade.exitValue);
    collectAmount(exit.realizedPnl, trade.pnlAmount);
  }

  let cumulativePnl: number | null = 0;
  const rows = [...days.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, row]) => {
    const { buys, sells, buyValue, sellValue, realizedPnl } = row;
    const dailyPnl = realizedPnl.observed === sells.length ? realizedPnl.sum : null;
    cumulativePnl = cumulativePnl !== null && dailyPnl !== null ? finiteStatistic(cumulativePnl + dailyPnl) : null;
    return {
      date, buys, sells, buyCount: buys.length, sellCount: sells.length,
      buyValue: buyValue.observed === buys.length ? buyValue.sum : null,
      sellValue: sellValue.observed === sells.length ? sellValue.sum : null,
      realizedPnl: dailyPnl, cumulativePnl,
      observedBuyValues: buyValue.observed,
      observedSellValues: sellValue.observed,
      observedRealizedPnl: realizedPnl.observed,
    };
  }).reverse();

  return {
    producer: "whyj" as const,
    formulaVersion: TSP_BACKTEST_DAILY_TRADES_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    currency: input.currency,
    tradeCount: trades.length,
    rows,
  };
}

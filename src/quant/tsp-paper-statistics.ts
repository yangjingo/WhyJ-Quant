import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, mean, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_PAPER_STATISTICS_FORMULA_VERSION = "tsp-paper-statistics-v1";

export interface TspPaperFill {
  fillId: string;
  tradeDate: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  currency: string;
}

export interface TspPaperNavRow {
  tradeDate: string;
  nav: number;
  currency: string;
}

export interface TspPaperStatisticsInput {
  accountId: string;
  currency: string;
  fills: readonly TspPaperFill[];
  finalizedNav: readonly TspPaperNavRow[];
}

interface OpenLot {
  fillId: string;
  tradeDate: string;
  quantity: number;
  cost: number;
}

const roundMoney = (value: number) => roundDecimalTiesToEven(value, 2);
// Preserve the reference's two-decimal percentage as a four-decimal fraction.
const roundFraction = (value: number) => roundDecimalTiesToEven(roundDecimalTiesToEven(value * 100, 2) / 100, 4);
const dayMs = 86_400_000;

export function computeTspPaperStatistics(input: TspPaperStatisticsInput) {
  const { accountId, currency, fills, finalizedNav } = input;
  if (typeof accountId !== "string" || !accountId.trim() || typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) || !Array.isArray(fills) || !Array.isArray(finalizedNav)) {
    throw new Error("Invalid paper statistics scope");
  }
  const lots = new Map<string, { entries: OpenLot[]; head: number }>();
  const fillIds = new Set<string>();
  let previousFillDate = "";
  const roundTrips = [];
  for (const fill of fills as readonly TspPaperFill[]) {
    if (!fill || typeof fill.fillId !== "string" || !fill.fillId.trim() || fillIds.has(fill.fillId) ||
      typeof fill.symbol !== "string" || !fill.symbol.trim() || !isDailyDate(fill.tradeDate) || fill.tradeDate < previousFillDate ||
      (fill.side !== "buy" && fill.side !== "sell") || fill.currency !== currency ||
      !Number.isSafeInteger(fill.quantity) || fill.quantity <= 0 || !Number.isFinite(fill.price) || fill.price <= 0 ||
      !Number.isFinite(fill.fee) || fill.fee < 0) throw new Error("Invalid or out-of-order paper fill");
    fillIds.add(fill.fillId);
    previousFillDate = fill.tradeDate;
    const { fillId, tradeDate, symbol, side, quantity, price, fee } = fill;
    const pool = lots.get(symbol) ?? { entries: [], head: 0 };
    if (side === "buy") {
      pool.entries.push({ fillId, tradeDate, quantity, cost: finiteStatistic(price * quantity + fee) });
      lots.set(symbol, pool);
      continue;
    }
    let remaining = quantity;
    const netProceedsPerShare = price - fee / quantity;
    while (remaining > 0) {
      const lot = pool.entries[pool.head];
      if (!lot) throw new Error("Paper sale has no matching earlier buy quantity");
      const matched = Math.min(lot.quantity, remaining);
      const cost = finiteStatistic(lot.cost * matched / lot.quantity);
      const pnl = netProceedsPerShare * matched - cost;
      roundTrips.push({
        symbol, buyFillId: lot.fillId, sellFillId: fillId, openDate: lot.tradeDate, closeDate: tradeDate, quantity: matched,
        pnl: roundMoney(pnl), pnlFraction: cost ? roundFraction(pnl / cost) : 0,
        holdingDays: (Date.parse(tradeDate) - Date.parse(lot.tradeDate)) / dayMs,
      });
      lot.quantity -= matched;
      lot.cost -= cost;
      if (lot.quantity === 0) pool.head++;
      remaining -= matched;
    }
    if (pool.head === pool.entries.length) lots.delete(symbol);
  }

  let previousNavDate = "", peak: number | null = null, drawdownFraction: number | null = null, positiveNavRows = 0;
  for (const row of finalizedNav as readonly TspPaperNavRow[]) {
    if (!row || row.currency !== currency || !isDailyDate(row.tradeDate) || row.tradeDate <= previousNavDate ||
      !Number.isFinite(row.nav)) throw new Error("Invalid or out-of-order finalized paper NAV row");
    previousNavDate = row.tradeDate;
    if (row.nav <= 0) continue;
    positiveNavRows++;
    peak = Math.max(peak ?? row.nav, row.nav);
    drawdownFraction = Math.max(drawdownFraction ?? 0, (peak - row.nav) / peak);
  }

  const wins = roundTrips.filter(round => round.pnl > 0).map(round => round.pnl);
  const losses = roundTrips.filter(round => round.pnl <= 0).map(round => round.pnl);
  const averageLoss = losses.length ? Math.abs(mean(losses)) : 0;
  const averageWin = wins.length ? mean(wins) : 0;
  return {
    producer: "whyj" as const, formulaVersion: TSP_PAPER_STATISTICS_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    accountId, currency,
    roundTrips,
    summary: {
      roundTripCount: roundTrips.length, winningRoundTrips: wins.length,
      winRateFraction: roundTrips.length ? roundFraction(wins.length / roundTrips.length) : 0,
      profitLossRatio: averageLoss ? roundMoney(averageWin / averageLoss) : null,
      averageHoldingDays: roundTrips.length ? roundDecimalTiesToEven(mean(roundTrips.map(round => round.holdingDays)), 1) : 0,
      realizedPnl: roundMoney(roundTrips.reduce((sum, round) => sum + round.pnl, 0)),
      maxDrawdownFraction: drawdownFraction === null ? null : roundFraction(drawdownFraction),
      fillCount: fills.length, navRows: finalizedNav.length, positiveNavRows,
    },
  };
}

import { isDailyDate } from "../market/bars.ts";
import { roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspPaperNavRow } from "./tsp-paper-statistics.ts";

export const TSP_PAPER_VALUATION_FORMULA_VERSION = "tsp-paper-valuation-v1";

export interface TspPaperPositionObservation {
  symbol: string;
  assetType: "stock" | "etf";
  currency: string;
  quantity: number;
  averageCost: number;
  availableQuantity: number;
}

export interface TspPaperPriceMark {
  symbol: string;
  currency: string;
  tradeDate: string;
  basis: "snapshot" | "finalized";
  adjustment: "none";
  source: string;
  revision: string;
  price: number;
}

export interface TspPaperValuationInput {
  accountId: string;
  tradeDate: string;
  currency: string;
  cash: number;
  initialCash: number;
  basis: TspPaperPriceMark["basis"];
  positions: readonly TspPaperPositionObservation[];
  marks: readonly TspPaperPriceMark[];
  finalizedNav?: readonly TspPaperNavRow[];
}

const roundMoney = (value: number) => roundDecimalTiesToEven(value, 2);
const roundFraction = (value: number) => roundDecimalTiesToEven(roundDecimalTiesToEven(value * 100, 2) / 100, 4);

export function computeTspPaperValuation(input: TspPaperValuationInput) {
  const { accountId, tradeDate, currency, cash, initialCash, basis, positions, marks, finalizedNav = [] } = input;
  if (typeof accountId !== "string" || !accountId.trim() || !isDailyDate(tradeDate) || typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(cash) || !Number.isFinite(initialCash) || initialCash < 0 ||
    (basis !== "snapshot" && basis !== "finalized") || !Array.isArray(positions) || !Array.isArray(marks) || !Array.isArray(finalizedNav)) {
    throw new Error("Invalid paper valuation scope");
  }

  const marksBySymbol = new Map<string, TspPaperPriceMark>();
  for (const mark of marks as readonly TspPaperPriceMark[]) {
    if (!mark || typeof mark.symbol !== "string" || !mark.symbol.trim() || marksBySymbol.has(mark.symbol) ||
      mark.currency !== currency || mark.tradeDate !== tradeDate || mark.basis !== basis || mark.adjustment !== "none" ||
      typeof mark.source !== "string" || !mark.source.trim() || typeof mark.revision !== "string" || !mark.revision.trim() ||
      !Number.isFinite(mark.price) || mark.price <= 0) throw new Error("Invalid paper valuation price mark");
    marksBySymbol.set(mark.symbol, mark);
  }

  const symbols = new Set<string>();
  const holdings = [];
  const costFallbackSymbols: string[] = [];
  let marketValue = 0;
  for (const position of positions as readonly TspPaperPositionObservation[]) {
    if (!position || typeof position.symbol !== "string" || !position.symbol.trim() || symbols.has(position.symbol) ||
      (position.assetType !== "stock" && position.assetType !== "etf") || position.currency !== currency ||
      !Number.isFinite(position.quantity) || position.quantity < 0 || !Number.isFinite(position.averageCost) || position.averageCost < 0 ||
      !Number.isSafeInteger(position.availableQuantity) || position.availableQuantity < 0 || position.availableQuantity > position.quantity) {
      throw new Error("Invalid paper valuation position");
    }
    symbols.add(position.symbol);
  }
  for (const { symbol, assetType, quantity, averageCost, availableQuantity } of (positions as readonly TspPaperPositionObservation[])
    .toSorted((left, right) => left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0)) {
    if (quantity === 0) continue;
    const mark = marksBySymbol.get(symbol);
    const price = mark?.price ?? averageCost;
    if (!mark) costFallbackSymbols.push(symbol);
    marketValue += quantity * price;
    holdings.push({
      symbol, assetType, quantity, averageCost, availableQuantity,
      lastPrice: roundDecimalTiesToEven(price, 4),
      marketValue: roundMoney(quantity * price),
      unrealizedPnl: roundMoney(quantity * (price - averageCost)),
      unrealizedPnlFraction: averageCost ? roundFraction(price / averageCost - 1) : 0,
      priceBasis: mark ? "market-mark" as const : "average-cost" as const,
      mark: mark ? { source: mark.source, revision: mark.revision, tradeDate, basis, adjustment: mark.adjustment, currency, price } : null,
    });
  }

  let previousDate = "";
  for (const row of finalizedNav as readonly TspPaperNavRow[]) {
    if (!row || row.currency !== currency || !isDailyDate(row.tradeDate) || row.tradeDate <= previousDate ||
      row.tradeDate > tradeDate || !Number.isFinite(row.nav)) throw new Error("Invalid finalized paper valuation NAV");
    previousDate = row.tradeDate;
  }
  const previousNav = finalizedNav.at(-2), latestNav = finalizedNav.at(-1);
  const finalizedNavReturn = previousNav && latestNav && previousNav.nav > 0 ? {
    startDate: previousNav.tradeDate, endDate: latestNav.tradeDate, returnFraction: roundFraction(latestNav.nav / previousNav.nav - 1),
  } : null;

  const rawEquity = cash + marketValue;
  const totalPnl = roundMoney(rawEquity - initialCash);
  return {
    producer: "whyj" as const, formulaVersion: TSP_PAPER_VALUATION_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    accountId, tradeDate, currency, basis,
    cash: roundMoney(cash), initialCash, marketValue: roundMoney(marketValue), equity: roundMoney(rawEquity), totalPnl,
    totalPnlFraction: initialCash ? roundFraction(totalPnl / initialCash) : null,
    holdings,
    coverage: { holdings: holdings.length, marketMarks: holdings.length - costFallbackSymbols.length, costFallbackSymbols },
    finalizedNavRows: finalizedNav.length,
    latestFinalizedNavDate: latestNav?.tradeDate ?? null,
    finalizedNavReturn,
  };
}

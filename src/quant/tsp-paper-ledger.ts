import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic, roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspPaperFill } from "./tsp-paper-statistics.ts";
import type { TspPaperPositionObservation } from "./tsp-paper-valuation.ts";

export const TSP_PAPER_LEDGER_FORMULA_VERSION = "tsp-paper-ledger-v1";

export type TspPaperLedgerEntry =
  | (Omit<TspPaperFill, "fillId"> & { entryId: string; kind: "fill"; assetType: TspPaperPositionObservation["assetType"] })
  | { entryId: string; kind: "corp_action"; tradeDate: string; symbol: string; factor: number };

export interface TspPaperLedgerInput {
  accountId: string;
  currency: string;
  initialCash: number;
  asOf: string;
  entries: readonly TspPaperLedgerEntry[];
}

interface PaperLot {
  tradeDate: string;
  quantity: number;
}

interface PaperPosition {
  assetType: TspPaperPositionObservation["assetType"];
  quantity: number;
  averageCost: number;
  lots: PaperLot[];
}

const hasId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const roundPosition = (value: number) => roundDecimalTiesToEven(value, 6);
const lotEpsilon = 1e-9;

export function replayTspPaperLedger({ accountId, currency, initialCash, asOf, entries }: TspPaperLedgerInput) {
  if (!hasId(accountId) || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) ||
    !Number.isFinite(initialCash) || initialCash < 0 || !isDailyDate(asOf) || !Array.isArray(entries)) {
    throw new Error("Invalid paper ledger scope");
  }

  const held = new Map<string, PaperPosition>();
  const identities = new Set<string>();
  let cash = initialCash, previousDate = "";
  for (const entry of entries as readonly TspPaperLedgerEntry[]) {
    if (!entry || !hasId(entry.entryId) || identities.has(entry.entryId) || !hasId(entry.symbol) ||
      !isDailyDate(entry.tradeDate) || entry.tradeDate < previousDate || entry.tradeDate > asOf) {
      throw new Error("Invalid or out-of-order paper ledger entry");
    }
    identities.add(entry.entryId);
    previousDate = entry.tradeDate;
    const existing = held.get(entry.symbol);
    if (entry.kind === "corp_action") {
      if (!Number.isFinite(entry.factor) || entry.factor <= 0) throw new Error("Invalid paper share adjustment");
      if (existing) {
        existing.quantity = roundPosition(existing.quantity * entry.factor);
        existing.averageCost = roundPosition(existing.averageCost / entry.factor);
        for (const lot of existing.lots) lot.quantity = roundPosition(lot.quantity * entry.factor);
      }
      continue;
    }
    if (entry.kind !== "fill" || entry.currency !== currency || (entry.assetType !== "stock" && entry.assetType !== "etf") ||
      (existing && existing.assetType !== entry.assetType) || (entry.side !== "buy" && entry.side !== "sell") ||
      !Number.isSafeInteger(entry.quantity) || entry.quantity <= 0 || !Number.isFinite(entry.price) || entry.price <= 0 ||
      !Number.isFinite(entry.fee) || entry.fee < 0) {
      throw new Error("Invalid paper ledger fill");
    }
    const gross = finiteStatistic(entry.quantity * entry.price);
    if (entry.side === "buy") {
      const pos = existing ?? { assetType: entry.assetType, quantity: 0, averageCost: 0, lots: [] };
      const totalCost = finiteStatistic(pos.averageCost * pos.quantity + gross + entry.fee);
      pos.quantity += entry.quantity;
      pos.averageCost = roundPosition(totalCost / pos.quantity);
      pos.lots.push({ tradeDate: entry.tradeDate, quantity: entry.quantity });
      held.set(entry.symbol, pos);
      cash = finiteStatistic(cash - (gross + entry.fee));
      continue;
    }

    if (!existing) throw new Error("Paper ledger sale has no matched holdings");
    let remaining = entry.quantity;
    for (const lot of existing.lots) {
      if (remaining <= lotEpsilon) break;
      const matched = Math.min(lot.quantity, remaining);
      lot.quantity -= matched;
      remaining -= matched;
    }
    if (remaining > lotEpsilon) throw new Error("Paper ledger sale exceeds matched holdings");
    existing.lots = existing.lots.filter(lot => lot.quantity > lotEpsilon);
    existing.quantity = Math.max(0, existing.quantity - entry.quantity);
    if (!existing.quantity) existing.averageCost = 0;
    cash = finiteStatistic(cash + (gross - entry.fee));
  }

  const positions: TspPaperPositionObservation[] = [], lots: { symbol: string; entries: PaperLot[] }[] = [];
  for (const symbol of [...held.keys()].sort()) {
    const pos = held.get(symbol)!;
    if (pos.quantity <= 0) continue;
    const earlierQuantity = pos.lots.reduce((sum, lot) => lot.tradeDate < asOf ? sum + lot.quantity : sum, 0);
    const availableQuantity = Math.trunc(Math.min(earlierQuantity, pos.quantity));
    if (!Number.isSafeInteger(Math.ceil(pos.quantity)) || !Number.isSafeInteger(availableQuantity)) {
      throw new Error("Paper ledger quantity exceeds the supported range");
    }
    positions.push({ symbol, currency, assetType: pos.assetType, quantity: pos.quantity, averageCost: pos.averageCost, availableQuantity });
    lots.push({ symbol, entries: pos.lots });
  }
  return {
    producer: "whyj" as const,
    formulaVersion: TSP_PAPER_LEDGER_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    accountId, currency, asOf, initialCash, cash: roundDecimalTiesToEven(cash, 2), positions, lots, entryCount: entries.length,
  };
}

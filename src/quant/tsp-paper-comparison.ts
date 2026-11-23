import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import { computeTspPaperStatistics, type TspPaperFill, type TspPaperNavRow } from "./tsp-paper-statistics.ts";
import { computeTspPaperValuation, type TspPaperPriceMark, type TspPaperValuationInput } from "./tsp-paper-valuation.ts";

export const TSP_PAPER_COMPARISON_FORMULA_VERSION = "tsp-paper-comparison-v1";

export interface TspPaperComparisonAccount extends Pick<TspPaperValuationInput, "accountId" | "cash" | "initialCash" | "positions"> {
  name?: string;
  status: "active" | "frozen";
  fills: readonly TspPaperFill[];
  finalizedNav: readonly TspPaperNavRow[];
  finalizedMarks: readonly TspPaperPriceMark[];
  snapshotMarks?: readonly TspPaperPriceMark[];
}

export interface TspPaperComparisonInput {
  tradeDate: string;
  currency: string;
  accounts: readonly TspPaperComparisonAccount[];
}

export function computeTspPaperComparison({ tradeDate, currency, accounts }: TspPaperComparisonInput) {
  if (!isDailyDate(tradeDate) || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || !Array.isArray(accounts)) {
    throw new Error("Invalid paper comparison scope");
  }
  const seen = new Set<string>();
  const rows = (accounts as readonly TspPaperComparisonAccount[]).map(account => {
    if (!account || typeof account.accountId !== "string" || !account.accountId.trim() || seen.has(account.accountId) ||
      (account.name !== undefined && (typeof account.name !== "string" || !account.name.trim())) ||
      (account.status !== "active" && account.status !== "frozen") ||
      (account.snapshotMarks !== undefined && (account.status !== "active" || !Array.isArray(account.snapshotMarks))) ||
      !Array.isArray(account.fills) || account.fills.some(fill => fill?.tradeDate > tradeDate)) {
      throw new Error("Invalid paper comparison account");
    }
    const { accountId, name, status, positions, cash, initialCash, fills, finalizedNav, finalizedMarks, snapshotMarks } = account;
    seen.add(accountId);
    const scope = { accountId, tradeDate, currency, positions, cash, initialCash, finalizedNav };
    const statistics = computeTspPaperStatistics({ accountId, currency, fills, finalizedNav });
    const finalized = computeTspPaperValuation({ ...scope, basis: "finalized", marks: finalizedMarks });
    const snapshot = snapshotMarks === undefined ? null : computeTspPaperValuation({ ...scope, basis: "snapshot", marks: snapshotMarks });
    const anchor = finalizedNav[0] ?? null;
    const divisor = anchor === null ? null : (anchor.nav || 1);
    const nav = divisor === null ? [] : finalizedNav.map(({ tradeDate, nav }) =>
      ({ tradeDate, nav, normalizedNav: Number(finiteStatistic(nav / divisor).toFixed(4)) }));
    return {
      accountId, name: name ?? accountId, status, finalized, snapshot,
      statistics: { formulaVersion: statistics.formulaVersion, ...statistics.summary },
      navAnchor: anchor && { tradeDate: anchor.tradeDate, nav: anchor.nav, divisor },
      nav,
    };
  });
  return {
    producer: "whyj" as const, formulaVersion: TSP_PAPER_COMPARISON_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    tradeDate, currency, accounts: rows,
  };
}

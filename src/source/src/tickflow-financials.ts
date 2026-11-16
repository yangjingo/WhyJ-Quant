import { validateDateRange } from "../../market/bars.ts";
import { request, symbolsFor, type TickFlowOptions } from "./tickflow.ts";
import type { FinancialRecord, FinancialRequest } from "./market-data.ts";

const paths = { income: "income", "balance-sheet": "balance-sheet", "cash-flow": "cash-flow", metrics: "metrics", shares: "shares" } as const;
const fields: Record<FinancialRequest["kind"], readonly string[]> = {
  income: ["revenue", "operating_cost", "total_operating_cost", "operating_profit", "total_profit", "net_income", "net_income_attributable", "net_income_deducted", "basic_eps", "diluted_eps", "admin_expense", "selling_expense", "financial_expense", "rd_expense", "income_tax", "non_operating_income", "non_operating_expense"],
  "balance-sheet": ["total_assets", "total_current_assets", "total_non_current_assets", "cash_and_equivalents", "accounts_receivable", "inventory", "fixed_assets", "intangible_assets", "goodwill", "total_liabilities", "total_current_liabilities", "total_non_current_liabilities", "accounts_payable", "short_term_borrowing", "long_term_borrowing", "total_equity", "equity_attributable", "minority_interest", "retained_earnings"],
  "cash-flow": ["net_operating_cash_flow", "net_investing_cash_flow", "net_financing_cash_flow", "net_cash_change", "capex"],
  metrics: ["bps", "debt_to_asset_ratio", "eps_basic", "eps_diluted", "gross_margin", "inventory_turnover", "net_income_yoy", "net_margin", "ocfps", "operating_cash_to_revenue", "revenue_yoy", "roa", "roe", "roe_diluted"],
  shares: ["float_shares", "total_shares"],
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { validateDateRange(value, value); return true; } catch { return false; }
}
export async function fetchTickFlowFinancials(input: FinancialRequest, options: TickFlowOptions): Promise<FinancialRecord[]> {
  if (!input || !Object.hasOwn(paths, input.kind) || (input.latest !== undefined && typeof input.latest !== "boolean")) throw new Error("Invalid financial request");
  validateDateRange(input.startDate, input.endDate);
  const symbols = symbolsFor(input.symbols), endpoint = paths[input.kind];
  const payload = await request(`/v1/financials/${endpoint}`, { symbols: symbols.join(","),
    ...(input.startDate ? { start_date: input.startDate } : {}), ...(input.endDate ? { end_date: input.endDate } : {}),
    ...(input.latest === undefined ? {} : { latest: String(input.latest) }) }, options);
  if (!object(payload.data) || Object.keys(payload.data).some(symbol => !symbols.includes(symbol))) throw new Error("Provider identity mismatch");
  const result: FinancialRecord[] = [];
  for (const symbol of symbols) {
    const rows = payload.data[symbol];
    if (!Array.isArray(rows) || rows.length > 10000 || (input.latest && rows.length > 1)) throw new Error("Provider response invalid");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!object(row) || !validDate(row.period_end) || (row.announce_date != null && !validDate(row.announce_date))
        || (input.startDate && row.period_end < input.startDate) || (input.endDate && row.period_end > input.endDate)
        || seen.has(row.period_end)) throw new Error("Provider response invalid");
      seen.add(row.period_end);
      const values: Record<string, number | null> = {};
      for (const field of fields[input.kind]) {
        const value = row[field] ?? null;
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Provider response invalid");
        values[field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
      }
      result.push({ symbol, periodEnd: row.period_end, announcementDate: row.announce_date as string | null ?? null, values, currency: null });
    }
  }
  return result;
}

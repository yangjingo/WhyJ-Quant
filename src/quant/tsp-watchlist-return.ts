import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_WATCHLIST_RETURN_FORMULA_VERSION = "tsp-watchlist-return-v1";

export interface TspWatchlistClose {
  tradeDate: string;
  close: number;
}

export interface TspWatchlistReturnInput {
  addedAt: string | null;
  asOf: string;
  assetType: "stock" | "etf" | "index";
  adjustment: "forward" | "none";
  closes: readonly TspWatchlistClose[];
}

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const membershipTime = /^(\d{4}-\d{2}-\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

function membershipDate(value: string | null): string | null {
  if (typeof value !== "string") return null;
  if (isDailyDate(value) && value >= "0001-01-01") return value;
  const match = membershipTime.exec(value);
  if (!match || !isDailyDate(match[1]!) || match[1]! < "0001-01-01") return null;
  const timestamp = Date.parse(value.replace(" ", "T") + (match[2] ? "" : "Z"));
  return Number.isFinite(timestamp) ? shanghaiDate.format(timestamp) : null;
}

export function computeTspWatchlistReturn(input: TspWatchlistReturnInput) {
  const { addedAt, asOf, assetType, adjustment, closes } = input;
  if (typeof asOf !== "string" || !isDailyDate(asOf) || asOf < "0001-01-01" ||
    !["stock", "etf", "index"].includes(assetType) || !Array.isArray(closes)) {
    throw new TypeError("Invalid watchlist return observation scope.");
  }
  const addedDate = membershipDate(addedAt);
  const metadata = {
    producer: "whyj" as const,
    formulaVersion: TSP_WATCHLIST_RETURN_FORMULA_VERSION,
    referenceRevision: TSP_INDICATOR_REVISION,
    returnUnit: "fraction" as const,
    addedAt,
    addedDate,
    asOf,
  };
  const unavailable = { ...metadata, baseline: null, latest: null, pctSinceAdded: null };
  if (assetType !== "stock") return { ...unavailable, status: "unsupported-asset" as const };
  if (adjustment !== "forward") throw new TypeError("Watchlist stock returns require forward-adjusted closes.");
  if (!addedDate) return { ...unavailable, status: "missing-added-date" as const };
  if (addedDate > asOf) return { ...unavailable, status: "added-after-cutoff" as const };

  let baseline: TspWatchlistClose | null = null;
  let latest: TspWatchlistClose | null = null;
  let previous = "";
  for (const row of closes as readonly TspWatchlistClose[]) {
    if (!row || typeof row.tradeDate !== "string" || !isDailyDate(row.tradeDate) || row.tradeDate < "0001-01-01" ||
      row.tradeDate <= previous || !Number.isFinite(row.close) || row.close <= 0) {
      throw new RangeError("Watchlist history requires ordered unique dates and positive closes.");
    }
    previous = row.tradeDate;
    if (row.tradeDate > asOf) continue;
    latest = { tradeDate: row.tradeDate, close: row.close };
    if (row.tradeDate <= addedDate) baseline = latest;
  }

  if (!baseline || !latest) return { ...unavailable, latest, status: "missing-baseline" as const };
  return { ...metadata, baseline, latest, status: "available" as const, pctSinceAdded: finiteStatistic(latest.close / baseline.close - 1) };
}
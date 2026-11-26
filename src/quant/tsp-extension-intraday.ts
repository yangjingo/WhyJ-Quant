import { isDailyDate } from "../market/bars.ts";
import { isAIndexSymbol } from "../market/symbols.ts";
import { roundDecimalTiesToEven } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_EXTENSION_INTRADAY_FORMULA_VERSION = "tsp-extension-intraday-v1";
const maxForwardFilledMembers = 2_000;
const maxAbsoluteReturn = 0.30 + 1e-9;
const minuteMs = 60_000;
const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

export interface TspExtensionIntradaySeries {
  symbol: string;
  minuteRevision: string;
  previousClose: { tradeDate: string; revision: string; price: number | null } | null;
  bars: readonly { timestamp: number; close: number | null }[];
}

export interface TspExtensionIntradayInput {
  tradeDate: string;
  previousDate: string | null;
  adjustment: "none";
  membership: { datasetId: string; revision: string; field: string; value: string; symbols: readonly string[] };
  universe: { id: string; revision: string; symbols: readonly string[] };
  histories: readonly TspExtensionIntradaySeries[];
}

function fixedStockSymbols(value: readonly string[]): Set<string> {
  if (!Array.isArray(value)) throw new Error("Invalid extension intraday symbol scope");
  const symbols = new Set(value);
  if (symbols.size !== value.length ||
    [...symbols].some(symbol => typeof symbol !== "string" || !stock.test(symbol) || isAIndexSymbol(symbol))) {
    throw new Error("Invalid extension intraday symbol scope");
  }
  return symbols;
}

export function computeTspExtensionIntraday({ tradeDate, previousDate, adjustment, membership, universe, histories }: TspExtensionIntradayInput) {
  if (!isDailyDate(tradeDate) || (previousDate !== null && (!isDailyDate(previousDate) || previousDate >= tradeDate)) ||
    adjustment !== "none" || !membership || !universe || !text(membership.datasetId) || !text(membership.revision) ||
    !text(membership.field) || !text(membership.value) || !text(universe.id) || !text(universe.revision) || !Array.isArray(histories)) {
    throw new Error("Invalid extension intraday scope");
  }
  const marketSymbols = fixedStockSymbols(universe.symbols), members = fixedStockSymbols(membership.symbols);
  const dayStart = Date.parse(tradeDate + "T00:00:00+08:00"), dayEnd = dayStart + 24 * 60 * minuteMs;
  const seen = new Set<string>(), membersWithMinute = new Set<string>();
  const minutes = new Map<number, { marketSum: number; marketCount: number; members: { symbol: string; value: number }[] }>();
  const baselines = [];
  let fromPreviousClose = 0, fromFirstClose = 0, marketWithMinute = 0, invalidCloses = 0, outOfBoundReturns = 0;
  for (const history of histories as readonly TspExtensionIntradaySeries[]) {
    if (!history || !marketSymbols.has(history.symbol) || seen.has(history.symbol) || !text(history.minuteRevision) ||
      !Array.isArray(history.bars)) throw new Error("Invalid extension intraday history");
    const { symbol, minuteRevision, previousClose, bars } = history;
    seen.add(symbol);
    if (previousClose !== null && (!previousClose || previousDate === null || previousClose.tradeDate !== previousDate || !text(previousClose.revision) ||
      (previousClose.price !== null && typeof previousClose.price !== "number"))) throw new Error("Mismatched extension intraday prior close");
    let previousTime = -Infinity;
    let firstClose: (typeof bars)[number] | undefined;
    for (const bar of bars as TspExtensionIntradaySeries["bars"]) {
      if (!bar || !Number.isSafeInteger(bar.timestamp) || bar.timestamp % minuteMs !== 0 || bar.timestamp < dayStart ||
        bar.timestamp >= dayEnd || bar.timestamp <= previousTime || (bar.close !== null && typeof bar.close !== "number")) {
        throw new Error("Invalid or unordered extension intraday minute");
      }
      previousTime = bar.timestamp;
      if (!positive(bar.close)) { invalidCloses++; continue; }
      firstClose ??= bar;
    }
    const prior = previousClose?.price ?? null;
    const baseline = firstClose && positive(prior)
      ? { basis: "prev_close" as const, price: prior, timestamp: null }
      : firstClose ? { basis: "first_close" as const, price: firstClose.close!, timestamp: firstClose.timestamp } : null;
    baselines.push({ symbol, minuteRevision, priorRevision: previousClose?.revision ?? null, baseline });
    if (!baseline) continue;
    if (baseline.basis === "prev_close") fromPreviousClose++;
    else fromFirstClose++;
    let hasMinute = false;
    for (const { timestamp, close } of bars as TspExtensionIntradaySeries["bars"]) {
      if (!positive(close)) continue;
      const value = close / baseline.price - 1;
      if (Math.abs(value) > maxAbsoluteReturn) { outOfBoundReturns++; continue; }
      const sample = minutes.get(timestamp) ?? { marketSum: 0, marketCount: 0, members: [] };
      sample.marketSum += value;
      sample.marketCount++;
      if (members.has(symbol)) sample.members.push({ symbol, value });
      minutes.set(timestamp, sample);
      hasMinute = true;
    }
    if (hasMinute) {
      marketWithMinute++;
      if (members.has(symbol)) membersWithMinute.add(symbol);
    }
  }

  const canCarry = membersWithMinute.size <= maxForwardFilledMembers;
  const latest = new Map<string, number>();
  let carriedSum = 0;
  const points = membersWithMinute.size ? [...minutes.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, sample]) => {
    let observedSum = 0;
    for (const { symbol, value } of sample.members) {
      observedSum += value;
      if (canCarry) {
        carriedSum += value - (latest.get(symbol) ?? 0);
        latest.set(symbol, value);
      }
    }
    const sectorCount = canCarry ? latest.size : sample.members.length;
    return { timestamp, sector: sectorCount ? roundDecimalTiesToEven((canCarry ? carriedSum : observedSum) / sectorCount, 4) : null,
      sectorCount, market: roundDecimalTiesToEven(sample.marketSum / sample.marketCount, 4), marketCount: sample.marketCount };
  }) : [];
  const reason = members.size === 0 ? "no_members" : minutes.size === 0 ? "no_minute_evidence"
    : membersWithMinute.size === 0 ? "no_member_bars" : null;
  const basis = fromPreviousClose ? (fromFirstClose ? "mixed" : "prev_close") : fromFirstClose ? "first_close" : null;
  return {
    producer: "whyj" as const, formulaVersion: TSP_EXTENSION_INTRADAY_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    tradeDate, previousDate, adjustment, membership, universe, basis,
    status: reason === null ? "ok" as const : reason === "no_minute_evidence" ? "no_data" as const : "empty" as const,
    reason, memberPolicy: canCarry ? "forward-fill" as const : "observed-only" as const, baselines, points,
    coverage: { memberCount: members.size, membersWithMinute: membersWithMinute.size, marketCount: marketSymbols.size, marketWithMinute,
      fromPreviousClose, fromFirstClose, invalidCloses, outOfBoundReturns },
  };
}

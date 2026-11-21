import { createHash } from "node:crypto";
import {
  computeTspListLiquidity, computeTspScreenerScores, TSP_DAILY_SIGNAL_FIELDS,
  type TspDailySignalId, type TspScreenerScoreInput,
} from "../../quant/index.ts";
import { TSP_DAILY_INDICATOR_FIELDS } from "../../source/index.ts";
import { loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef, type TradingDateArchiveRef } from "../../storage/index.ts";
import { deriveTspArchiveIndicators, type DailySignalExchangeRefs } from "./observation-collection.ts";

type ScoreSettings = Pick<TspScreenerScoreInput, "strategy" | "weights" | "orderBy" | "descending" | "displayLimit">;

export interface ScreenerReplayRequest extends ScoreSettings {
  marketRef: MarketCrossSectionArchiveRef;
  adjustment: "none" | "forward";
  histories: readonly { symbol: string; ref: TradingDateArchiveRef; exchange?: DailySignalExchangeRefs }[];
  signalGate?: { mode: "any" | "all"; signals: readonly TspDailySignalId[] };
}

const marketFields = {
  raw_close: { producer: "tushare", endpoint: "daily", unit: "CNY" },
  amount: { producer: "tushare", endpoint: "daily", unit: "CNY", nativeUnit: "CNY-thousand" },
  turnover_rate: { producer: "tushare", endpoint: "daily_basic", unit: "percentage-points" },
  pe_ttm: { producer: "tushare", endpoint: "daily_basic", unit: "ratio" },
  pb: { producer: "tushare", endpoint: "daily_basic", unit: "ratio" },
  float_val: { producer: "whyj", formula: "tsp_list_liquidity", unit: "CNY" },
} as const;
const dailyFields = new Set<string>(TSP_DAILY_INDICATOR_FIELDS);

/** Rebuild an explicit dated stock scope from fixed observations, then score only the matched candidates. */
export async function replayTspScreener(request: ScreenerReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { marketRef, adjustment, histories, signalGate, strategy, weights, orderBy, descending, displayLimit } = structuredClone(request);
  if (adjustment !== "none" && adjustment !== "forward") throw new Error("Invalid screener price basis");
  const requiredSignals = signalGate?.signals ?? [];
  if (signalGate && ((signalGate.mode !== "any" && signalGate.mode !== "all") || !requiredSignals.length ||
    new Set(requiredSignals).size !== requiredSignals.length || requiredSignals.some(id => !TSP_DAILY_SIGNAL_FIELDS.includes(id)))) {
    throw new Error("Invalid screener signal conditions");
  }
  const fields = [...new Set([...weights.map(entry => entry.field), ...(orderBy && orderBy !== "score" ? [orderBy] : [])])];
  if (fields.some(field => !dailyFields.has(field) && !Object.hasOwn(marketFields, field))) {
    throw new Error("Unsupported screener scoring field");
  }
  const snapshot = await loadMarketCrossSectionArchive(marketRef, signal);
  const { tradeDate, universe: { members }, bars, basics } = snapshot;
  const roster = new Set(members.map(row => row.symbol));
  const requested = new Set<string>();
  for (const { symbol } of histories) {
    if (!roster.has(symbol) || requested.has(symbol)) throw new Error("Foreign or duplicate screener history");
    requested.add(symbol);
  }
  const rawPrices = new Map(bars.rows.map(row => [row.symbol, row]));
  const marketBasics = new Map(basics.rows.map(row => [row.symbol, row]));
  const evaluated = [];
  const candidateSymbols: string[] = [];
  const columns = fields.map(field => ({ field, values: [] as (number | null)[] }));
  for (const { symbol, ref, exchange } of histories) {
    signal?.throwIfAborted();
    const derived = await deriveTspArchiveIndicators(ref, signal, exchange);
    if (derived.input.symbol !== symbol || derived.input.adjustment !== adjustment || derived.input.lastTradeDate > tradeDate) {
      throw new Error("Screener history has a mismatched symbol, price basis or future trade date");
    }
    const daily = derived.daily.rows.at(-1);
    const sameSession = daily?.date === tradeDate;
    const latestSignals = sameSession ? derived.dailySignals.rows.at(-1)?.values : undefined;
    const observations = requiredSignals.map(id => ({ id, value: latestSignals?.[id] ?? null }));
    const all = signalGate?.mode === "all";
    const decisive = observations.some(({ value }) => value === !all);
    const unknown = observations.some(({ value }) => value === null);
    let status: "matched" | "not-matched" | "unavailable" = "unavailable";
    if (sameSession) {
      if (!signalGate) status = "matched";
      else if (decisive) status = all ? "not-matched" : "matched";
      else if (!unknown) status = all ? "matched" : "not-matched";
    }
    evaluated.push({
      symbol, status, signals: observations, daily: { ref, ...derived.input, formula: derived.daily.formula },
      signalFormula: derived.dailySignals.formula,
      ...(derived.dailySignals.exchangeInputs && { exchange: derived.dailySignals.exchangeInputs }),
    });
    if (status !== "matched" || !daily) continue;
    candidateSymbols.push(symbol);
    const bar = rawPrices.get(symbol), basic = marketBasics.get(symbol);
    const values: Record<string, number | null> = {
      ...daily.values,
      raw_close: bar?.close ?? null,
      amount: bar?.amount == null ? null : bar.amount * 1_000,
      turnover_rate: basic?.turnoverPct ?? null,
      pe_ttm: basic?.peTtm ?? null,
      pb: basic?.pb ?? null,
    };
    if (fields.includes("float_val")) {
      values.float_val = computeTspListLiquidity({
        rawCloseCny: values.raw_close ?? null, volumeShares: null,
        circulatingShares: basic?.floatShares == null ? null : basic.floatShares * 10_000,
      }).floatValueCny;
    }
    for (const column of columns) column.values.push(values[column.field] ?? null);
  }
  const candidateRevision = createHash("sha256").update(JSON.stringify({
    marketRevision: marketRef.revision, tradeDate, adjustment, signalGate,
    histories: evaluated.map(({ symbol, daily, signalFormula, exchange }) => [
      symbol, daily.ref.revision, daily.formula, signalFormula, exchange?.raw.ref.revision, exchange?.limits.ref.revision,
    ]),
    columns, candidateSymbols,
  })).digest("hex");
  const ranking = computeTspScreenerScores({
    tradeDate, candidateRevision, strategy, candidateSymbols, columns, weights, orderBy, descending, displayLimit,
  });
  return {
    market: { ref: marketRef, tradeDate, source: snapshot.source, rosterCount: roster.size,
      observations: {
        universe: { endpoint: snapshot.universe.endpoint, observedAt: snapshot.universe.observedAt, coverage: snapshot.universe.coverage },
        daily: { endpoint: bars.endpoint, observedAt: bars.observedAt, coverage: bars.coverage },
        dailyBasic: { endpoint: basics.endpoint, observedAt: basics.observedAt, coverage: basics.coverage },
      } },
    adjustment, signalGate: signalGate ?? null, evaluated, candidateSymbols,
    coverage: { scoped: requested.size, matched: candidateSymbols.length,
      notMatched: evaluated.filter(row => row.status === "not-matched").length,
      unavailable: evaluated.filter(row => row.status === "unavailable").length },
    fieldSources: Object.fromEntries(fields.map(field => [field, Object.hasOwn(marketFields, field)
      ? marketFields[field as keyof typeof marketFields] : { producer: "whyj", formula: "tsp_daily_ohlcv" }])),
    ranking,
  };
}

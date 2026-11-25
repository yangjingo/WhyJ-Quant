import { isDailyDate } from "../../market/bars.ts";
import { isDatedEtfSymbol } from "../../market/symbols.ts";
import { computeTspIntraday, computeTspListIntraday, projectTspListQuoteTail, tspMinuteIndex, TSP_INDICATOR_REVISION, TSP_INTRADAY_FORMULA_VERSION, type TspCompletedMinuteBar } from "../../quant/index.ts";
import { TICKFLOW_SYMBOL_BATCH_SIZE, type CurrentStockMinuteFrame, type Quote, type SourceRequestOptions } from "../../source/index.ts";
import { archiveDatedStockMinutes, loadDatedEtfDailyArchive, loadDatedStockMinuteArchive, loadDailyTradingLimitArchive,
  type DatedEtfDailyArchiveRef, type DatedStockMinuteArchiveRef, type StoredDatedStockMinuteBatch } from "../../storage/index.ts";
import type { IntradayReplayOptions } from "./intraday-replay.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface TickFlowStockMinuteInterpretation {
  timestampLabel: "minute-start" | "minute-end";
  priceBasis: "caller-confirmed-unadjusted-CNY";
  volumeUnit?: "share" | "hand";
  amountUnit?: "CNY" | "CNY-thousand";
}

export interface TickFlowStockMinuteReplayRequest {
  refs: readonly DatedStockMinuteArchiveRef[];
  interpretation: TickFlowStockMinuteInterpretation;
  previousClose?: IntradayReplayOptions["previousClose"];
}

interface CurrentTspQuoteTailOptions {
  maxAgeMs: number;
  priceBasis: "caller-confirmed-same-basis";
}

export interface CurrentTspListIntradayRequest {
  tradeDate: string;
  stocks: readonly { symbol: string; previousClose?: IntradayReplayOptions["previousClose"] }[];
  interpretation?: Pick<TickFlowStockMinuteInterpretation, "timestampLabel" | "priceBasis">;
  quoteTail?: CurrentTspQuoteTailOptions;
}

type EtfPreviousClose = {
  dailyRef: DatedEtfDailyArchiveRef;
  calendar: { revision: string; previousTradeDate: string; tradeDate: string };
  priceBasis: "caller-confirmed-same-basis";
};

export interface CurrentTspEtfIntradayRequest {
  tradeDate: string;
  etfs: readonly { symbol: string; previousClose?: EtfPreviousClose }[];
  interpretation?: CurrentTspListIntradayRequest["interpretation"];
  quoteTail?: CurrentTspQuoteTailOptions;
}

export async function collectDatedTickFlowStockMinutes(
  request: { symbol: string; tradeDate: string }, options: SourceRequestOptions = {},
) {
  const control = { ...options };
  control.signal?.throwIfAborted();
  const { symbol, tradeDate } = request;
  const code = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  const selected = await createConfiguredMarketDataSource(control.signal);
  const { source, endpoint, market, coverage, observedAt, data } = await selected.fetchDatedStockMinutes({ symbol: code, market: "A", tradeDate }, control);
  if (source !== "tickflow" || endpoint !== "/v1/klines" || market !== "A" || data.symbol !== code || data.tradeDate !== tradeDate) {
    throw new Error("TickFlow stock minute response does not match its scope");
  }
  const { rows, ...metadata } = data;
  const evidence = { ...metadata, source, endpoint, market, coverage, observedAt } as const;
  const ref = await archiveDatedStockMinutes({ ...evidence, rows }, control.signal);
  return { ...evidence, ref, rowCount: rows.length, status: rows.length ? "archived" as const : "empty" as const };
}

function normalizeQuantity(value: number | null, factor: number | null): number | null {
  if (value === null || factor === null) return null;
  const converted = value * factor;
  if (!Number.isFinite(converted)) throw new Error("TickFlow minute quantity exceeds the supported numeric range");
  return converted;
}

const shanghaiTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

type StockMinuteExclusion = { tradeDate: string; sourceTimestamp: number; reason: "opening-boundary" | "outside-session" | "unaligned" };

function stockMinuteLabel(sourceTimestamp: number, shift: number): { minute: string } | { reason: StockMinuteExclusion["reason"] } {
  if (sourceTimestamp % 60_000 !== 0) return { reason: "unaligned" };
  const minute = shanghaiTime.format(sourceTimestamp - shift);
  if (tspMinuteIndex(minute) >= 0) return { minute };
  return { reason: shift && shanghaiTime.format(sourceTimestamp) === "09:30" ? "opening-boundary" : "outside-session" };
}

async function readStockMinutePreviousClose(
  symbol: string, dates: readonly string[], input: NonNullable<IntradayReplayOptions["previousClose"]>, signal?: AbortSignal,
) {
  const { ref, priceBasis } = input;
  const limits = await loadDailyTradingLimitArchive(ref, signal);
  if (limits.symbol !== symbol || limits.market !== "A") throw new Error("Previous close archive does not match the TickFlow stock");
  const byDate = new Map(limits.rows.map(row => [row.tradeDate, row.previousClose]));
  return { archiveRef: ref, priceBasis, source: limits.source, endpoint: limits.endpoint, observedAt: limits.observedAt,
    priceUnit: limits.priceUnit, requested: limits.requested, rows: dates.map(tradeDate => ({ tradeDate, price: byDate.get(tradeDate) ?? null })) };
}

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

function currentListInterpretation(interpretation: CurrentTspListIntradayRequest["interpretation"]) {
  if (interpretation === undefined) return null;
  if (!interpretation || (interpretation.timestampLabel !== "minute-start" && interpretation.timestampLabel !== "minute-end") ||
    interpretation.priceBasis !== "caller-confirmed-unadjusted-CNY") throw new Error("Invalid current minute interpretation");
  const { timestampLabel, priceBasis } = interpretation;
  return { timestampLabel, priceBasis };
}

function validateQuoteTail(tail: CurrentTspQuoteTailOptions | undefined, choice: ReturnType<typeof currentListInterpretation>) {
  if (tail !== undefined && (!tail || !choice || tail.priceBasis !== "caller-confirmed-same-basis" ||
    !Number.isSafeInteger(tail.maxAgeMs) || tail.maxAgeMs < 0)) throw new Error("Current quote tail requires a confirmed price basis and valid quote age");
}

async function readCurrentMinuteQuoteTail(
  selected: Awaited<ReturnType<typeof createConfiguredMarketDataSource>>, symbols: string[], frameObservedAt: string,
  tail: CurrentTspQuoteTailOptions | undefined, control: SourceRequestOptions,
) {
  if (!tail) return undefined;
  const { maxAgeMs, priceBasis } = tail;
  const frameTime = Date.parse(frameObservedAt);
  try {
    const result = await selected.fetchQuotes({ symbols }, control);
    control.signal?.throwIfAborted();
    const asOf = Date.now();
    const scope = new Set(symbols);
    const bySymbol = new Map(result.data.map(row => [row.symbol, row]));
    if (asOf < frameTime || result.source !== "tickflow" || result.endpoint !== "/v1/quotes" || bySymbol.size !== result.data.length ||
      result.data.some(row => !scope.has(row.symbol)) ||
      result.missingSymbols.some(symbol => !scope.has(symbol))) throw new Error("Current quote does not match its scope");
    return { frameObservedAt: frameTime, asOf, maxAgeMs, bySymbol,
      receipt: { ...result, status: result.data.length ? "observed" as const : "empty" as const, maxAgeMs, priceBasis, asOf } };
  } catch {
    control.signal?.throwIfAborted();
    const asOf = Math.max(Date.now(), frameTime);
    return { frameObservedAt: frameTime, asOf, maxAgeMs, bySymbol: new Map<string, Quote>(),
      receipt: { status: "unavailable" as const, maxAgeMs, priceBasis, asOf } };
  }
}

function currentListMinuteChart(
  { symbol, status, rows }: CurrentStockMinuteFrame, tradeDate: string,
  choice: ReturnType<typeof currentListInterpretation>, previousClose: number | null,
  tail: Awaited<ReturnType<typeof readCurrentMinuteQuoteTail>>,
) {
  const excluded: StockMinuteExclusion[] = [];
  if (!choice || status !== "observed") return { metrics: null, excluded };
  const shift = choice.timestampLabel === "minute-end" ? 60_000 : 0;
  const bars: (TspCompletedMinuteBar & { sourceTimestamp: number })[] = [];
  for (const { sourceTimestamp, open, high, low, close } of rows) {
    const label = stockMinuteLabel(sourceTimestamp, shift);
    if ("reason" in label) {
      excluded.push({ tradeDate, sourceTimestamp, reason: label.reason });
      continue;
    }
    bars.push({ tradingDate: tradeDate, minute: label.minute, sourceTimestamp, open, high, low, close, volumeShares: null, amountCny: null });
  }
  const quote = tail?.bySymbol.get(symbol);
  const overlay = tail && projectTspListQuoteTail({ symbol, tradeDate, bars,
    frameObservedAt: tail.frameObservedAt, asOf: tail.asOf, maxQuoteAgeMs: tail.maxAgeMs,
    quote: quote ? { symbol: quote.symbol, timestamp: quote.timestamp, price: quote.lastPrice } : null });
  const chart = computeTspListIntraday({ tradeDate, bars: overlay?.bars ?? bars, previousClose });
  const applied = overlay?.applied;
  const metrics = { ...chart, finality: "provisional" as const,
    points: chart.points.map((point, index) => applied && index === chart.points.length - 1
      ? { ...point, sourceTimestamp: applied.quoteTimestamp, priceSource: "quote" as const }
      : { ...point, sourceTimestamp: bars[index]!.sourceTimestamp }) };
  if (!overlay) return { metrics, excluded };
  const { bars: _bars, ...quoteTail } = overlay;
  return { metrics, excluded, quoteTail };
}

/** The caller selects a display interpretation for still-provisional chart points. */
export async function previewCurrentTspListIntraday(request: CurrentTspListIntradayRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  const { signal } = control;
  signal?.throwIfAborted();
  const { tradeDate, stocks, interpretation, quoteTail } = structuredClone(request);
  if (tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(stocks) || !stocks.length || stocks.length > TICKFLOW_SYMBOL_BATCH_SIZE) {
    throw new Error("Invalid current stock-minute preview scope");
  }
  const choice = currentListInterpretation(interpretation);
  validateQuoteTail(quoteTail, choice);
  const targets = Array.from(stocks, stock => ({ ...stock, symbol: stock.symbol.trim().toUpperCase() }));
  const symbols = targets.map(stock => stock.symbol);
  if (new Set(symbols).size !== symbols.length) throw new Error("Duplicate current stock minute symbol");

  const closes = new Map<string, Awaited<ReturnType<typeof readStockMinutePreviousClose>>>();
  for (const { symbol, previousClose } of targets) {
    if (previousClose === undefined) continue;
    if (!choice || previousClose?.priceBasis !== "caller-confirmed-same-basis") {
      throw new Error("Current stock previous close requires a confirmed interpretation and price basis");
    }
    const close = await readStockMinutePreviousClose(symbol, [tradeDate], previousClose, signal);
    if (tradeDate < close.requested.startDate || tradeDate > close.requested.endDate) {
      throw new Error("Previous close archive does not cover the current stock date");
    }
    closes.set(symbol, close);
  }

  const selected = await createConfiguredMarketDataSource(signal);
  const { data, source, endpoint, market, observedAt, coverage } = await selected.fetchCurrentStockMinuteBatch({ symbols, tradeDate, market: "A" }, control);
  if (source !== "tickflow" || endpoint !== "/v1/klines/intraday/batch" || market !== "A" ||
    data.tradeDate !== tradeDate || data.finality !== "provisional" || data.frames.length !== symbols.length ||
    data.frames.some(({ symbol }, index) => symbol !== symbols[index])) throw new Error("Current stock-minute response does not match its scope");
  signal?.throwIfAborted();
  const tails = await readCurrentMinuteQuoteTail(selected, symbols, observedAt, quoteTail, control);
  const rows = data.frames.map(frame => {
    const previousClose = closes.get(frame.symbol) ?? null;
    return { symbol: frame.symbol, status: frame.status, previousClose,
      ...currentListMinuteChart(frame, tradeDate, choice, previousClose?.rows[0]?.price ?? null, tails) };
  });
  return { input: { minutes: { ...data, source, endpoint, market, observedAt, coverage }, interpretation: choice,
    ...(tails && { quoteTail: tails.receipt }) }, rows };
}

async function readEtfMinutePreviousClose(symbol: string, tradeDate: string, input: EtfPreviousClose, signal?: AbortSignal) {
  const { dailyRef, calendar, priceBasis } = input;
  if (!calendar || typeof calendar.revision !== "string" || !calendar.revision.trim() ||
    typeof calendar.previousTradeDate !== "string" || !isDailyDate(calendar.previousTradeDate) ||
    calendar.tradeDate !== tradeDate || calendar.previousTradeDate >= tradeDate) {
    throw new Error("Previous-close calendar does not match the requested ETF session");
  }
  const daily = await loadDatedEtfDailyArchive(dailyRef, signal);
  const { source, endpoint, observedAt, priceUnit, requested } = daily;
  if (daily.symbol !== symbol || daily.market !== "A" || source !== "tickflow" || daily.adjustment !== "none" ||
    calendar.previousTradeDate < requested.start || calendar.previousTradeDate > requested.end) {
    throw new Error("Previous-close archive does not match the ETF, provider or previous session");
  }
  const row = daily.rows.find(row => row.tradeDate === calendar.previousTradeDate) ?? null;
  return { dailyRef, calendar, priceBasis, source, endpoint, observedAt, priceUnit, requested, row };
}

export async function previewCurrentTspEtfIntraday(request: CurrentTspEtfIntradayRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  const { signal } = control;
  signal?.throwIfAborted();
  const { tradeDate, etfs, interpretation, quoteTail } = structuredClone(request);
  if (tradeDate !== shanghaiDate.format(Date.now()) || !Array.isArray(etfs) || !etfs.length || etfs.length > TICKFLOW_SYMBOL_BATCH_SIZE) {
    throw new Error("Invalid current ETF-minute preview scope");
  }
  const choice = currentListInterpretation(interpretation);
  validateQuoteTail(quoteTail, choice);
  const targets = etfs.map(item => ({ ...item, symbol: typeof item?.symbol === "string" ? item.symbol.trim().toUpperCase() : "" }));
  const symbols = targets.map(({ symbol }) => symbol);
  if (symbols.some(symbol => !isDatedEtfSymbol(symbol)) || new Set(symbols).size !== symbols.length) {
    throw new Error("Invalid current ETF-minute preview symbols");
  }
  const closes = new Map<string, Awaited<ReturnType<typeof readEtfMinutePreviousClose>>>();
  for (const { symbol, previousClose } of targets) {
    if (previousClose === undefined) continue;
    if (!choice || previousClose?.priceBasis !== "caller-confirmed-same-basis") {
      throw new Error("Current ETF previous close requires a confirmed interpretation and price basis");
    }
    closes.set(symbol, await readEtfMinutePreviousClose(symbol, tradeDate, previousClose, signal));
  }

  const selected = await createConfiguredMarketDataSource(signal);
  const { data, source, endpoint, market, observedAt, coverage } = await selected.fetchCurrentEtfMinuteBatch({ symbols, tradeDate, market: "A" }, control);
  if (source !== "tickflow" || endpoint !== "/v1/klines/intraday/batch" || market !== "A" || data.assetType !== "etf" ||
    data.tradeDate !== tradeDate || data.finality !== "provisional" || data.frames.length !== symbols.length ||
    data.frames.some(({ symbol }, index) => symbol !== symbols[index])) throw new Error("Current ETF-minute response does not match its scope");
  signal?.throwIfAborted();
  const tails = await readCurrentMinuteQuoteTail(selected, symbols, observedAt, quoteTail, control);
  const rows = data.frames.map(frame => {
    const previousClose = closes.get(frame.symbol) ?? null;
    return { symbol: frame.symbol, status: frame.status, previousClose,
      ...currentListMinuteChart(frame, tradeDate, choice, previousClose?.row?.close ?? null, tails) };
  });
  return { input: { minutes: { ...data, source, endpoint, market, observedAt, coverage }, interpretation: choice,
    ...(tails && { quoteTail: tails.receipt }) }, rows };
}

export async function resolveTickFlowStockMinutes(request: TickFlowStockMinuteReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { refs, interpretation, previousClose } = structuredClone(request);
  if (!Array.isArray(refs) || !refs.length || new Set(refs.map(ref => ref?.revision)).size !== refs.length ||
    !interpretation || (interpretation.timestampLabel !== "minute-start" && interpretation.timestampLabel !== "minute-end") ||
    interpretation.priceBasis !== "caller-confirmed-unadjusted-CNY" ||
    (interpretation.volumeUnit !== undefined && interpretation.volumeUnit !== "share" && interpretation.volumeUnit !== "hand") ||
    (interpretation.amountUnit !== undefined && interpretation.amountUnit !== "CNY" && interpretation.amountUnit !== "CNY-thousand") ||
    (previousClose !== undefined && previousClose?.priceBasis !== "caller-confirmed-same-basis")) {
    throw new Error("Invalid TickFlow minute archive references or interpretation");
  }
  const choice = { timestampLabel: interpretation.timestampLabel, priceBasis: interpretation.priceBasis,
    volumeUnit: interpretation.volumeUnit ?? "unknown", amountUnit: interpretation.amountUnit ?? "unknown" } as const;
  const batches: { ref: DatedStockMinuteArchiveRef; archive: StoredDatedStockMinuteBatch }[] = [];
  for (const ref of refs) {
    const archive = await loadDatedStockMinuteArchive(ref, signal);
    const prior = batches.at(-1)?.archive;
    if (prior && (archive.symbol !== prior.symbol || archive.tradeDate <= prior.tradeDate)) {
      throw new Error("TickFlow minute archives must use one stock and strictly increasing dates");
    }
    batches.push({ ref, archive });
  }
  const symbol = batches[0]!.archive.symbol;
  const closeByDate: Record<string, number> = {};
  const closeEvidence = previousClose
    ? await readStockMinutePreviousClose(symbol, batches.map(({ archive: { tradeDate } }) => tradeDate), previousClose, signal) : null;
  for (const { tradeDate, price } of closeEvidence?.rows ?? []) if (price !== null) closeByDate[tradeDate] = price;
  const excluded: StockMinuteExclusion[] = [];
  const completed: (TspCompletedMinuteBar & { sourceTimestamp: number })[] = [];
  const shift = choice.timestampLabel === "minute-end" ? 60_000 : 0;
  const volumeFactor = choice.volumeUnit === "unknown" ? null : choice.volumeUnit === "hand" ? 100 : 1;
  const amountFactor = choice.amountUnit === "unknown" ? null : choice.amountUnit === "CNY-thousand" ? 1000 : 1;
  for (const { archive: { tradeDate, rows } } of batches) {
    signal?.throwIfAborted();
    for (const row of rows) {
      const { sourceTimestamp, open, high, low, close, volume, amount } = row;
      const label = stockMinuteLabel(sourceTimestamp, shift);
      if ("reason" in label) {
        excluded.push({ tradeDate, sourceTimestamp, reason: label.reason });
        continue;
      }
      completed.push({ tradingDate: tradeDate, minute: label.minute, sourceTimestamp, open, high, low, close,
        volumeShares: normalizeQuantity(volume, volumeFactor), amountCny: normalizeQuantity(amount, amountFactor) });
    }
  }
  const calculated = computeTspIntraday(completed, closeByDate);
  const preview = {
    producer: "whyj" as const,
    formula: { id: "tsp_intraday" as const, version: TSP_INTRADAY_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    input: { symbol, source: "tickflow" as const, interpretation: choice, previousClose: closeEvidence,
      archives: batches.map(({ ref, archive: { rows, ...metadata } }) => ({ ref, ...metadata, rowCount: rows.length })) },
    excluded,
    rows: calculated.map((row, index) => ({ ...row, sourceTimestamp: completed[index]!.sourceTimestamp })),
  };
  return { completed, preview, archives: batches };
}

export async function replayTspTickFlowStockMinutes(request: TickFlowStockMinuteReplayRequest, signal?: AbortSignal) {
  return (await resolveTickFlowStockMinutes(request, signal)).preview;
}

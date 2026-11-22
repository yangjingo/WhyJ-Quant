import { isDailyDate } from "../../market/bars.ts";
import { computeTspQuotePollDelta, type TspQuotePollDeltaRule } from "../../quant/index.ts";
import { TICKFLOW_SYMBOL_BATCH_SIZE, type SourceRequestOptions } from "../../source/index.ts";
import { archiveQuotePollCapture, loadQuotePollArchive, type QuotePollArchiveRef, type StoredQuotePollCapture } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface QuotePollCollectionRequest {
  tradeDate: string;
  symbols: readonly string[];
}

export interface QuotePollReplayRequest {
  currentRef: QuotePollArchiveRef;
  previousRef?: QuotePollArchiveRef;
  volumeUnit?: "share" | "hand";
  amountUnit?: "CNY" | "CNY-thousand";
  rule?: TspQuotePollDeltaRule;
}

const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export async function collectQuotePollCapture(request: QuotePollCollectionRequest, options: SourceRequestOptions = {}) {
  const { tradeDate } = request;
  const started = Date.now();
  if (!isDailyDate(tradeDate) || shanghai.format(started) !== tradeDate ||
    !Array.isArray(request.symbols) || !request.symbols.length || request.symbols.length > 6_999 ||
    request.symbols.some(symbol => typeof symbol !== "string" || !stock.test(symbol))) throw new Error("Invalid current-day quote poll scope");
  const requestedSymbols = [...new Set(request.symbols)].sort();
  if (requestedSymbols.length !== request.symbols.length) throw new Error("Duplicate quote poll symbol");
  const { signal, timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    throw new Error("Invalid quote poll timeout");
  }
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const activeSignal = timeout && signal ? AbortSignal.any([timeout, signal]) : timeout ?? signal;
  activeSignal?.throwIfAborted();
  const source = await createConfiguredMarketDataSource(activeSignal);
  const rows: StoredQuotePollCapture["rows"][number][] = [];
  const outsideCaptureSymbols: string[] = [];
  let batches = 0;
  for (let offset = 0; offset < requestedSymbols.length; offset += TICKFLOW_SYMBOL_BATCH_SIZE) {
    activeSignal?.throwIfAborted();
    const symbols = requestedSymbols.slice(offset, offset + TICKFLOW_SYMBOL_BATCH_SIZE);
    const response = await source.fetchQuotes({ symbols }, { signal: activeSignal });
    const received = Date.parse(response.observedAt);
    if (response.source !== "tickflow" || response.endpoint !== "/v1/quotes" || response.units !== "unknown" ||
      !Number.isFinite(received) || received < started || shanghai.format(received) !== tradeDate) {
      throw new Error("Quote poll response scope changed during capture");
    }
    batches++;
    for (const { symbol, timestamp, lastPrice, previousClose, volume, amount } of response.data) {
      if (timestamp <= received && shanghai.format(timestamp) === tradeDate) {
        rows.push({ symbol, timestamp, lastPrice, previousClose, volume, amount, receivedAt: response.observedAt });
      } else outsideCaptureSymbols.push(symbol);
    }
  }
  const finished = Date.now();
  if (shanghai.format(finished) !== tradeDate) throw new Error("Quote poll crossed the requested Shanghai date");
  const observed = new Set(rows.map(row => row.symbol));
  const capture = { tradeDate, startedAt: new Date(started).toISOString(), observedAt: new Date(finished).toISOString(),
    source: "tickflow", endpoint: "/v1/quotes", market: "A", coverage: "unknown", units: "unknown", requestedSymbols } as const;
  activeSignal?.throwIfAborted();
  const ref = await archiveQuotePollCapture({ ...capture, rows: rows.sort((left, right) => left.symbol.localeCompare(right.symbol)) }, activeSignal);
  return {
    ...capture, ref, status: rows.length ? "archived" as const : "empty" as const,
    batches, rowCount: rows.length, outsideCaptureSymbols, missingSymbols: requestedSymbols.filter(symbol => !observed.has(symbol)),
  };
}

function quantCapture(capture: StoredQuotePollCapture) {
  return { observedAt: Date.parse(capture.observedAt),
    rows: capture.rows.map(({ symbol, timestamp, volume, amount }) => ({ symbol, timestamp, volume, amount })) };
}

function receipt(ref: QuotePollArchiveRef, { rows, ...capture }: StoredQuotePollCapture) {
  return { ref, ...capture, observedSymbols: rows.map(row => row.symbol) };
}

export async function replayTspQuotePollDelta(request: QuotePollReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { previousRef, currentRef, volumeUnit, amountUnit, rule } = structuredClone(request);
  if ((volumeUnit !== undefined && volumeUnit !== "share" && volumeUnit !== "hand") ||
    (amountUnit !== undefined && amountUnit !== "CNY" && amountUnit !== "CNY-thousand")) throw new Error("Invalid confirmed quote units");
  const [current, previous] = await Promise.all([
    loadQuotePollArchive(currentRef, signal), previousRef && loadQuotePollArchive(previousRef, signal),
  ]);
  signal?.throwIfAborted();
  if (previous && (Date.parse(previous.observedAt) > Date.parse(current.startedAt) ||
    previous.requestedSymbols.length !== current.requestedSymbols.length ||
    previous.requestedSymbols.some((symbol, index) => symbol !== current.requestedSymbols[index]))) {
    throw new Error("Quote poll archives must be ordered, nonoverlapping and cover the same requested symbols");
  }
  const delta = computeTspQuotePollDelta({
    tradingDate: current.tradeDate, requestedSymbols: current.requestedSymbols,
    previous: previous && quantCapture(previous), current: quantCapture(current),
    volumeUnit: volumeUnit ?? "unknown", amountUnit: amountUnit ?? "unknown", rule,
  });
  return {
    ...delta,
    input: { current: receipt(currentRef, current), previous: previous && previousRef ? receipt(previousRef, previous) : null,
      volumeUnitBasis: volumeUnit ? "caller-declared" as const : "archive" as const,
      amountUnitBasis: amountUnit ? "caller-declared" as const : "archive" as const },
  };
}

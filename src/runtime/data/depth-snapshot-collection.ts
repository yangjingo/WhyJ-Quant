import { isDailyDate } from "../../market/bars.ts";
import { TICKFLOW_SYMBOL_BATCH_SIZE, type OrderBook, type SourceRequestOptions } from "../../source/index.ts";
import { archiveDepthSnapshot } from "../../storage/index.ts";
import { createConfiguredMarketDataSource } from "./source-runtime.ts";

export interface DepthSnapshotCollectionRequest {
  tradeDate: string;
  symbols: readonly string[];
}

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const stock = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

/** Collect one current-date snapshot with the configured provider and acknowledge an exact immutable capture. */
export async function collectDepthSnapshot(request: DepthSnapshotCollectionRequest, options: SourceRequestOptions = {}) {
  const { tradeDate } = request;
  if (!isDailyDate(tradeDate) || shanghai.format(Date.now()) !== tradeDate ||
    !Array.isArray(request.symbols) || request.symbols.length < 1 || request.symbols.length > 6_999 ||
    request.symbols.some(symbol => typeof symbol !== "string" || !stock.test(symbol))) {
    throw new Error("Invalid current-day depth capture scope");
  }
  const requestedSymbols = [...new Set(request.symbols)].sort();
  if (requestedSymbols.length !== request.symbols.length) throw new Error("Duplicate depth capture symbol");
  const { signal, timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    throw new Error("Invalid depth capture timeout");
  }
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const activeSignal = timeout && signal ? AbortSignal.any([timeout, signal]) : timeout ?? signal;
  activeSignal?.throwIfAborted();
  const configured = await createConfiguredMarketDataSource(activeSignal);
  const rows: OrderBook[] = [];
  const outsideCaptureSymbols: string[] = [];
  let batches = 0;
  for (let offset = 0; offset < requestedSymbols.length; offset += TICKFLOW_SYMBOL_BATCH_SIZE) {
    activeSignal?.throwIfAborted();
    const scope = requestedSymbols.slice(offset, offset + TICKFLOW_SYMBOL_BATCH_SIZE);
    const response = await configured.fetchOrderBookBatch({ symbols: scope }, { signal: activeSignal });
    const receivedAt = Date.parse(response.observedAt);
    if (response.source !== "tickflow" || response.endpoint !== "/v1/depth/batch" || response.units !== "unknown" ||
      !Number.isFinite(receivedAt) || response.requestedSymbols.length !== scope.length ||
      response.requestedSymbols.some((symbol, index) => symbol !== scope[index])) {
      throw new Error("Depth capture response scope does not match the request");
    }
    batches++;
    for (const row of response.data) {
      if (row.timestamp <= receivedAt && shanghai.format(row.timestamp) === tradeDate) rows.push(row);
      else outsideCaptureSymbols.push(row.symbol);
    }
  }
  const capturedAt = Date.now();
  if (shanghai.format(capturedAt) !== tradeDate) throw new Error("Depth capture crossed the requested Shanghai date");
  const observedAt = new Date(capturedAt).toISOString();
  const evidence = { tradeDate, observedAt, market: "A", source: "tickflow", endpoint: "/v1/depth/batch",
    coverage: "unknown", volumeUnit: "unknown", requestedSymbols } as const;
  activeSignal?.throwIfAborted();
  const ref = await archiveDepthSnapshot({ ...evidence, rows }, activeSignal);
  const observed = new Set(rows.map(row => row.symbol));
  return { ...evidence, ref, status: rows.length ? "archived" as const : "empty" as const,
    batches, rowCount: rows.length, missingSymbols: requestedSymbols.filter(symbol => !observed.has(symbol)), outsideCaptureSymbols };
}

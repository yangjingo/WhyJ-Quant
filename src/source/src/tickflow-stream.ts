import { symbolsFor, DEFAULT_TICKFLOW_BASE_URL } from "./tickflow.ts";
import type { Quote, QuoteSubscription, QuoteSubscriptionHandlers, QuoteSubscriptionRequest, SourceConnection, SourceRequestOptions } from "./market-data.ts";

/** No automatic retry: a closed subscription must be explicitly recreated by its owner. */
export async function subscribeTickFlowQuotes(input: QuoteSubscriptionRequest, handlers: QuoteSubscriptionHandlers,
  connection: SourceConnection, options: SourceRequestOptions = {}): Promise<QuoteSubscription> {
  options.signal?.throwIfAborted();
  const symbols = symbolsFor(input.symbols);
  if (symbols.length > 50) throw new Error("Quote subscription exceeds 50 symbols");
  const env = connection.env ?? process.env, key = connection.apiKey ?? env.WHYJ_QUANT_TICKFLOW_API_KEY;
  if (!key?.trim()) throw new Error("WHYJ_QUANT_TICKFLOW_API_KEY is not configured");
  let base: URL;
  try { base = new URL(connection.baseUrl ?? env.TICKFLOW_BASE_URL ?? DEFAULT_TICKFLOW_BASE_URL); }
  catch { throw new Error("Invalid TickFlow base URL"); }
  if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) throw new Error("Invalid TickFlow base URL");
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/$/, "")}/v1/ws/stream`;
  base.searchParams.set("api_key", key);
  let socket: WebSocket;
  try { socket = new WebSocket(base.href); } catch { throw new Error("Quote stream unavailable"); }
  let ready = false, finished = false, intentional = false, resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  return new Promise<QuoteSubscription>((resolve, reject) => {
    const timer = setTimeout(() => fail("Quote stream timed out"), options.timeoutMs ?? 15000);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    const stop = () => { intentional = true; cleanup(); try { socket.close(); } catch { /* already closed */ } };
    const fail = (message: string) => {
      if (finished) return;
      finished = true; cleanup();
      try { socket.close(); } catch { /* already closed */ }
      if (!ready) reject(new Error(message)); else { try { handlers.onError(new Error(message)); } catch { /* consumer callback */ } }
      resolveClosed();
    };
    const abort = () => { if (!ready) fail("Quote stream cancelled"); else stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.addEventListener("open", () => { if (!finished) socket.send(JSON.stringify({ op: "subscribe", channel: "quotes", symbols })); });
    socket.addEventListener("message", event => {
      try {
        if (typeof event.data !== "string" || event.data.length > 1024 * 1024) throw new Error();
        const msg: unknown = JSON.parse(event.data);
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new Error();
        const value = msg as Record<string, unknown>;
        if (value.op === "error") { fail("Quote stream provider rejected subscription"); return; }
        if (value.op === "subscribed") {
          if (ready || value.channel !== "quotes" || !Array.isArray(value.symbols) || value.symbols.length !== symbols.length
            || !symbols.every(symbol => (value.symbols as unknown[]).includes(symbol)) || value.total !== symbols.length) throw new Error();
          ready = true; clearTimeout(timer); resolve({ close: stop, closed }); return;
        }
        if (value.op !== "quotes" || !ready || !Array.isArray(value.data)) throw new Error();
        const seen = new Set<string>();
        const data: Quote[] = value.data.map((raw: unknown) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
          const row = raw as Record<string, unknown>, symbol = row.symbol;
          if (typeof symbol !== "string" || !symbols.includes(symbol) || seen.has(symbol) || row.region !== "CN"
            || !Number.isSafeInteger(row.timestamp) || (row.timestamp as number) <= 0) throw new Error();
          seen.add(symbol);
          for (const field of ["last_price", "prev_close", "open", "high", "low", "volume", "amount"]) {
            if (field === "amount" && row[field] === null) continue;
            if (typeof row[field] !== "number" || !Number.isFinite(row[field]) || (row[field] as number) < 0) throw new Error();
          }
          return { symbol, timestamp: row.timestamp as number, lastPrice: row.last_price as number, previousClose: row.prev_close as number,
            open: row.open as number, high: row.high as number, low: row.low as number, volume: row.volume as number, amount: row.amount as number | null };
        });
        handlers.onQuotes({ source: "tickflow", observedAt: new Date().toISOString(), data });
      } catch { fail("Quote stream response invalid or consumer failed"); }
    });
    socket.addEventListener("error", () => fail("Quote stream unavailable"));
    socket.addEventListener("close", () => {
      if (!finished) { if (!intentional) { fail("Quote stream closed"); return; } finished = true; cleanup(); resolveClosed(); }
    });
  });
}

import { isDailyDate } from "../../market/bars.ts";
import { readFuyao } from "./fuyao-http.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";

const ENDPOINT = "/api/a-share/auction/short-term-benchmark";
const MAX_RESPONSE_BYTES = 256 * 1024;
const STOCK_SYMBOL = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;

export interface AuctionBenchmarkRow {
  symbol: string;
  name: string;
  auctionReturnPct: number | null;
  tags: string[];
}

export interface DatedAuctionBenchmark {
  source: "fuyao";
  endpoint: typeof ENDPOINT;
  market: "A";
  tradeDate: string;
  calendarTimeZone: "Asia/Shanghai";
  tradeDateTimestamp: number;
  responseAssembledAt: number;
  observedAt: string;
  coverage: "unknown";
  returnUnit: "percentage-points";
  rows: AuctionBenchmarkRow[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeResponse(response: unknown, tradeDate: string): DatedAuctionBenchmark {
  const malformed = () => new SourceRequestError("provider-failure", "Invalid Fuyao auction benchmark response");
  if (!record(response) || response.code !== 0 || !record(response.data)) throw malformed();
  const { date, date_ms: tradeDateTimestamp, timestamp: responseAssembledAt, item } = response.data;
  if (date !== tradeDate || typeof tradeDateTimestamp !== "number" || tradeDateTimestamp !== Date.parse(`${tradeDate}T00:00:00+08:00`)
    || typeof responseAssembledAt !== "number" || !Number.isSafeInteger(responseAssembledAt)
    || responseAssembledAt < tradeDateTimestamp || !Number.isFinite(new Date(responseAssembledAt).getTime())
    || !Array.isArray(item)) throw malformed();

  const seen = new Set<string>();
  const rows = item.map((row: unknown): AuctionBenchmarkRow => {
    if (!record(row)) throw malformed();
    const { thscode: symbol, ticker, name, auction_pct: auctionReturnPct, tags } = row;
    if (typeof symbol !== "string" || !STOCK_SYMBOL.test(symbol) || ticker !== symbol.slice(0, 6) || seen.has(symbol)
      || typeof name !== "string" || !name.trim()
      || (auctionReturnPct !== null && (typeof auctionReturnPct !== "number" || !Number.isFinite(auctionReturnPct)))
      || !Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === "string")) throw malformed();
    seen.add(symbol);
    return { symbol, name, auctionReturnPct, tags };
  });
  return {
    source: "fuyao", endpoint: ENDPOINT, market: "A", tradeDate, calendarTimeZone: "Asia/Shanghai",
    tradeDateTimestamp, responseAssembledAt, observedAt: new Date().toISOString(), coverage: "unknown",
    returnUnit: "percentage-points", rows,
  };
}

/** Read Fuyao's selected list for one exact date, separately from the primary market data route. */
export async function fetchDatedAuctionBenchmark(
  tradeDate: string,
  connection: Omit<SourceConnection, "source"> = {},
  options: SourceRequestOptions = {},
): Promise<DatedAuctionBenchmark> {
  options.signal?.throwIfAborted();
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate)) throw new Error("Invalid Fuyao auction trade date");
  const payload = await readFuyao(ENDPOINT, { date: tradeDate }, MAX_RESPONSE_BYTES, "auction benchmark", connection, options);
  return decodeResponse(payload, tradeDate);
}

import { isDailyDate } from "../../market/bars.ts";
import type { DatedPopularityList, PopularityRankRow } from "../../types/popularity.ts";
import { readFuyao } from "./fuyao-http.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";

export type { DatedPopularityList, PopularityRankRow } from "../../types/popularity.ts";

const ENDPOINT = "/api/a-share/special-data/hot-stock-list-history";
const MAX_RESPONSE_BYTES = 64 * 1024;
const STOCK_SYMBOL = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const malformed = () => new SourceRequestError("provider-failure", "Invalid Fuyao historical popularity response");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}

export async function fetchDatedPopularityList(
  calendarDate: string,
  connection: Omit<SourceConnection, "source"> = {},
  options: SourceRequestOptions = {},
): Promise<DatedPopularityList> {
  options.signal?.throwIfAborted();
  if (typeof calendarDate !== "string" || !isDailyDate(calendarDate) || calendarDate < "0001-01-01") {
    throw new Error("Invalid Fuyao popularity calendar date");
  }
  const midnight = Date.parse(calendarDate + "T00:00:00+08:00");
  if (midnight > Date.now()) throw new Error("Invalid Fuyao popularity calendar date");

  const payload = record(await readFuyao(ENDPOINT, { date: calendarDate }, MAX_RESPONSE_BYTES,
    "historical popularity", connection, options));
  if (payload.code === 1003) throw new SourceRequestError("provider-failure", "Fuyao popularity date is outside provider history");
  if (payload.code !== 0) throw malformed();
  const { date, date_ms: calendarDateTimestamp, item } = record(payload.data);
  if (date !== calendarDate || typeof calendarDateTimestamp !== "number" || calendarDateTimestamp !== midnight ||
    !Array.isArray(item) || item.length > 30) throw malformed();

  const seen = new Set<string>();
  const rows = item.map((row: unknown): PopularityRankRow => {
    const { thscode: symbol, ticker, name, rank } = record(row);
    if (typeof symbol !== "string" || !STOCK_SYMBOL.test(symbol) || typeof ticker !== "string" ||
      ticker !== symbol.slice(0, 6) || seen.has(symbol) || typeof name !== "string" || !name.trim() ||
      typeof rank !== "number" || !Number.isSafeInteger(rank) || rank < 1) throw malformed();
    seen.add(symbol);
    return { symbol, ticker, name, rank };
  });
  return {
    source: "fuyao", endpoint: ENDPOINT, market: "A", calendarDate, calendarTimeZone: "Asia/Shanghai",
    calendarDateTimestamp, observedAt: new Date().toISOString(), coverage: "unknown", rows,
  };
}

import { isDailyDate } from "../../market/bars.ts";
import type { DatedDragonTigerBoard, DragonTigerBoardKind, DragonTigerSeatRow, DragonTigerStockRow } from "../../types/dragon-tiger.ts";
import { readFuyao } from "./fuyao-http.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";

const ENDPOINT = "/api/a-share/special-data/dragon-tiger-list";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BOARD_KINDS = ["all", "org", "hot_money"] as const;
export type { DatedDragonTigerBoard, DragonTigerBoardKind, DragonTigerSeatRow, DragonTigerStockRow } from "../../types/dragon-tiger.ts";

const malformed = () => new SourceRequestError("provider-failure", "Invalid Fuyao dragon-tiger board response");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw malformed();
  return value;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformed();
  return value;
}

function countOrNull(value: unknown): number | null {
  const count = numberOrNull(value);
  if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw malformed();
  return count;
}

function list<T>(value: unknown, decode: (row: unknown) => T): T[] {
  if (!Array.isArray(value)) throw malformed();
  return value.map(decode);
}

function stock(value: unknown): DragonTigerStockRow {
  const row = record(value);
  const symbol = stringOrNull(row.thscode)?.trim() || null;
  const ticker = stringOrNull(row.ticker);
  const tickerIdentity = ticker?.trim();
  const rangeDays = numberOrNull(row.range_days);
  if (symbol !== null && (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)
    || (tickerIdentity && tickerIdentity !== symbol && tickerIdentity !== symbol.slice(0, 6)))) throw malformed();
  if (rangeDays !== null && rangeDays !== 1 && rangeDays !== 3) throw malformed();
  return {
    symbol, ticker, name: stringOrNull(row.name), rangeDays,
    conceptNames: row.concept_list == null ? null : list(row.concept_list, value => stringOrNull(record(value).name)),
    changeFraction: numberOrNull(row.change), netValueCny: numberOrNull(row.net_value), netRate: numberOrNull(row.net_rate),
    hotRank: countOrNull(row.hot_rank), buyValueCny: numberOrNull(row.buy_value), sellValueCny: numberOrNull(row.sell_value),
    limitReason: stringOrNull(row.limit_reason), institutionalNetValueCny: numberOrNull(row.org_net_value),
    institutionalNetRate: numberOrNull(row.org_net_rate), institutionalBuyCount: countOrNull(row.org_buy_num),
    institutionalSellCount: countOrNull(row.org_sell_num), amountCny: numberOrNull(row.amount),
    hotMoneyNetValueCny: numberOrNull(row.hot_money_net_value), hotMoneyNetRate: numberOrNull(row.hot_money_net_rate),
    seatNetValueCny: numberOrNull(row.hot_money_item_net_value), seatNetRate: numberOrNull(row.hot_money_item_net_rate),
  };
}

function seat(value: unknown): DragonTigerSeatRow {
  const row = record(value);
  return { name: stringOrNull(row.name), netValueCny: numberOrNull(row.buying), stocks: row.rows == null ? null : list(row.rows, stock) };
}

/** Read a provider board for the exact requested date, retaining the original window of every row. */
export async function fetchDatedDragonTigerBoard(
  tradeDate: string,
  boardKind: DragonTigerBoardKind,
  connection: Omit<SourceConnection, "source"> = {},
  options: SourceRequestOptions = {},
): Promise<DatedDragonTigerBoard> {
  options.signal?.throwIfAborted();
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !BOARD_KINDS.includes(boardKind)) {
    throw new Error("Invalid Fuyao dragon-tiger board request");
  }
  const response = record(await readFuyao(ENDPOINT, { date: tradeDate, board_type: boardKind }, MAX_RESPONSE_BYTES,
    "dragon-tiger board", connection, options));
  if (response.code !== 0) throw malformed();
  const data = record(response.data);
  const providerTimestamp = numberOrNull(data.timestamp);
  const providerRecordCount = countOrNull(data.count);
  const providerStockCount = countOrNull(data.stock_count);
  if (data.trade_date !== tradeDate || data.board_type !== boardKind || providerTimestamp === null
    || providerTimestamp <= 0 || !Number.isSafeInteger(providerTimestamp) || !Number.isFinite(new Date(providerTimestamp).getTime())
    || providerRecordCount === null || providerStockCount === null) throw malformed();
  const stocks = list(data.stock_items, stock);
  const seats = list(data.hot_money_items, seat);
  if (boardKind === "hot_money" ? stocks.length !== 0 : seats.length !== 0) throw malformed();
  return {
    source: "fuyao", endpoint: ENDPOINT, market: "A", tradeDate, boardKind, providerTimestamp,
    observedAt: new Date().toISOString(), calendarTimeZone: "Asia/Shanghai", coverage: "unknown", amountUnit: "CNY",
    ratioUnit: "fraction", providerRecordCount, providerStockCount, stocks, seats,
  };
}

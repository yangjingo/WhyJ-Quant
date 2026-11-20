export type DragonTigerBoardKind = "all" | "org" | "hot_money";

export interface DragonTigerStockRow {
  symbol: string | null;
  ticker: string | null;
  name: string | null;
  conceptNames: (string | null)[] | null;
  rangeDays: 1 | 3 | null;
  changeFraction: number | null;
  netValueCny: number | null;
  netRate: number | null;
  hotRank: number | null;
  buyValueCny: number | null;
  sellValueCny: number | null;
  limitReason: string | null;
  institutionalNetValueCny: number | null;
  institutionalNetRate: number | null;
  institutionalBuyCount: number | null;
  institutionalSellCount: number | null;
  amountCny: number | null;
  hotMoneyNetValueCny: number | null;
  hotMoneyNetRate: number | null;
  seatNetValueCny: number | null;
  seatNetRate: number | null;
}

export interface DragonTigerSeatRow {
  name: string | null;
  netValueCny: number | null;
  stocks: DragonTigerStockRow[] | null;
}

export interface DatedDragonTigerBoard {
  source: "fuyao";
  endpoint: "/api/a-share/special-data/dragon-tiger-list";
  market: "A";
  tradeDate: string;
  boardKind: DragonTigerBoardKind;
  providerTimestamp: number;
  observedAt: string;
  calendarTimeZone: "Asia/Shanghai";
  coverage: "unknown";
  amountUnit: "CNY";
  ratioUnit: "fraction";
  providerRecordCount: number;
  providerStockCount: number;
  stocks: DragonTigerStockRow[];
  seats: DragonTigerSeatRow[];
}

export interface DragonTigerArchiveRef {
  version: 1;
  kind: "dragon-tiger-board";
  revision: string;
}

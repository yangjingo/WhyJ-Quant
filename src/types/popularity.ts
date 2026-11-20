export interface PopularityRankRow {
  symbol: string;
  ticker: string;
  name: string;
  rank: number;
}

export interface DatedPopularityList {
  source: "fuyao";
  endpoint: "/api/a-share/special-data/hot-stock-list-history";
  market: "A";
  calendarDate: string;
  calendarTimeZone: "Asia/Shanghai";
  calendarDateTimestamp: number;
  observedAt: string;
  coverage: "unknown";
  rows: PopularityRankRow[];
}

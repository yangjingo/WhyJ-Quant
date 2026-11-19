/** Storage representation of Source's version-1 bar and factor observations. */
export interface StoredObservationBase {
  schemaVersion: 1;
  kind: "daily_bar" | "minute_bar" | "adjustment_factor";
  symbol: string;
  timestamp: number;
  market: "unknown";
  assetType: "unknown";
  timezone: "UTC";
  sourceAsOf: "unknown";
  source: "tickflow" | "tushare" | "akshare" | "llmquant-data" | "financial-datasets";
  endpoint: string;
  observedAt: string;
  units: "unknown";
  finality: "unknown";
  coverage: "unknown";
  revision: "unknown";
  quality: "unknown";
}
export interface StoredBarObservation extends StoredObservationBase {
  kind: "daily_bar" | "minute_bar";
  interval: "1d" | "1m" | "5m" | "10m" | "15m" | "30m" | "60m";
  adjustment: "forward" | "none";
  values: { open: number; high: number; low: number; close: number; volume: number; amount: number | null };
}
export interface StoredFactorObservation extends StoredObservationBase {
  kind: "adjustment_factor";
  factorBasis: "unknown";
  values: { factor: number };
}
export type StoredObservation = StoredBarObservation | StoredFactorObservation;
export interface ObservationArchiveRef { version: 1; revision: string }

/** Date-keyed daily observations retain the provider's original timestamp and units. */
export interface StoredTradingDateBarObservation {
  schemaVersion: 2;
  kind: "trading_date_daily_bar";
  symbol: string;
  tradeDate: string;
  sourceTimestamp: number | null;
  requested: { startDate: string; endDate: string };
  market: "A";
  assetType: "stock";
  calendarTimeZone: "Asia/Shanghai";
  source: "tushare" | "tickflow";
  endpoint: string;
  observedAt: string;
  interval: "1d";
  adjustment: "forward" | "none";
  volumeUnit: "hand" | "unknown";
  amountUnit: "CNY-thousand" | "unknown";
  coverage: "unknown";
  values: { open: number; high: number; low: number; close: number; volume: number; amount: number | null };
}
export interface TradingDateArchiveRef { version: 2; revision: string }

export interface StoredDailyTradingLimit {
  tradeDate: string;
  previousClose: number | null;
  limitUp: number | null;
  limitDown: number | null;
}

export interface StoredDailyTradingLimitBatch {
  symbol: string;
  market: "A";
  source: "tushare";
  endpoint: "stk_limit";
  observedAt: string;
  coverage: "unknown";
  priceUnit: "CNY";
  requested: { startDate: string; endDate: string };
  rows: StoredDailyTradingLimit[];
}

export interface TradingLimitArchiveRef {
  version: 1;
  kind: "daily-trading-limits";
  revision: string;
}

export interface StoredHistoricalMinuteBar {
  tradeTime: string;
  openingBoundary: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number | null;
}

export interface StoredHistoricalMinuteBatch {
  symbol: string;
  market: "A";
  source: "tushare";
  endpoint: "stk_mins";
  observedAt: string;
  coverage: "unknown";
  finality: "unknown";
  adjustment: "unknown";
  timeZone: "Asia/Shanghai";
  interval: "1m";
  volumeUnit: "share";
  amountUnit: "CNY";
  requested: { startDate: string; endDate: string };
  rows: StoredHistoricalMinuteBar[];
}

export interface HistoricalMinuteArchiveRef {
  version: 1;
  kind: "historical-minute-bars";
  revision: string;
}

export interface StoredReportFinancialIndicator {
  periodEnd: string;
  announcementDate: string | null;
  updateFlag: string | null;
  bookValuePerShare: number | null;
  bookValueCurrency: "unknown";
  roe: number | null;
  grossProfitMargin: number | null;
  netProfitMargin: number | null;
  operatingRevenueYoyPct: number | null;
  totalOperatingRevenueYoyPct: number | null;
  parentNetProfitYoyPct: number | null;
  debtToAssets: number | null;
  ratioUnit: "provider-native";
}

export interface StoredFinancialDisclosureDate {
  periodEnd: string;
  planAnnouncementDate: string | null;
  plannedDisclosureDate: string | null;
  actualDisclosureDate: string | null;
  modificationRecord: string | null;
}

export type StoredFinancialObservationBatch = {
  symbol: string;
  market: "A";
  source: "tushare";
  observedAt: string;
  coverage: "unknown";
} & ({
  endpoint: "fina_indicator";
  requested: { startPeriod: string; endPeriod: string };
  rows: StoredReportFinancialIndicator[];
} | {
  endpoint: "disclosure_date";
  requested: { periodEnd: string };
  rows: StoredFinancialDisclosureDate[];
});

export interface FinancialObservationArchiveRef {
  version: 1;
  kind: "report-financial-indicators" | "financial-disclosure-dates";
  revision: string;
}

interface StoredMarketSlice<Endpoint extends string> {
  endpoint: Endpoint;
  tradeDate: string;
  observedAt: string;
  coverage: "unknown";
}

export interface StoredMarketCrossSection {
  source: "tushare";
  market: "A";
  tradeDate: string;
  universe: StoredMarketSlice<"bak_basic"> & {
    universe: "provider-dated-stocks";
    members: { symbol: string; name: string; industry: string | null; listedOn: string | null }[];
  };
  bars: StoredMarketSlice<"daily"> & {
    adjustment: "none";
    priceUnit: "CNY";
    volumeUnit: "hand";
    amountUnit: "CNY-thousand";
    rows: {
      symbol: string;
      open: number; high: number; low: number; close: number;
      exRightsPreviousClose: number | null;
      changeCny: number | null;
      returnPct: number | null;
      volume: number | null;
      amount: number | null;
    }[];
  };
  basics: StoredMarketSlice<"daily_basic"> & {
    priceUnit: "CNY";
    shareUnit: "ten-thousand-shares";
    marketValueUnit: "CNY-ten-thousand";
    rows: {
      symbol: string;
      close: number | null;
      turnoverPct: number | null;
      freeFloatTurnoverPct: number | null;
      providerVolumeRatio: number | null;
      totalShares: number | null;
      floatShares: number | null;
      freeFloatShares: number | null;
      pe: number | null;
      peTtm: number | null;
      pb: number | null;
      totalMarketValue: number | null;
      circulatingMarketValue: number | null;
    }[];
  };
}

export interface MarketCrossSectionArchiveRef {
  version: 1;
  kind: "market-cross-section";
  revision: string;
}

export type StoredSectorObservationBatch = {
  market: "A";
  source: "tushare";
  tradeDate: string;
  observedAt: string;
  coverage: "unknown";
  taxonomy: "eastmoney";
} & ({
  endpoint: "dc_index";
  kind: "industry" | "concept";
  providerType: "行业板块" | "概念板块";
  groups: { code: string; name: string; level: string | null }[];
} | {
  endpoint: "dc_member";
  sectorCode: string;
  members: { symbol: string; name: string | null }[];
});

export interface SectorObservationArchiveRef {
  version: 1;
  kind: "dated-sector-catalog" | "dated-sector-members";
  revision: string;
}

export interface StoredBenchmarkIndexBatch {
  symbol: string;
  source: "tushare";
  market: "A";
  endpoint: "index_daily";
  observedAt: string;
  coverage: "unknown";
  requested: { start: string; end: string };
  priceUnit: "index-points";
  returnUnit: "percentage-points";
  rows: {
    tradeDate: string;
    closePoints: number;
    previousClosePoints: number | null;
    changePoints: number | null;
    returnPct: number | null;
  }[];
}

export interface BenchmarkIndexArchiveRef {
  version: 1;
  kind: "benchmark-index";
  revision: string;
}

export interface StoredAuctionBenchmark {
  source: "fuyao";
  endpoint: "/api/a-share/auction/short-term-benchmark";
  market: "A";
  tradeDate: string;
  calendarTimeZone: "Asia/Shanghai";
  tradeDateTimestamp: number;
  responseAssembledAt: number;
  observedAt: string;
  coverage: "unknown";
  returnUnit: "percentage-points";
  rows: { symbol: string; name: string; auctionReturnPct: number | null; tags: string[] }[];
}

export interface AuctionBenchmarkArchiveRef {
  version: 1;
  kind: "auction-benchmark";
  revision: string;
}

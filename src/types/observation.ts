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

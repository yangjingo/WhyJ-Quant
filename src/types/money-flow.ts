export interface MoneyFlowOrderBucket {
  buyVolumeHand: number | null;
  buyAmount: number | null;
  sellVolumeHand: number | null;
  sellAmount: number | null;
}

export interface DatedMoneyFlow {
  tradeDate: string;
  volumeUnit: "hand";
  amountUnit: "CNY-ten-thousand";
  rows: {
    symbol: string;
    small: MoneyFlowOrderBucket;
    medium: MoneyFlowOrderBucket;
    large: MoneyFlowOrderBucket;
    extraLarge: MoneyFlowOrderBucket;
    netVolumeHand: number | null;
    netAmount: number | null;
  }[];
}

export interface StoredMoneyFlowBatch extends DatedMoneyFlow {
  market: "A";
  source: "tushare";
  endpoint: "moneyflow";
  observedAt: string;
  coverage: "unknown";
}

export interface MoneyFlowArchiveRef {
  version: 1;
  kind: "dated-money-flow";
  revision: string;
}

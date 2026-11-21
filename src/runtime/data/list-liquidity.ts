import {
  computeTspListLiquidity, TSP_INDICATOR_REVISION, TSP_LIST_LIQUIDITY_FORMULA_VERSION,
} from "../../quant/index.ts";
import { loadMarketCrossSectionArchive, type MarketCrossSectionArchiveRef, type StoredMarketCrossSection } from "../../storage/index.ts";

export function archivedListLiquidity(
  bar: StoredMarketCrossSection["bars"]["rows"][number] | null,
  basic: StoredMarketCrossSection["basics"]["rows"][number] | null,
) {
  const volumeShares = bar?.volume != null ? bar.volume * 100 : null;
  return {
    volumeShares,
    metrics: {
      producer: "whyj" as const,
      formula: { id: "tsp_list_liquidity" as const, version: TSP_LIST_LIQUIDITY_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
      units: { floatValueCny: "CNY", turnoverPct: "percentage-points" } as const,
      ...computeTspListLiquidity({
        rawCloseCny: bar?.close ?? null, volumeShares,
        circulatingShares: basic?.floatShares != null ? basic.floatShares * 10_000 : null,
      }),
    },
  };
}

export async function replayTspListLiquidity(
  ref: MarketCrossSectionArchiveRef,
  symbol: string,
  signal?: AbortSignal,
) {
  const archiveRef = { ...ref };
  const snapshot = await loadMarketCrossSectionArchive(archiveRef, signal);
  signal?.throwIfAborted();
  const { source, tradeDate, market, universe, bars, basics } = snapshot;
  const member = universe.members.find(row => row.symbol === symbol);
  if (!member) throw new Error("Stock is absent from the archived roster");
  const { rows: barRows, ...barMetadata } = bars;
  const { rows: basicRows, ...basicMetadata } = basics;
  const bar = barRows.find(row => row.symbol === symbol) ?? null;
  const basic = basicRows.find(row => row.symbol === symbol) ?? null;
  const { metrics } = archivedListLiquidity(bar, basic);
  return {
    archiveRef, symbol, market, tradeDate,
    observations: {
      producer: source,
      daily: { ...barMetadata, row: bar },
      dailyBasic: { ...basicMetadata, row: basic },
    },
    metrics,
  };
}

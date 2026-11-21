export const TSP_LIST_LIQUIDITY_FORMULA_VERSION = 1;

export interface TspListLiquidityInput {
  rawCloseCny: number | null;
  volumeShares: number | null;
  circulatingShares: number | null;
}

/** Inputs must describe the same stock and exchange session, with an unadjusted closing price. */
export function computeTspListLiquidity({ rawCloseCny, volumeShares, circulatingShares }: TspListLiquidityInput) {
  if ((rawCloseCny !== null && (!Number.isFinite(rawCloseCny) || rawCloseCny <= 0)) ||
    (volumeShares !== null && (!Number.isFinite(volumeShares) || volumeShares < 0)) ||
    (circulatingShares !== null && (!Number.isFinite(circulatingShares) || circulatingShares < 0))) {
    throw new Error("Invalid TSP list liquidity inputs");
  }
  const eligibleShares = circulatingShares !== null && circulatingShares > 0 ? circulatingShares : null;
  const floatValueCny = eligibleShares !== null && rawCloseCny !== null ? eligibleShares * rawCloseCny : null;
  const turnoverPct = eligibleShares !== null && volumeShares !== null ? (volumeShares / eligibleShares) * 100 : null;
  if ((floatValueCny !== null && !Number.isFinite(floatValueCny)) ||
    (turnoverPct !== null && !Number.isFinite(turnoverPct))) throw new Error("TSP list liquidity result overflow");
  return { floatValueCny, turnoverPct };
}

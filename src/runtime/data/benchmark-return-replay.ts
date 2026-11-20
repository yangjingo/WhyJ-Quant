/** Derive a return from the exact preceding session in the same immutable TickFlow capture. */
export function deriveTickFlowBenchmarkReturn(
  tradeDate: string, closePoints: number, previousTradingDate: string | null, closes: ReadonlyMap<string, number>,
) {
  const previousClosePoints = previousTradingDate === null ? null : closes.get(previousTradingDate) ?? null;
  const returnPct = previousClosePoints === null ? null : (closePoints - previousClosePoints) / previousClosePoints * 100;
  if (returnPct !== null && !Number.isFinite(returnPct)) throw new Error("Derived benchmark return exceeds numeric range");
  return {
    producer: "whyj" as const,
    basis: previousClosePoints === null ? "missing-adjacent-close" as const : "adjacent-session-closes" as const,
    tradeDate, previousTradingDate, closePoints, previousClosePoints, returnPct,
  };
}

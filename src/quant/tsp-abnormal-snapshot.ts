import { isDailyDate } from "../market/bars.ts";
import type { TspDailySignalId } from "./tsp-daily-signals.ts";

export const TSP_ABNORMAL_SNAPSHOT_FORMULA_VERSION = 1;
export const TSP_ABNORMAL_SNAPSHOT_SIGNALS = [
  ["signal_limit_up", "limit_up"],
  ["signal_broken_limit_up", "broken"],
  ["signal_limit_down_recovery", "recovery"],
  ["signal_limit_down", "limit_down"],
  ["signal_n_day_high", "new_high"],
  ["signal_n_day_low", "new_low"],
  ["signal_volume_surge", "volume_surge"],
] as const satisfies readonly (readonly [TspDailySignalId, string])[];

type SignalId = typeof TSP_ABNORMAL_SNAPSHOT_SIGNALS[number][0];
type SignalKind = typeof TSP_ABNORMAL_SNAPSHOT_SIGNALS[number][1];
export interface TspAbnormalSnapshotObservation {
  symbol: string;
  changeFraction: number | null;
  signals: Record<SignalId, boolean | null>;
}

/** Rank one dated set of classified stocks and count all observations before truncation. */
export function rankTspAbnormalSnapshot(
  tradeDate: string,
  observations: readonly TspAbnormalSnapshotObservation[],
  limit = 500,
) {
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !Number.isInteger(limit) || limit < 1 || limit > 2_000) {
    throw new Error("Invalid TSP abnormal snapshot date or limit");
  }
  const counts = Object.fromEntries(TSP_ABNORMAL_SNAPSHOT_SIGNALS.map(([, kind]) => [kind, 0])) as Record<SignalKind, number>;
  const unknown = { ...counts };
  const seen = new Set<string>();
  const ranked: { symbol: string; changeFraction: number | null; signals: SignalKind[]; priority: number }[] = [];
  for (const { symbol, changeFraction, signals } of observations) {
    if (typeof symbol !== "string" || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(symbol) || seen.has(symbol) ||
      (changeFraction !== null && !Number.isFinite(changeFraction))) throw new Error("Invalid or duplicate TSP abnormal snapshot observation");
    seen.add(symbol);
    const matched: SignalKind[] = [];
    let priority: number = TSP_ABNORMAL_SNAPSHOT_SIGNALS.length;
    for (const [index, [field, kind]] of TSP_ABNORMAL_SNAPSHOT_SIGNALS.entries()) {
      const value = signals[field];
      if (value === null) unknown[kind]++;
      else if (value === true) {
        counts[kind]++;
        priority = Math.min(priority, index);
        matched.push(kind);
      } else if (value !== false) throw new Error("Invalid TSP abnormal signal value");
    }
    if (matched.length) ranked.push({ symbol, changeFraction, signals: matched, priority });
  }
  ranked.sort((a, b) => a.priority - b.priority ||
    Math.abs(b.changeFraction ?? 0) - Math.abs(a.changeFraction ?? 0) || a.symbol.localeCompare(b.symbol, "en"));
  return {
    tradeDate, scopedCount: observations.length, matchedCount: ranked.length, counts, unknown,
    rows: ranked.slice(0, limit).map(({ priority: _priority, ...row }) => row),
  };
}

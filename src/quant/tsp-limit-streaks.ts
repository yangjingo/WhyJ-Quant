import { isDailyDate } from "../market/bars.ts";
import type { TspDailySignalRow } from "./tsp-daily-signals.ts";

export const TSP_LIMIT_STREAK_FORMULA_VERSION = 1;

type LimitSignalRow = {
  date: string;
  values: Pick<TspDailySignalRow["values"], "signal_limit_up" | "signal_limit_down">;
};

function nextStreak(previous: number | null, hit: boolean | null): number | null {
  if (hit === false) return 0;
  return hit === true && previous !== null ? previous + 1 : null;
}

/** Count closing-limit runs for one symbol across the supplied exchange sessions. */
export function computeTspLimitStreaks(sessions: readonly string[], signals: readonly LimitSignalRow[]) {
  const calendar = new Set<string>();
  for (const [index, date] of sessions.entries()) {
    if (typeof date !== "string" || !isDailyDate(date) || (index > 0 && date <= sessions[index - 1]!)) {
      throw new Error("Limit streaks require ordered unique exchange sessions");
    }
    calendar.add(date);
  }
  const byDate = new Map<string, LimitSignalRow["values"]>();
  for (const { date, values } of signals) {
    const { signal_limit_up: up, signal_limit_down: down } = values;
    if (!calendar.has(date) || byDate.has(date) || (up !== null && typeof up !== "boolean") ||
      (down !== null && typeof down !== "boolean") || (up === true && down === true)) {
      throw new Error("Invalid limit streak signal observations");
    }
    byDate.set(date, values);
  }

  let consecutiveLimitUps: number | null = null;
  let consecutiveLimitDowns: number | null = null;
  return sessions.map(date => {
    const signal = byDate.get(date);
    consecutiveLimitUps = nextStreak(consecutiveLimitUps, signal?.signal_limit_up ?? null);
    consecutiveLimitDowns = nextStreak(consecutiveLimitDowns, signal?.signal_limit_down ?? null);
    return { date, consecutiveLimitUps, consecutiveLimitDowns };
  });
}

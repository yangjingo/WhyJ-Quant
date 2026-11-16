import type { TspObservations } from "../../types/thesis-tsp.ts";
import type { ThesisPriceContext } from "../../types/thesis-archive.ts";
import type { ThesisTspView } from "../../types/thesis-workbench.ts";

export const shanghaiDay = (instant: string) => new Date(Date.parse(instant) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
export const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Projection of retained bytes, never a live query or independent source verification. */
export function inspectTspBatch(batch: TspObservations) {
  const alerts: ThesisTspView["alerts"][number][] = [];
  let omittedAlerts = 0, alertsReason: string | null = null, dailyReason: string | null = null;
  let rows: ThesisPriceContext["rows"] = [];
  const alertSource = batch.observations.find(item => item.tool === "get_recent_alerts");
  try {
    if (!alertSource?.content) throw new Error();
    const value: unknown = JSON.parse(alertSource.content);
    if (!object(value) || !Array.isArray(value.alerts)) throw new Error();
    for (const [index, item] of value.alerts.entries()) {
      if (alerts.length >= 20 || !object(item) || item.symbol !== batch.symbol || typeof item.ts !== "number"
        || !Number.isSafeInteger(item.ts) || !Number.isFinite(new Date(item.ts).getTime())
        || typeof item.message !== "string" || !item.message.trim() || item.message.length > 2000) { omittedAlerts++; continue; }
      const occurredAt = new Date(item.ts).toISOString();
      if (occurredAt.length !== 24) { omittedAlerts++; continue; }
      alerts.push({ index, event: { id: `tsp-alert-${index}`, kind: "price", occurredAt, sourceUrl: alertSource.sourceUrl, summary: item.message },
        price: typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0 ? item.price : null });
    }
    if (!alerts.length) alertsReason = "没有可选的同股票、带有效时间与摘要的提醒；未将批量或其他股票提醒关联到此基线。";
  } catch { alertsReason = "提醒结果不可用或结构无法识别；可保留此观察并手动填写事件。"; }
  const dailySource = batch.observations.find(item => item.tool === "get_kline");
  try {
    if (!dailySource?.content) throw new Error();
    const value: unknown = JSON.parse(dailySource.content);
    if (!object(value) || value.symbol !== batch.symbol || value.asset_type !== "stock" || !Array.isArray(value.rows) || value.rows.length > 1500) throw new Error();
    const parsed = value.rows.map(item => {
      if (!object(item) || !validDay(item.date) || ![item.open, item.high, item.low, item.close, item.volume].every(entry => typeof entry === "number" && Number.isFinite(entry))) throw new Error();
      const row = { date: item.date, open: item.open as number, high: item.high as number, low: item.low as number, close: item.close as number, vol: item.volume as number };
      if (Math.min(row.open, row.close, row.low) <= 0 || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close) || row.vol < 0) throw new Error();
      return row;
    }).sort((a, b) => a.date.localeCompare(b.date));
    if (new Set(parsed.map(row => row.date)).size !== parsed.length) throw new Error();
    // Conservative closed-day view; never present today's partially formed candle as a completed day.
    rows = parsed.filter(row => row.date < shanghaiDay(dailySource.retrievedAt));
    if (rows.length < 2) dailyReason = "采集日前的有效日线不足两条；未补造行情。";
  } catch { dailyReason = "日线对象、日期或 OHLCV 结构无法核验，未绘图。"; }
  if (dailyReason) rows = [];
  return { alerts, omittedAlerts, alertsReason, rows, dailyReason,
    daily: rows.length ? { count: rows.length, start: rows[0]!.date, end: rows.at(-1)!.date } : null };
}

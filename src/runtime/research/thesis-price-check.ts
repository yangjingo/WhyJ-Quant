import { isDeepStrictEqual } from "node:util";
import { normalizeBarSeries, validateDateRange } from "../../market/bars.ts";
import { normalizeSymbol } from "../../market/symbols.ts";
import { loadDataset } from "../../storage/index.ts";
import { fetchBars } from "../data/source-runtime.ts";
import type { ThesisPriceCheck, ThesisPriceCheckRequest, ThesisPriceComparison, ThesisPriceReference } from "../../types/thesis-price-check.ts";

const day = (instant: string) => new Date(Date.parse(instant) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const instant = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function validateRequest(request: ThesisPriceCheckRequest): void {
  if (!request || typeof request.symbol !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(request.symbol)
    || normalizeSymbol(request.symbol, "A") !== request.symbol || typeof request.start !== "string" || typeof request.end !== "string")
    throw new Error("请选择有效的 A 股代码和固定日期范围。");
  validateDateRange(request.start, request.end);
  if (Date.parse(request.end) - Date.parse(request.start) > 365 * 86_400_000) throw new Error("单次行情核对最多覆盖 366 个自然日。");
}

/** Uses the same configured source, fallback and immutable archive as fetch_bars. No model or new provider. */
export async function collectThesisPriceCheck(request: ThesisPriceCheckRequest, options: {
  signal?: AbortSignal; fetch?: typeof fetchBars; resolveDataset?: typeof loadDataset;
} = {}): Promise<ThesisPriceCheck> {
  validateRequest(request);
  options.signal?.throwIfAborted();
  const requestedAt = new Date().toISOString();
  if (request.end >= day(requestedAt)) throw new Error("行情核对仅接受北京时间今天之前的固定日线。");
  try {
    const result = await (options.fetch ?? fetchBars)(request.symbol, "A", request.start, request.end, undefined,
      { providers: { signal: options.signal, budgetMs: 20_000 } });
    options.signal?.throwIfAborted();
    const checkedAt = new Date().toISOString(), dataset = result.dataset;
    if (!dataset || result.origin === "unavailable" || !["provider", "cache", "stale-cache"].includes(result.origin)
      || dataset.symbol !== request.symbol || dataset.market !== "A" || dataset.source !== result.source
      || dataset.requested.start !== request.start || dataset.requested.end !== request.end
      || !instant(dataset.snapshotAt) || dataset.snapshotAt > checkedAt) throw new Error();
    const bars = normalizeBarSeries(result.bars, request.start, request.end);
    // Do not silently normalize malformed/duplicate/out-of-window rows into a successful check.
    if (!bars.length || bars.length > 366 || !isDeepStrictEqual(bars, result.bars)
      || !isDeepStrictEqual(bars, (options.resolveDataset ?? loadDataset)(dataset))) throw new Error();
    return structuredClone({ ...request, checkedAt, status: "available", source: result.source, origin: result.origin, dataset, bars });
  } catch {
    options.signal?.throwIfAborted();
    return { ...request, checkedAt: new Date().toISOString(), status: "unavailable",
      reason: "配置行情源或固定归档不可用，未将 TSP 数据当作核对结果。请检查数据源后显式重试。" };
  }
}

/** Compare retained OHLC only. Volume units and upstream independence are not inferred. */
export function compareThesisPrices(reference: ThesisPriceReference, checked: ThesisPriceCheck): ThesisPriceComparison {
  const empty = { comparedDates: [], differences: [], missingDates: [], tolerance: 1e-8 as const };
  const unavailable = (reason: string): ThesisPriceComparison => ({ ...empty, outcome: "incomparable", reason });
  validateRequest(reference);
  if (checked.status === "unavailable") return { ...empty, outcome: "unavailable", reason: checked.reason };
  if (reference.symbol !== checked.symbol || reference.start !== checked.start || reference.end !== checked.end)
    return unavailable("股票或固定日期范围不同。");
  if (checked.dataset.symbol !== checked.symbol || checked.dataset.market !== "A" || checked.dataset.source !== checked.source
    || checked.dataset.requested.start !== checked.start || checked.dataset.requested.end !== checked.end
    || !checked.bars.length || checked.bars.length > 366
    || !isDeepStrictEqual(normalizeBarSeries(checked.bars, checked.start, checked.end), checked.bars))
    return unavailable("核对行情身份或行内容无效。");
  if (checked.origin === "stale-cache") return unavailable("行情请求回退到过期缓存；保留原值，不据此确认一致。");
  if (!["forward-adjusted", "unadjusted"].includes(reference.adjustment) || reference.adjustment !== checked.dataset.adjustment)
    return unavailable("复权口径未知或不同，不能直接比较价格水平。");
  if (!instant(reference.observedAt) || !instant(checked.checkedAt) || reference.observedAt > checked.checkedAt
    || !instant(checked.dataset.snapshotAt) || checked.dataset.snapshotAt > checked.checkedAt
    || reference.end >= day(reference.observedAt) || checked.end >= day(checked.checkedAt))
    return unavailable("来源观察时间无效或包含观察日尚未完成的日线。");
  const fields = ["open", "high", "low", "close"] as const;
  if (!reference.rows.length || reference.rows.length > 366) return unavailable("参考行情行数超出固定窗口上限。");
  const normalized = normalizeBarSeries(reference.rows.map(row => ({ ...row, volume: 0, amount: null })), reference.start, reference.end);
  if (!reference.rows.length || normalized.length !== reference.rows.length
    || !isDeepStrictEqual(normalized.map(({ date, open, high, low, close }) => ({ date, open, high, low, close })), reference.rows))
    return unavailable("参考行情存在无效、重复、未排序或窗口外的日线。");
  const known = new Map(checked.bars.map(row => [row.date, row])), expected = new Set(reference.rows.map(row => row.date));
  const missingDates = [...new Set([...reference.rows.filter(row => !known.has(row.date)).map(row => row.date), ...checked.bars.filter(row => !expected.has(row.date)).map(row => row.date)])].sort();
  if (missingDates.length) return { ...empty, outcome: "incomparable", missingDates, reason: "两份固定窗口的交易日期不一致；未插值或补造缺失交易日。" };
  const differences: ThesisPriceComparison["differences"][number][] = [];
  for (const row of reference.rows) for (const field of fields) {
    const value = known.get(row.date)![field];
    if (Math.abs(row[field] - value) > empty.tolerance) differences.push({ date: row.date, field, reference: row[field], checked: value });
  }
  return { ...empty, outcome: differences.length ? "different" : "matching", differences, comparedDates: reference.rows.map(row => row.date),
    reason: differences.length ? "固定 OHLC 存在差异，需核对来源、观察时刻及复权因子变化；未判定任一来源错误。"
      : "固定 OHLC 在绝对误差 1e-8 内一致；不证明上游独立、成交量单位或基本面假设。" };
}

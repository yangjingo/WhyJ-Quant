/** Immutable Source observations, independent of provider clients and the daily-bar cache. */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoricalMinuteArchiveRef, ObservationArchiveRef, StoredDailyTradingLimitBatch, StoredHistoricalMinuteBatch,
  StoredObservation, StoredTradingDateBarObservation, TradingDateArchiveRef, TradingLimitArchiveRef } from "../../types/observation.ts";
import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol } from "../../market/symbols.ts";
import { resolveDataDir } from "./dirs.ts";
import { atomicWriteTextAsync, withFileLockAsync } from "./atomic-file.ts";

const sources = new Set(["tickflow", "tushare", "akshare", "llmquant-data", "financial-datasets"]);
const minutes = new Set(["1m", "5m", "10m", "15m", "30m", "60m"]);
const baseKeys = ["schemaVersion", "kind", "symbol", "timestamp", "market", "assetType", "timezone", "sourceAsOf", "source", "endpoint", "observedAt", "units", "finality", "coverage", "revision", "quality"];
const unknowns = ["market", "assetType", "sourceAsOf", "units", "finality", "coverage", "revision", "quality"];
const fail = () => new Error("Invalid observation archive");
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function instant(value: string): boolean {
  const p = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!p) return false;
  const [, y, m, d, h, min, sec, offsetHour, offsetMinute] = p;
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
    && Number(h) < 24 && Number(min) < 60 && Number(sec) < 60
    && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60)) && Number.isFinite(Date.parse(value));
}
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical(v[key])}`).join(",")}}`;
  return JSON.stringify(v);
};
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const archiveDir = () => join(resolveDataDir(), "observation-archives-v1");

async function writeFixedArchive(dir: string, target: string, content: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dir, { recursive: true });
  await withFileLockAsync(target, async () => {
    signal?.throwIfAborted();
    try {
      if (await readFile(target, { encoding: "utf8", signal }) !== content) throw new Error("Observation archive is damaged");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWriteTextAsync(target, content, signal);
    }
  }, signal);
}

async function readFixedArchive(target: string, revision: string, signal?: AbortSignal): Promise<unknown> {
  const content = await readFile(target, { encoding: "utf8", signal });
  if (digest(content) !== revision) throw new Error("Observation archive is damaged");
  let data: unknown;
  try { data = JSON.parse(content); } catch { throw fail(); }
  if (canonical(data) !== content) throw fail();
  return data;
}

function validate(records: unknown): asserts records is StoredObservation[] {
  if (!Array.isArray(records) || !records.length) throw fail();
  let identity: string | undefined;
  const seen = new Set<number>();
  for (const r of records) {
    if (!object(r) || !["daily_bar", "minute_bar", "adjustment_factor"].includes(r.kind as string)
      || !exactKeys(r, [...baseKeys, ...(r.kind === "adjustment_factor" ? ["factorBasis", "values"] : ["interval", "adjustment", "values"])])
      || r.schemaVersion !== 1 || typeof r.symbol !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.symbol)
      || typeof r.timestamp !== "number" || !Number.isSafeInteger(r.timestamp) || r.timestamp <= 0 || !Number.isFinite(new Date(r.timestamp).getTime())
      || seen.has(r.timestamp) || r.timezone !== "UTC" || unknowns.some(key => r[key] !== "unknown")
      || !sources.has(r.source as string) || typeof r.endpoint !== "string" || !/^\/[A-Za-z0-9/_-]{1,160}$/.test(r.endpoint)
      || typeof r.observedAt !== "string" || !instant(r.observedAt) || !object(r.values)) throw fail();
    seen.add(r.timestamp);
    if (r.kind === "adjustment_factor") {
      if (r.factorBasis !== "unknown" || !exactKeys(r.values, ["factor"]) || !nonnegative(r.values.factor) || r.values.factor === 0) throw fail();
    } else {
      if ((r.kind === "daily_bar" ? r.interval !== "1d" : !minutes.has(r.interval as string))
        || !["forward", "none"].includes(r.adjustment as string)
        || !exactKeys(r.values, ["open", "high", "low", "close", "volume", "amount"])) throw fail();
      const v = r.values;
      if (!nonnegative(v.open) || !nonnegative(v.high) || !nonnegative(v.low) || !nonnegative(v.close) || !nonnegative(v.volume)
        || (v.amount !== null && !nonnegative(v.amount)) || v.high < Math.max(v.open, v.low, v.close) || v.low > Math.min(v.open, v.high, v.close)) throw fail();
    }
    const current = canonical({ kind: r.kind, symbol: r.symbol, source: r.source, endpoint: r.endpoint, observedAt: r.observedAt,
      interval: r.interval ?? null, adjustment: r.adjustment ?? null });
    if (identity !== undefined && identity !== current) throw fail();
    identity = current;
  }
}

function path(ref: ObservationArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "revision"]) || ref.version !== 1 || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(archiveDir(), `${ref.revision}.json`);
}

/** Stores one whole response batch; no head, merge, or coverage checkpoint is created. */
export async function archiveObservations(records: readonly StoredObservation[], signal?: AbortSignal): Promise<ObservationArchiveRef> {
  validate(records);
  const content = canonical({ version: 1, records });
  const ref: ObservationArchiveRef = { version: 1, revision: digest(content) };
  const target = path(ref);
  await mkdir(archiveDir(), { recursive: true });
  await withFileLockAsync(target, async () => {
    signal?.throwIfAborted();
    try {
      const previous = await readFile(target, { encoding: "utf8", signal });
      if (previous !== content) throw new Error("Observation archive is damaged");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWriteTextAsync(target, content, signal);
    }
  }, signal);
  return ref;
}

/** An exact revision is required; a missing or damaged archive never falls back. */
export async function loadObservationArchive(ref: ObservationArchiveRef, signal?: AbortSignal): Promise<StoredObservation[]> {
  const target = path(ref);
  const content = await readFile(target, { encoding: "utf8", signal });
  if (digest(content) !== ref.revision) throw new Error("Observation archive is damaged");
  let data: unknown;
  try { data = JSON.parse(content); } catch { throw fail(); }
  if (!object(data) || !exactKeys(data, ["version", "records"]) || data.version !== 1 || canonical(data) !== content) throw fail();
  validate(data.records);
  return data.records;
}

const datedKeys = ["schemaVersion", "kind", "symbol", "tradeDate", "sourceTimestamp", "requested", "market", "assetType", "calendarTimeZone", "source", "endpoint", "observedAt", "interval", "adjustment", "volumeUnit", "amountUnit", "coverage", "values"];
const shanghai = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
function shanghaiDate(value: number): string {
  const parts = Object.fromEntries(shanghai.formatToParts(value).map(p => [p.type, p.value]));
  return `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`;
}
function validateDated(records: unknown): asserts records is StoredTradingDateBarObservation[] {
  if (!Array.isArray(records) || records.length === 0 || records.length > 366) throw fail();
  const seen = new Set<string>();
  let identity: string | undefined;
  for (const r of records) {
    if (!object(r) || !exactKeys(r, datedKeys) || r.schemaVersion !== 2 || r.kind !== "trading_date_daily_bar"
      || typeof r.symbol !== "string" || isAIndexSymbol(r.symbol)
      || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(r.symbol)
      || r.market !== "A" || r.assetType !== "stock" || r.calendarTimeZone !== "Asia/Shanghai" || r.interval !== "1d"
      || r.coverage !== "unknown" || !["none", "forward"].includes(r.adjustment as string)
      || typeof r.observedAt !== "string" || !instant(r.observedAt) || !object(r.requested)
      || !exactKeys(r.requested, ["startDate", "endDate"]) || typeof r.requested.startDate !== "string"
      || typeof r.requested.endDate !== "string" || !isDailyDate(r.requested.startDate) || !isDailyDate(r.requested.endDate)
      || r.requested.startDate < "0001-01-01" || r.requested.endDate > "9998-12-31" || r.requested.startDate > r.requested.endDate
      || Date.parse(r.requested.endDate) - Date.parse(r.requested.startDate) > 365 * 86_400_000
      || typeof r.tradeDate !== "string" || !isDailyDate(r.tradeDate) || r.tradeDate < r.requested.startDate
      || r.tradeDate > r.requested.endDate || seen.has(r.tradeDate) || !object(r.values)
      || !exactKeys(r.values, ["open", "high", "low", "close", "volume", "amount"])) throw fail();
    if (r.source === "tushare") {
      if (r.endpoint !== "daily" || r.adjustment !== "none" || r.volumeUnit !== "hand" || r.amountUnit !== "CNY-thousand" || r.sourceTimestamp !== null) throw fail();
    } else if (r.source === "tickflow") {
      if (r.endpoint !== "/v1/klines" || r.volumeUnit !== "unknown" || r.amountUnit !== "unknown"
        || typeof r.sourceTimestamp !== "number" || !Number.isSafeInteger(r.sourceTimestamp) || r.sourceTimestamp <= 0
        || !Number.isFinite(new Date(r.sourceTimestamp).getTime()) || shanghaiDate(r.sourceTimestamp) !== r.tradeDate) throw fail();
    } else throw fail();
    const v = r.values;
    if (!nonnegative(v.open) || v.open === 0 || !nonnegative(v.high) || v.high === 0 || !nonnegative(v.low) || v.low === 0
      || !nonnegative(v.close) || v.close === 0 || !nonnegative(v.volume) || (v.amount !== null && !nonnegative(v.amount))
      || v.high < Math.max(v.open, v.low, v.close) || v.low > Math.min(v.open, v.high, v.close)) throw fail();
    seen.add(r.tradeDate);
    const current = canonical({ symbol: r.symbol, source: r.source, endpoint: r.endpoint, observedAt: r.observedAt,
      requested: r.requested, adjustment: r.adjustment, volumeUnit: r.volumeUnit, amountUnit: r.amountUnit });
    if (identity !== undefined && identity !== current) throw fail();
    identity = current;
  }
}
const datedDir = () => join(resolveDataDir(), "observation-archives-v2");
function datedPath(ref: TradingDateArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "revision"]) || ref.version !== 2 || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(datedDir(), `${ref.revision}.json`);
}
/** Explicit immutable write; no collection, cache or checkpoint is performed. */
export async function archiveTradingDateObservations(records: readonly StoredTradingDateBarObservation[], signal?: AbortSignal): Promise<TradingDateArchiveRef> {
  validateDated(records);
  const content = canonical({ version: 2, records });
  const ref: TradingDateArchiveRef = { version: 2, revision: digest(content) };
  await writeFixedArchive(datedDir(), datedPath(ref), content, signal);
  return ref;
}
/** Read only an exact v2 reference and validate both content and identity. */
export async function loadTradingDateArchive(ref: TradingDateArchiveRef, signal?: AbortSignal): Promise<StoredTradingDateBarObservation[]> {
  const data = await readFixedArchive(datedPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "records"]) || data.version !== 2) throw fail();
  validateDated(data.records);
  return data.records;
}

const limitArchiveKind = "daily-trading-limits";
const limitDir = () => join(resolveDataDir(), "trading-limit-archives-v1");
const limitBatchKeys = ["symbol", "market", "source", "endpoint", "observedAt", "coverage", "priceUnit", "requested", "rows"];
const limitRowKeys = ["tradeDate", "previousClose", "limitUp", "limitDown"];

function limitPath(ref: TradingLimitArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 ||
    ref.kind !== limitArchiveKind || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(limitDir(), `${ref.revision}.json`);
}

const positiveOrNull = (value: unknown) => value === null || (nonnegative(value) && value > 0);

function validateTradingLimits(batch: unknown): asserts batch is StoredDailyTradingLimitBatch {
  if (!object(batch) || !exactKeys(batch, limitBatchKeys) || batch.market !== "A" ||
    typeof batch.symbol !== "string" || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(batch.symbol) ||
    batch.source !== "tushare" || batch.endpoint !== "stk_limit" || batch.coverage !== "unknown" || batch.priceUnit !== "CNY" ||
    typeof batch.observedAt !== "string" || !instant(batch.observedAt) ||
    !object(batch.requested) || !exactKeys(batch.requested, ["startDate", "endDate"]) ||
    !Array.isArray(batch.rows) || batch.rows.length === 0 || batch.rows.length > 366) throw fail();
  const { startDate, endDate } = batch.requested;
  if (typeof startDate !== "string" || typeof endDate !== "string" ||
    !isDailyDate(startDate) || !isDailyDate(endDate) || startDate < "0001-01-01" || endDate > "9998-12-31" ||
    startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 365 * 86_400_000) throw fail();
  let previous = "";
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, limitRowKeys) || typeof row.tradeDate !== "string" ||
      !isDailyDate(row.tradeDate) || row.tradeDate < startDate || row.tradeDate > endDate || row.tradeDate <= previous ||
      ![row.previousClose, row.limitUp, row.limitDown].every(positiveOrNull) ||
      (typeof row.limitUp === "number" && typeof row.limitDown === "number" && row.limitUp < row.limitDown)) throw fail();
    previous = row.tradeDate;
  }
}

/** Store one selected provider response without calculating formula thresholds. */
export async function archiveDailyTradingLimits(batch: StoredDailyTradingLimitBatch, signal?: AbortSignal): Promise<TradingLimitArchiveRef> {
  validateTradingLimits(batch);
  const content = canonical({ version: 1, kind: limitArchiveKind, batch });
  const ref: TradingLimitArchiveRef = { version: 1, kind: limitArchiveKind, revision: digest(content) };
  await writeFixedArchive(limitDir(), limitPath(ref), content, signal);
  return ref;
}

/** Read only the supplied reference. */
export async function loadDailyTradingLimitArchive(ref: TradingLimitArchiveRef, signal?: AbortSignal): Promise<StoredDailyTradingLimitBatch> {
  const data = await readFixedArchive(limitPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== limitArchiveKind) throw fail();
  validateTradingLimits(data.batch);
  return data.batch;
}

const historicalMinuteKind = "historical-minute-bars";
const historicalMinuteDir = () => join(resolveDataDir(), "historical-minute-archives-v1");
const historicalMinuteBatchKeys = [
  "symbol", "market", "source", "endpoint", "observedAt", "coverage", "finality", "adjustment", "timeZone",
  "interval", "volumeUnit", "amountUnit", "requested", "rows",
];
const historicalMinuteRowKeys = ["tradeTime", "openingBoundary", "open", "high", "low", "close", "volume", "amount"];
const historicalMinuteTime = /^(\d{4}-\d{2}-\d{2}) (09:[3-5]\d|10:[0-5]\d|11:(?:[0-2]\d|30)|1[34]:[0-5]\d|15:00):00$/;

function historicalMinutePath(ref: HistoricalMinuteArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 ||
    ref.kind !== historicalMinuteKind || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(historicalMinuteDir(), `${ref.revision}.json`);
}

function validateHistoricalMinutes(batch: unknown): asserts batch is StoredHistoricalMinuteBatch {
  if (!object(batch) || !exactKeys(batch, historicalMinuteBatchKeys) || batch.market !== "A" ||
    typeof batch.symbol !== "string" || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(batch.symbol) ||
    batch.source !== "tushare" || batch.endpoint !== "stk_mins" || typeof batch.observedAt !== "string" || !instant(batch.observedAt) ||
    batch.timeZone !== "Asia/Shanghai" || batch.interval !== "1m" || batch.volumeUnit !== "share" || batch.amountUnit !== "CNY" ||
    batch.coverage !== "unknown" || batch.finality !== "unknown" || batch.adjustment !== "unknown" ||
    !object(batch.requested) || !exactKeys(batch.requested, ["startDate", "endDate"]) ||
    !Array.isArray(batch.rows) || batch.rows.length === 0 || batch.rows.length >= 8000) throw fail();
  const { startDate, endDate } = batch.requested;
  if (typeof startDate !== "string" || typeof endDate !== "string" || !isDailyDate(startDate) || !isDailyDate(endDate) ||
    startDate < "2010-01-01" || endDate > "9998-12-31" || startDate > endDate ||
    endDate >= shanghaiDate(Date.parse(batch.observedAt)) || Date.parse(endDate) - Date.parse(startDate) > 30 * 86_400_000) throw fail();
  let previous = "";
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, historicalMinuteRowKeys) || typeof row.tradeTime !== "string" || row.tradeTime <= previous) throw fail();
    const label = historicalMinuteTime.exec(row.tradeTime);
    if (!label || !isDailyDate(label[1]!) || label[1]! < startDate || label[1]! > endDate ||
      row.openingBoundary !== (label[2] === "09:30") || !nonnegative(row.open) || !nonnegative(row.high) ||
      !nonnegative(row.low) || !nonnegative(row.close) || row.low === 0 ||
      row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) ||
      !nonnegative(row.volume) || !Number.isSafeInteger(row.volume) || (row.amount !== null && !nonnegative(row.amount))) throw fail();
    previous = row.tradeTime;
  }
}

/** Store original Shanghai time labels and units for a single historical minute response. */
export async function archiveHistoricalMinuteObservations(batch: StoredHistoricalMinuteBatch, signal?: AbortSignal): Promise<HistoricalMinuteArchiveRef> {
  validateHistoricalMinutes(batch);
  const content = canonical({ version: 1, kind: historicalMinuteKind, batch });
  const ref: HistoricalMinuteArchiveRef = { version: 1, kind: historicalMinuteKind, revision: digest(content) };
  await writeFixedArchive(historicalMinuteDir(), historicalMinutePath(ref), content, signal);
  return ref;
}

export async function loadHistoricalMinuteArchive(ref: HistoricalMinuteArchiveRef, signal?: AbortSignal): Promise<StoredHistoricalMinuteBatch> {
  const data = await readFixedArchive(historicalMinutePath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== historicalMinuteKind) throw fail();
  validateHistoricalMinutes(data.batch);
  return data.batch;
}

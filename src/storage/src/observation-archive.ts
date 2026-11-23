/** Immutable Source observations, independent of provider clients and the daily-bar cache. */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatedDragonTigerBoard, DragonTigerArchiveRef } from "../../types/dragon-tiger.ts";
import type { MoneyFlowArchiveRef, StoredMoneyFlowBatch } from "../../types/money-flow.ts";
import type { DatedPopularityList, PopularityArchiveRef } from "../../types/popularity.ts";
import type { AuctionBenchmarkArchiveRef, BenchmarkIndexArchiveRef, DatedEtfDailyArchiveRef, DatedIndexDailyArchiveRef, DatedIndexMinuteArchiveRef, DepthSnapshotArchiveRef, FinancialObservationArchiveRef,
  HistoricalMinuteArchiveRef, MarketCrossSectionArchiveRef, MarketRegimeManifestRef, ObservationArchiveRef, QuotePollArchiveRef, RiskWarningArchiveRef, SectorObservationArchiveRef,
  StoredAuctionBenchmark, StoredBenchmarkIndexBatch, StoredDailyTradingLimitBatch, StoredDatedEtfDailyBatch, StoredDatedIndexDailyBatch, StoredDatedIndexMinuteBatch, StoredDepthSnapshot,
  StoredFinancialObservationBatch, StoredHistoricalMinuteBatch, StoredMarketCrossSection, StoredObservation,
  StoredQuotePollCapture, StoredRiskWarningBatch, StoredSectorObservationBatch, StoredTradingDateBarObservation,
  TradingDateArchiveRef, TradingLimitArchiveRef } from "../../types/observation.ts";
import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol, isDatedBenchmarkIndexSymbol, isDatedEtfSymbol } from "../../market/symbols.ts";
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

async function readFixedArchive(target: string, revision: string, signal?: AbortSignal, maxBytes?: number): Promise<unknown> {
  signal?.throwIfAborted();
  if (maxBytes !== undefined && (await stat(target)).size > maxBytes) throw fail();
  const content = await readFile(target, { encoding: "utf8", signal });
  if (maxBytes !== undefined && Buffer.byteLength(content) > maxBytes) throw fail();
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

const financialDir = () => join(resolveDataDir(), "financial-observation-archives-v1");
const financialKinds = { fina_indicator: "report-financial-indicators", disclosure_date: "financial-disclosure-dates" } as const;
const financialBatchKeys = ["symbol", "market", "source", "endpoint", "observedAt", "coverage", "requested", "rows"];
const reportNumberFields = ["bookValuePerShare", "roe", "grossProfitMargin", "netProfitMargin", "operatingRevenueYoyPct",
  "totalOperatingRevenueYoyPct", "parentNetProfitYoyPct", "debtToAssets"];
const indicatorFields = ["periodEnd", "announcementDate", "updateFlag", "bookValueCurrency", "ratioUnit", ...reportNumberFields];
const indicatorFieldsWithEps = [...indicatorFields, "basicEarningsPerShare", "earningsPerShareCurrency"];
const disclosureDates = ["planAnnouncementDate", "plannedDisclosureDate", "actualDisclosureDate"];
const disclosureFields = ["periodEnd", "modificationRecord", ...disclosureDates];

function financialPath(ref: FinancialObservationArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 ||
    !Object.values(financialKinds).includes(ref.kind) || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(financialDir(), `${ref.revision}.json`);
}

const dailyDate = (value: unknown): value is string => typeof value === "string" && isDailyDate(value);
const optionalDate = (value: unknown): boolean => value === null || dailyDate(value);
const optionalText = (value: unknown): boolean => value === null || (typeof value === "string" && value.trim().length > 0);

function validateFinancialBatch(batch: unknown): asserts batch is StoredFinancialObservationBatch {
  if (!object(batch) || !exactKeys(batch, financialBatchKeys) || batch.market !== "A" || batch.source !== "tushare" ||
    typeof batch.symbol !== "string" || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:[48]\d{5}|92\d{4})\.BJ)$/.test(batch.symbol) ||
    isAIndexSymbol(batch.symbol) || batch.coverage !== "unknown" || typeof batch.observedAt !== "string" || !instant(batch.observedAt) ||
    !object(batch.requested) || !Array.isArray(batch.rows)) throw fail();

  const { requested, rows } = batch;
  if (batch.endpoint === "fina_indicator") {
    const { startPeriod, endPeriod } = requested;
    if (!exactKeys(requested, ["startPeriod", "endPeriod"]) || !dailyDate(startPeriod) || !dailyDate(endPeriod) ||
      startPeriod > endPeriod || rows.length >= 100) throw fail();
    for (const row of rows) {
      if (!object(row)) throw fail();
      const hasEps = Object.hasOwn(row, "basicEarningsPerShare");
      if (!exactKeys(row, hasEps ? indicatorFieldsWithEps : indicatorFields) || !dailyDate(row.periodEnd) ||
        row.periodEnd < startPeriod || row.periodEnd > endPeriod || !optionalDate(row.announcementDate) || !optionalText(row.updateFlag) ||
        row.bookValueCurrency !== "unknown" || row.ratioUnit !== "provider-native" ||
        (hasEps && (!finiteOrNull(row.basicEarningsPerShare) || row.earningsPerShareCurrency !== "unknown")) ||
        reportNumberFields.some(field => row[field] !== null && (typeof row[field] !== "number" || !Number.isFinite(row[field])))) throw fail();
    }
  } else if (batch.endpoint === "disclosure_date") {
    if (!exactKeys(requested, ["periodEnd"]) || !dailyDate(requested.periodEnd) || rows.length >= 6000) throw fail();
    for (const row of rows) {
      if (!object(row) || !exactKeys(row, disclosureFields) || row.periodEnd !== requested.periodEnd ||
        !optionalText(row.modificationRecord) || disclosureDates.some(field => !optionalDate(row[field]))) throw fail();
    }
  } else throw fail();
}

/** Save either provider response as captured, retaining repeated periods and row order. */
export async function archiveFinancialObservations(batch: StoredFinancialObservationBatch, signal?: AbortSignal): Promise<FinancialObservationArchiveRef> {
  validateFinancialBatch(batch);
  const kind = financialKinds[batch.endpoint];
  const content = canonical({ version: 1, kind, batch });
  const ref: FinancialObservationArchiveRef = { version: 1, kind, revision: digest(content) };
  await writeFixedArchive(financialDir(), financialPath(ref), content, signal);
  return ref;
}

export async function loadFinancialObservationArchive(ref: FinancialObservationArchiveRef, signal?: AbortSignal): Promise<StoredFinancialObservationBatch> {
  const path = financialPath(ref);
  const { kind, revision } = ref;
  const data = await readFixedArchive(path, revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== kind) throw fail();
  validateFinancialBatch(data.batch);
  if (financialKinds[data.batch.endpoint] !== kind) throw fail();
  return data.batch;
}

const marketSectionKind = "market-cross-section";
const marketSectionDir = () => join(resolveDataDir(), "market-cross-section-archives-v1");
const stockSymbol = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const finiteOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
const nonnegativeOrNull = (value: unknown) => value === null || nonnegative(value);

function marketSectionPath(ref: MarketCrossSectionArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 ||
    ref.kind !== marketSectionKind || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(marketSectionDir(), `${ref.revision}.json`);
}

function marketSlice(value: unknown, endpoint: string, tradeDate: string, keys: string[]) {
  if (!object(value) || !exactKeys(value, ["endpoint", "tradeDate", "observedAt", "coverage", ...keys]) ||
    value.endpoint !== endpoint || value.tradeDate !== tradeDate || value.coverage !== "unknown" ||
    typeof value.observedAt !== "string" || !instant(value.observedAt) || tradeDate > shanghaiDate(Date.parse(value.observedAt))) throw fail();
  return value;
}

function marketRows(rows: unknown, max: number, keys: string[], valid: (row: Record<string, unknown>) => boolean) {
  if (!Array.isArray(rows) || rows.length > max) throw fail();
  let previous = "";
  for (const row of rows) {
    if (!object(row) || !exactKeys(row, ["symbol", ...keys]) || typeof row.symbol !== "string" ||
      !stockSymbol.test(row.symbol) || row.symbol <= previous || !valid(row)) throw fail();
    previous = row.symbol;
  }
}

const basicNonnegativeFields = ["close", "turnoverPct", "freeFloatTurnoverPct", "providerVolumeRatio",
  "totalShares", "floatShares", "freeFloatShares", "totalMarketValue", "circulatingMarketValue"];

function validateMarketSection(batch: unknown): asserts batch is StoredMarketCrossSection {
  if (!object(batch) || !exactKeys(batch, ["source", "market", "tradeDate", "universe", "bars", "basics"]) ||
    batch.source !== "tushare" || batch.market !== "A" || typeof batch.tradeDate !== "string" ||
    !isDailyDate(batch.tradeDate) || batch.tradeDate < "2016-01-01" || batch.tradeDate > "9998-12-31") throw fail();

  const { tradeDate } = batch;
  const universe = marketSlice(batch.universe, "bak_basic", tradeDate, ["universe", "members"]);
  if (universe.universe !== "provider-dated-stocks") throw fail();
  marketRows(universe.members, 6999, ["name", "industry", "listedOn"], row =>
    typeof row.name === "string" && !!row.name.trim() && (row.industry === null || typeof row.industry === "string") &&
    (row.listedOn === null || (typeof row.listedOn === "string" && isDailyDate(row.listedOn) &&
      row.listedOn >= "0001-01-01" && row.listedOn <= tradeDate)));

  const bars = marketSlice(batch.bars, "daily", tradeDate, ["adjustment", "priceUnit", "volumeUnit", "amountUnit", "rows"]);
  if (bars.adjustment !== "none" || bars.priceUnit !== "CNY" || bars.volumeUnit !== "hand" || bars.amountUnit !== "CNY-thousand") throw fail();
  marketRows(bars.rows, 5999, ["open", "high", "low", "close", "exRightsPreviousClose", "returnPct", "changeCny", "volume", "amount"],
    row => nonnegative(row.open) && nonnegative(row.high) && nonnegative(row.low) && nonnegative(row.close) && row.low > 0 &&
      row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close) &&
      positiveOrNull(row.exRightsPreviousClose) && finiteOrNull(row.changeCny) &&
      (row.returnPct === null || (typeof row.returnPct === "number" && Number.isFinite(row.returnPct) && row.returnPct >= -100)) &&
      nonnegativeOrNull(row.volume) && nonnegativeOrNull(row.amount));

  const basics = marketSlice(batch.basics, "daily_basic", tradeDate, ["priceUnit", "shareUnit", "marketValueUnit", "rows"]);
  if (basics.priceUnit !== "CNY" || basics.shareUnit !== "ten-thousand-shares" || basics.marketValueUnit !== "CNY-ten-thousand") throw fail();
  marketRows(basics.rows, 5999, [...basicNonnegativeFields, "pe", "peTtm", "pb"], row =>
    basicNonnegativeFields.every(key => nonnegativeOrNull(row[key])) && [row.pe, row.peTtm, row.pb].every(finiteOrNull));
}

/** Keep each normalized response with its own capture time and native units. */
export async function archiveMarketCrossSection(batch: StoredMarketCrossSection, signal?: AbortSignal): Promise<MarketCrossSectionArchiveRef> {
  validateMarketSection(batch);
  const content = canonical({ version: 1, kind: marketSectionKind, batch });
  const ref: MarketCrossSectionArchiveRef = { version: 1, kind: marketSectionKind, revision: digest(content) };
  await writeFixedArchive(marketSectionDir(), marketSectionPath(ref), content, signal);
  return ref;
}

export async function loadMarketCrossSectionArchive(ref: MarketCrossSectionArchiveRef, signal?: AbortSignal): Promise<StoredMarketCrossSection> {
  const data = await readFixedArchive(marketSectionPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== marketSectionKind) throw fail();
  validateMarketSection(data.batch);
  return data.batch;
}

const depthKind = "depth-snapshot";
const depthDir = () => join(resolveDataDir(), "depth-snapshot-archives-v1");
const depthBatchKeys = ["source", "endpoint", "market", "tradeDate", "observedAt", "coverage", "volumeUnit", "requestedSymbols", "rows"];
const depthLevelKeys = ["price", "volume"];

function depthPath(ref: DepthSnapshotArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== depthKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(depthDir(), `${ref.revision}.json`);
}

function validDepthLevels(levels: unknown, descending: boolean): boolean {
  if (!Array.isArray(levels) || levels.length > 5) return false;
  let previous: number | undefined;
  for (const level of levels) {
    if (!object(level) || !exactKeys(level, depthLevelKeys) || !nonnegative(level.price) ||
      !nonnegative(level.volume) || !Number.isSafeInteger(level.volume)) return false;
    if (level.price === 0) continue;
    if (previous !== undefined && (descending ? level.price > previous : level.price < previous)) return false;
    previous = level.price;
  }
  return true;
}

function validateDepthSnapshot(batch: unknown): asserts batch is StoredDepthSnapshot {
  if (!object(batch) || !exactKeys(batch, depthBatchKeys) || batch.source !== "tickflow" ||
    (batch.endpoint !== "/v1/depth" && batch.endpoint !== "/v1/depth/batch") ||
    batch.market !== "A" || batch.coverage !== "unknown" || batch.volumeUnit !== "unknown" || !dailyDate(batch.tradeDate) ||
    typeof batch.observedAt !== "string" || !instant(batch.observedAt) || !Array.isArray(batch.requestedSymbols) ||
    batch.requestedSymbols.length === 0 || batch.requestedSymbols.length > 6_999) throw fail();
  const { tradeDate, requestedSymbols } = batch;
  const capturedAt = Date.parse(batch.observedAt);
  if (tradeDate > shanghaiDate(capturedAt) || requestedSymbols.some((symbol, index) =>
    typeof symbol !== "string" || !stockSymbol.test(symbol) || (index > 0 && symbol <= requestedSymbols[index - 1]))) throw fail();
  const scope = new Set(requestedSymbols);
  marketRows(batch.rows, requestedSymbols.length, ["timestamp", "bids", "asks"], ({ symbol, timestamp, bids, asks }) =>
    scope.has(symbol) && typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0 &&
    timestamp <= capturedAt && shanghaiDate(timestamp) === tradeDate && validDepthLevels(bids, true) && validDepthLevels(asks, false));
}

export async function archiveDepthSnapshot(batch: StoredDepthSnapshot, signal?: AbortSignal): Promise<DepthSnapshotArchiveRef> {
  validateDepthSnapshot(batch);
  const content = canonical({ version: 1, kind: depthKind, batch });
  const ref: DepthSnapshotArchiveRef = { version: 1, kind: depthKind, revision: digest(content) };
  await writeFixedArchive(depthDir(), depthPath(ref), content, signal);
  return ref;
}

export async function loadDepthSnapshotArchive(ref: DepthSnapshotArchiveRef, signal?: AbortSignal): Promise<StoredDepthSnapshot> {
  const data = await readFixedArchive(depthPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== depthKind) throw fail();
  validateDepthSnapshot(data.batch);
  return data.batch;
}

const quotePollKind = "quote-poll";
const quotePollDir = () => join(resolveDataDir(), "quote-poll-archives-v1");
const quotePollKeys = ["source", "endpoint", "market", "tradeDate", "startedAt", "observedAt", "coverage", "units", "requestedSymbols", "rows"];

function quotePollPath(ref: QuotePollArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== quotePollKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(quotePollDir(), `${ref.revision}.json`);
}

function validateQuotePollCapture(capture: unknown): asserts capture is StoredQuotePollCapture {
  if (!object(capture) || !exactKeys(capture, quotePollKeys) || capture.source !== "tickflow" || capture.endpoint !== "/v1/quotes" ||
    capture.market !== "A" || capture.coverage !== "unknown" || capture.units !== "unknown" || !dailyDate(capture.tradeDate) ||
    typeof capture.startedAt !== "string" || !instant(capture.startedAt) || typeof capture.observedAt !== "string" || !instant(capture.observedAt) ||
    !Array.isArray(capture.requestedSymbols) || !capture.requestedSymbols.length || capture.requestedSymbols.length > 6_999) throw fail();
  const { tradeDate, requestedSymbols } = capture;
  const start = Date.parse(capture.startedAt), end = Date.parse(capture.observedAt);
  if (start > end || shanghaiDate(start) !== tradeDate || shanghaiDate(end) !== tradeDate ||
    requestedSymbols.some((symbol, index) => typeof symbol !== "string" || !stockSymbol.test(symbol) ||
      (index > 0 && symbol <= requestedSymbols[index - 1]))) throw fail();
  const scope = new Set(requestedSymbols);
  marketRows(capture.rows, scope.size, ["timestamp", "receivedAt", "lastPrice", "previousClose", "volume", "amount"], row => {
    const { symbol, timestamp, receivedAt, lastPrice, previousClose, volume, amount } = row;
    if (typeof symbol !== "string" || !scope.has(symbol) || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 || typeof receivedAt !== "string" || !instant(receivedAt)) return false;
    const received = Date.parse(receivedAt);
    return received >= start && received <= end && timestamp <= received && shanghaiDate(timestamp) === tradeDate &&
      nonnegative(lastPrice) && nonnegative(previousClose) && nonnegative(volume) && nonnegativeOrNull(amount);
  });
}

export async function archiveQuotePollCapture(capture: StoredQuotePollCapture, signal?: AbortSignal): Promise<QuotePollArchiveRef> {
  validateQuotePollCapture(capture);
  const content = canonical({ version: 1, kind: quotePollKind, capture });
  const ref: QuotePollArchiveRef = { version: 1, kind: quotePollKind, revision: digest(content) };
  await writeFixedArchive(quotePollDir(), quotePollPath(ref), content, signal);
  return ref;
}

export async function loadQuotePollArchive(ref: QuotePollArchiveRef, signal?: AbortSignal): Promise<StoredQuotePollCapture> {
  const data = await readFixedArchive(quotePollPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "capture"]) || data.version !== 1 || data.kind !== quotePollKind) throw fail();
  validateQuotePollCapture(data.capture);
  return data.capture;
}

const sectorDir = () => join(resolveDataDir(), "sector-observation-archives-v1");
const sectorArchiveKinds = { dc_index: "dated-sector-catalog", dc_member: "dated-sector-members" } as const;
const sectorBatchKeys = ["market", "source", "tradeDate", "observedAt", "coverage", "taxonomy", "endpoint"];
const sectorCodePattern = /^BK\d{4,8}\.DC$/;
const sectorStockPattern = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:[48]\d{5}|92\d{4})\.BJ)$/;

function sectorPath(ref: SectorObservationArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 ||
    !Object.values(sectorArchiveKinds).includes(ref.kind) || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(sectorDir(), `${ref.revision}.json`);
}

function validateSectorBatch(batch: unknown): asserts batch is StoredSectorObservationBatch {
  if (!object(batch) || batch.market !== "A" || batch.source !== "tushare" || batch.taxonomy !== "eastmoney" ||
    batch.coverage !== "unknown" || !dailyDate(batch.tradeDate) || typeof batch.observedAt !== "string" || !instant(batch.observedAt)) throw fail();
  const seen = new Set<string>();
  if (batch.endpoint === "dc_index") {
    if (!exactKeys(batch, [...sectorBatchKeys, "kind", "providerType", "groups"]) ||
      (batch.kind !== "industry" && batch.kind !== "concept") || batch.providerType !== (batch.kind === "industry" ? "行业板块" : "概念板块") ||
      !Array.isArray(batch.groups) || batch.groups.length >= 5_000) throw fail();
    for (const group of batch.groups) {
      if (!object(group) || !exactKeys(group, ["code", "name", "level"]) || typeof group.code !== "string" || !sectorCodePattern.test(group.code) ||
        seen.has(group.code) || typeof group.name !== "string" || !group.name.trim() || !optionalText(group.level)) throw fail();
      seen.add(group.code);
    }
  } else if (batch.endpoint === "dc_member") {
    if (!exactKeys(batch, [...sectorBatchKeys, "sectorCode", "members"]) || batch.tradeDate < "2024-12-20" ||
      typeof batch.sectorCode !== "string" || !sectorCodePattern.test(batch.sectorCode) ||
      !Array.isArray(batch.members) || batch.members.length >= 5_000) throw fail();
    for (const member of batch.members) {
      if (!object(member) || !exactKeys(member, ["symbol", "name"]) || typeof member.symbol !== "string" ||
        !sectorStockPattern.test(member.symbol) || isAIndexSymbol(member.symbol) || seen.has(member.symbol) || !optionalText(member.name)) throw fail();
      seen.add(member.symbol);
    }
  } else throw fail();
}

/** Preserve one sector catalog or membership response and its own acquisition time. */
export async function archiveSectorObservations(batch: StoredSectorObservationBatch, signal?: AbortSignal): Promise<SectorObservationArchiveRef> {
  validateSectorBatch(batch);
  const kind = sectorArchiveKinds[batch.endpoint];
  const content = canonical({ version: 1, kind, batch });
  const ref: SectorObservationArchiveRef = { version: 1, kind, revision: digest(content) };
  await writeFixedArchive(sectorDir(), sectorPath(ref), content, signal);
  return ref;
}

export async function loadSectorObservationArchive(ref: SectorObservationArchiveRef, signal?: AbortSignal): Promise<StoredSectorObservationBatch> {
  const path = sectorPath(ref);
  const { kind, revision } = ref;
  const data = await readFixedArchive(path, revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== kind) throw fail();
  validateSectorBatch(data.batch);
  if (sectorArchiveKinds[data.batch.endpoint] !== kind) throw fail();
  return data.batch;
}

const benchmarkIndexKind = "benchmark-index";
const benchmarkIndexDir = () => join(resolveDataDir(), "benchmark-index-archives-v1");
const benchmarkIndexKeys = ["symbol", "source", "market", "endpoint", "observedAt", "coverage", "requested", "priceUnit", "returnUnit", "rows"];
const benchmarkIndexRowKeys = ["tradeDate", "closePoints", "previousClosePoints", "changePoints", "returnPct"];

function benchmarkIndexPath(ref: BenchmarkIndexArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== benchmarkIndexKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(benchmarkIndexDir(), `${ref.revision}.json`);
}

function validateBenchmarkIndex(batch: unknown): asserts batch is StoredBenchmarkIndexBatch {
  if (!object(batch) || !exactKeys(batch, benchmarkIndexKeys) || batch.market !== "A" ||
    batch.coverage !== "unknown" || batch.priceUnit !== "index-points" ||
    batch.returnUnit !== "percentage-points" || typeof batch.symbol !== "string" || !isDatedBenchmarkIndexSymbol(batch.symbol) ||
    typeof batch.observedAt !== "string" || !instant(batch.observedAt) || !object(batch.requested) ||
    !exactKeys(batch.requested, ["start", "end"]) || !Array.isArray(batch.rows)) throw fail();
  const tickflow = batch.source === "tickflow" && batch.endpoint === "/v1/klines";
  const tushare = batch.source === "tushare" && batch.endpoint === "index_daily" && !batch.symbol.endsWith(".BJ");
  if (!tickflow && !tushare) throw fail();
  const { start, end } = batch.requested;
  if (!dailyDate(start) || !dailyDate(end) || start > end) throw fail();
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days > 366 || batch.rows.length > days) throw fail();

  const capturedAt = Date.parse(batch.observedAt);
  const observedDate = shanghaiDate(capturedAt);
  const rowKeys = tickflow ? [...benchmarkIndexRowKeys, "sourceTimestamp"] : benchmarkIndexRowKeys;
  let previousDate = "";
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, rowKeys) || !dailyDate(row.tradeDate) || row.tradeDate < start ||
      row.tradeDate > end || row.tradeDate > observedDate || row.tradeDate <= previousDate ||
      !nonnegative(row.closePoints) || row.closePoints === 0 || !positiveOrNull(row.previousClosePoints) ||
      !finiteOrNull(row.changePoints) || (row.returnPct !== null &&
        (typeof row.returnPct !== "number" || !Number.isFinite(row.returnPct) || row.returnPct < -100))) throw fail();
    if (tickflow) {
      const { sourceTimestamp } = row;
      if (typeof sourceTimestamp !== "number" || !Number.isSafeInteger(sourceTimestamp) || sourceTimestamp <= 0 || sourceTimestamp > capturedAt ||
        shanghaiDate(sourceTimestamp) !== row.tradeDate || row.previousClosePoints !== null || row.changePoints !== null ||
        row.returnPct !== null) throw fail();
    }
    previousDate = row.tradeDate;
  }
}

export async function archiveBenchmarkIndexObservations(batch: StoredBenchmarkIndexBatch, signal?: AbortSignal): Promise<BenchmarkIndexArchiveRef> {
  validateBenchmarkIndex(batch);
  const content = canonical({ version: 1, kind: benchmarkIndexKind, batch });
  const ref: BenchmarkIndexArchiveRef = { version: 1, kind: benchmarkIndexKind, revision: digest(content) };
  await writeFixedArchive(benchmarkIndexDir(), benchmarkIndexPath(ref), content, signal);
  return ref;
}

export async function loadBenchmarkIndexArchive(ref: BenchmarkIndexArchiveRef, signal?: AbortSignal): Promise<StoredBenchmarkIndexBatch> {
  const data = await readFixedArchive(benchmarkIndexPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== benchmarkIndexKind) throw fail();
  validateBenchmarkIndex(data.batch);
  return data.batch;
}

const datedIndexMinuteKind = "dated-index-minute";
const datedIndexMinuteDir = () => join(resolveDataDir(), "dated-index-minute-archives-v1");
const datedIndexBatchKeys = ["source", "endpoint", "market", "symbol", "observedAt", "coverage",
  "interval", "priceBasis", "priceUnit", "volumeUnit", "amountUnit", "timeZone", "timestampLabel", "rows"];
const datedIndexBarKeys = ["sourceTimestamp", "openPoints", "highPoints", "lowPoints", "closePoints", "volume", "amount"];

function datedIndexMinutePath(ref: DatedIndexMinuteArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== datedIndexMinuteKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(datedIndexMinuteDir(), `${ref.revision}.json`);
}

function validIndexBarValues(row: Record<string, unknown>): boolean {
  return nonnegative(row.openPoints) && nonnegative(row.highPoints) && nonnegative(row.lowPoints) && nonnegative(row.closePoints) &&
    row.lowPoints > 0 && row.highPoints >= Math.max(row.openPoints, row.closePoints) &&
    row.lowPoints <= Math.min(row.openPoints, row.closePoints) &&
    nonnegative(row.volume) && (row.amount === null || nonnegative(row.amount));
}

function validateDatedIndexMinutes(batch: unknown): asserts batch is StoredDatedIndexMinuteBatch {
  if (!object(batch) || !exactKeys(batch, [...datedIndexBatchKeys, "tradeDate"]) || batch.source !== "tickflow" ||
    batch.endpoint !== "/v1/klines" || batch.market !== "A" || typeof batch.symbol !== "string" ||
    !isDatedBenchmarkIndexSymbol(batch.symbol) || !dailyDate(batch.tradeDate) || batch.tradeDate < "0001-01-01" ||
    typeof batch.observedAt !== "string" || !instant(batch.observedAt) || batch.coverage !== "unknown" ||
    batch.interval !== "1m" || batch.priceBasis !== "index-level" || batch.priceUnit !== "index-points" ||
    batch.volumeUnit !== "provider-native" || batch.amountUnit !== "provider-native" || batch.timeZone !== "Asia/Shanghai" ||
    batch.timestampLabel !== "provider-native" || !Array.isArray(batch.rows) || batch.rows.length >= 10_000) throw fail();

  const capturedAt = Date.parse(batch.observedAt);
  if (batch.tradeDate >= shanghaiDate(capturedAt)) throw fail();
  const start = Date.parse(batch.tradeDate + "T09:25:00+08:00");
  const end = Date.parse(batch.tradeDate + "T15:05:00+08:00");
  let previous = 0;
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, datedIndexBarKeys) ||
      typeof row.sourceTimestamp !== "number" || !Number.isSafeInteger(row.sourceTimestamp) ||
      row.sourceTimestamp <= previous || row.sourceTimestamp < start || row.sourceTimestamp > end ||
      !validIndexBarValues(row)) throw fail();
    previous = row.sourceTimestamp;
  }
}

export async function archiveDatedIndexMinutes(batch: StoredDatedIndexMinuteBatch, signal?: AbortSignal): Promise<DatedIndexMinuteArchiveRef> {
  validateDatedIndexMinutes(batch);
  const content = canonical({ version: 1, kind: datedIndexMinuteKind, batch });
  const ref: DatedIndexMinuteArchiveRef = { version: 1, kind: datedIndexMinuteKind, revision: digest(content) };
  await writeFixedArchive(datedIndexMinuteDir(), datedIndexMinutePath(ref), content, signal);
  return ref;
}

export async function loadDatedIndexMinuteArchive(ref: DatedIndexMinuteArchiveRef, signal?: AbortSignal): Promise<StoredDatedIndexMinuteBatch> {
  const data = await readFixedArchive(datedIndexMinutePath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== datedIndexMinuteKind) throw fail();
  validateDatedIndexMinutes(data.batch);
  return data.batch;
}

const datedIndexDailyKind = "dated-index-daily";
const datedIndexDailyDir = () => join(resolveDataDir(), "dated-index-daily-archives-v1");
const datedIndexDailyKeys = [...datedIndexBatchKeys, "requested"];
const datedIndexDailyRowKeys = [...datedIndexBarKeys, "tradeDate"];

function datedIndexDailyPath(ref: DatedIndexDailyArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== datedIndexDailyKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(datedIndexDailyDir(), `${ref.revision}.json`);
}

function validateDatedIndexDaily(batch: unknown): asserts batch is StoredDatedIndexDailyBatch {
  if (!object(batch) || !exactKeys(batch, datedIndexDailyKeys) || batch.source !== "tickflow" ||
    batch.endpoint !== "/v1/klines" || batch.market !== "A" || typeof batch.symbol !== "string" ||
    !isDatedBenchmarkIndexSymbol(batch.symbol) || typeof batch.observedAt !== "string" || !instant(batch.observedAt) ||
    batch.coverage !== "unknown" || batch.interval !== "1d" || batch.priceBasis !== "index-level" ||
    batch.priceUnit !== "index-points" || batch.volumeUnit !== "provider-native" || batch.amountUnit !== "provider-native" ||
    batch.timeZone !== "Asia/Shanghai" || batch.timestampLabel !== "provider-native" ||
    !object(batch.requested) || !exactKeys(batch.requested, ["start", "end"]) || !Array.isArray(batch.rows)) throw fail();

  const capturedAt = Date.parse(batch.observedAt);
  const { start, end } = batch.requested;
  if (!dailyDate(start) || !dailyDate(end) || start < "0001-01-01" || start > end || end >= shanghaiDate(capturedAt)) throw fail();
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days > 366 || batch.rows.length > days) throw fail();

  let previousDate = "";
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, datedIndexDailyRowKeys) || !dailyDate(row.tradeDate) ||
      row.tradeDate < start || row.tradeDate > end || row.tradeDate <= previousDate ||
      typeof row.sourceTimestamp !== "number" || !Number.isSafeInteger(row.sourceTimestamp) ||
      row.sourceTimestamp <= 0 || row.sourceTimestamp > capturedAt || shanghaiDate(row.sourceTimestamp) !== row.tradeDate ||
      !validIndexBarValues(row)) throw fail();
    previousDate = row.tradeDate;
  }
}

export async function archiveDatedIndexDailyBars(batch: StoredDatedIndexDailyBatch, signal?: AbortSignal): Promise<DatedIndexDailyArchiveRef> {
  validateDatedIndexDaily(batch);
  const content = canonical({ version: 1, kind: datedIndexDailyKind, batch });
  const ref: DatedIndexDailyArchiveRef = { version: 1, kind: datedIndexDailyKind, revision: digest(content) };
  await writeFixedArchive(datedIndexDailyDir(), datedIndexDailyPath(ref), content, signal);
  return ref;
}

export async function loadDatedIndexDailyArchive(ref: DatedIndexDailyArchiveRef, signal?: AbortSignal): Promise<StoredDatedIndexDailyBatch> {
  const data = await readFixedArchive(datedIndexDailyPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== datedIndexDailyKind) throw fail();
  validateDatedIndexDaily(data.batch);
  return data.batch;
}

const datedEtfDailyKind = "dated-etf-daily";
const datedEtfDailyDir = () => join(resolveDataDir(), "dated-etf-daily-archives-v1");
const datedEtfDailyKeys = ["market", "assetType", "symbol", "source", "endpoint", "requested", "observedAt",
  "coverage", "interval", "adjustment", "priceUnit", "volumeUnit", "amountUnit", "timeZone", "rows"];
const datedEtfDailyRowKeys = ["tradeDate", "sourceTimestamp", "open", "high", "low", "close", "volume", "amount"];

function datedEtfDailyPath(ref: DatedEtfDailyArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== datedEtfDailyKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(datedEtfDailyDir(), `${ref.revision}.json`);
}

function validateDatedEtfDaily(batch: unknown): asserts batch is StoredDatedEtfDailyBatch {
  if (!object(batch) || !exactKeys(batch, datedEtfDailyKeys) || batch.market !== "A" || batch.assetType !== "etf" ||
    typeof batch.symbol !== "string" || !isDatedEtfSymbol(batch.symbol) ||
    typeof batch.observedAt !== "string" || !instant(batch.observedAt) || batch.coverage !== "unknown" ||
    batch.interval !== "1d" || batch.adjustment !== "none" || batch.timeZone !== "Asia/Shanghai" ||
    !object(batch.requested) || !exactKeys(batch.requested, ["start", "end"]) || !Array.isArray(batch.rows)) throw fail();
  const tushare = batch.source === "tushare";
  if (tushare) {
    if (batch.endpoint !== "fund_daily" || batch.priceUnit !== "CNY" || batch.volumeUnit !== "hand" ||
      batch.amountUnit !== "CNY-thousand") throw fail();
  } else if (batch.source !== "tickflow" || batch.endpoint !== "/v1/klines" || batch.priceUnit !== "unknown" ||
    batch.volumeUnit !== "unknown" || batch.amountUnit !== "unknown") throw fail();

  const capturedAt = Date.parse(batch.observedAt);
  const { start, end } = batch.requested;
  if (!dailyDate(start) || !dailyDate(end) || start < "0001-01-01" || start > end || end >= shanghaiDate(capturedAt)) throw fail();
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days > 366 || batch.rows.length > days) throw fail();

  let previousDate = "";
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, datedEtfDailyRowKeys) || !dailyDate(row.tradeDate) ||
      row.tradeDate < start || row.tradeDate > end || row.tradeDate <= previousDate) throw fail();
    const { sourceTimestamp, open, high, low, close, volume, amount } = row;
    if (tushare ? sourceTimestamp !== null : typeof sourceTimestamp !== "number" || !Number.isSafeInteger(sourceTimestamp) ||
      sourceTimestamp <= 0 || sourceTimestamp > capturedAt || shanghaiDate(sourceTimestamp) !== row.tradeDate) throw fail();
    if (!nonnegative(open) || !nonnegative(high) || !nonnegative(low) || !nonnegative(close) || low <= 0 ||
      high < Math.max(open, close) || low > Math.min(open, close) || !nonnegative(volume) || !nonnegativeOrNull(amount)) throw fail();
    previousDate = row.tradeDate;
  }
}

export async function archiveDatedEtfDailyBars(batch: StoredDatedEtfDailyBatch, signal?: AbortSignal): Promise<DatedEtfDailyArchiveRef> {
  validateDatedEtfDaily(batch);
  const content = canonical({ version: 1, kind: datedEtfDailyKind, batch });
  const ref: DatedEtfDailyArchiveRef = { version: 1, kind: datedEtfDailyKind, revision: digest(content) };
  await writeFixedArchive(datedEtfDailyDir(), datedEtfDailyPath(ref), content, signal);
  return ref;
}

export async function loadDatedEtfDailyArchive(ref: DatedEtfDailyArchiveRef, signal?: AbortSignal): Promise<StoredDatedEtfDailyBatch> {
  const data = await readFixedArchive(datedEtfDailyPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== datedEtfDailyKind) throw fail();
  validateDatedEtfDaily(data.batch);
  return data.batch;
}

const auctionBenchmarkKind = "auction-benchmark";
const auctionBenchmarkDir = () => join(resolveDataDir(), "auction-benchmark-archives-v1");
const auctionBenchmarkKeys = ["source", "endpoint", "market", "tradeDate", "calendarTimeZone", "tradeDateTimestamp",
  "responseAssembledAt", "observedAt", "coverage", "returnUnit", "rows"];

function auctionBenchmarkPath(ref: AuctionBenchmarkArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== auctionBenchmarkKind
    || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(auctionBenchmarkDir(), `${ref.revision}.json`);
}

function validateAuctionBenchmark(batch: unknown): asserts batch is StoredAuctionBenchmark {
  if (!object(batch) || !exactKeys(batch, auctionBenchmarkKeys) || batch.source !== "fuyao"
    || batch.endpoint !== "/api/a-share/auction/short-term-benchmark" || batch.market !== "A" || batch.calendarTimeZone !== "Asia/Shanghai"
    || batch.coverage !== "unknown" || batch.returnUnit !== "percentage-points" || !dailyDate(batch.tradeDate)
    || typeof batch.tradeDateTimestamp !== "number" || batch.tradeDateTimestamp !== Date.parse(`${batch.tradeDate}T00:00:00+08:00`)
    || typeof batch.responseAssembledAt !== "number" || !Number.isSafeInteger(batch.responseAssembledAt)
    || batch.responseAssembledAt < batch.tradeDateTimestamp || !Number.isFinite(new Date(batch.responseAssembledAt).getTime())
    || typeof batch.observedAt !== "string" || !instant(batch.observedAt) || !Array.isArray(batch.rows)) throw fail();

  const seen = new Set<string>();
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, ["symbol", "name", "auctionReturnPct", "tags"]) || typeof row.symbol !== "string"
      || !stockSymbol.test(row.symbol) || seen.has(row.symbol) || typeof row.name !== "string" || !row.name.trim()
      || !finiteOrNull(row.auctionReturnPct) || !Array.isArray(row.tags) || Array.from(row.tags).some(tag => typeof tag !== "string")) throw fail();
    seen.add(row.symbol);
  }
}

export async function archiveAuctionBenchmark(batch: StoredAuctionBenchmark, signal?: AbortSignal): Promise<AuctionBenchmarkArchiveRef> {
  validateAuctionBenchmark(batch);
  const content = canonical({ version: 1, kind: auctionBenchmarkKind, batch });
  const ref: AuctionBenchmarkArchiveRef = { version: 1, kind: auctionBenchmarkKind, revision: digest(content) };
  await writeFixedArchive(auctionBenchmarkDir(), auctionBenchmarkPath(ref), content, signal);
  return ref;
}

export async function loadAuctionBenchmarkArchive(ref: AuctionBenchmarkArchiveRef, signal?: AbortSignal): Promise<StoredAuctionBenchmark> {
  const data = await readFixedArchive(auctionBenchmarkPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== auctionBenchmarkKind) throw fail();
  validateAuctionBenchmark(data.batch);
  return data.batch;
}

const dragonTigerKind = "dragon-tiger-board";
const dragonTigerDir = () => join(resolveDataDir(), "dragon-tiger-archives-v1");
const dragonTigerKeys = ["source", "endpoint", "market", "tradeDate", "boardKind", "providerTimestamp", "observedAt",
  "calendarTimeZone", "coverage", "amountUnit", "ratioUnit", "providerRecordCount", "providerStockCount", "stocks", "seats"];
const dragonTigerStockText = ["symbol", "ticker", "name", "limitReason"];
const dragonTigerStockCounts = ["hotRank", "institutionalBuyCount", "institutionalSellCount"];
const dragonTigerStockAmounts = ["changeFraction", "netValueCny", "netRate", "buyValueCny", "sellValueCny",
  "institutionalNetValueCny", "institutionalNetRate", "amountCny", "hotMoneyNetValueCny", "hotMoneyNetRate",
  "seatNetValueCny", "seatNetRate"];
const dragonTigerStockKeys = [...dragonTigerStockText, ...dragonTigerStockCounts, ...dragonTigerStockAmounts, "conceptNames", "rangeDays"];
const dragonCount = (value: unknown) => nonnegative(value) && Number.isSafeInteger(value);
const stringOrNull = (value: unknown) => value === null || typeof value === "string";

function dragonTigerPath(ref: DragonTigerArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== dragonTigerKind
    || typeof ref.revision !== "string" || !/^[0-9a-f]{64}$/.test(ref.revision)) throw fail();
  return join(dragonTigerDir(), `${ref.revision}.json`);
}

function validDragonTigerStock(row: unknown): boolean {
  if (!object(row)) return false;
  const ticker = typeof row.ticker === "string" ? row.ticker.trim() : "";
  return exactKeys(row, dragonTigerStockKeys)
    && dragonTigerStockText.every(key => stringOrNull(row[key]))
    && dragonTigerStockCounts.every(key => row[key] === null || dragonCount(row[key]))
    && dragonTigerStockAmounts.every(key => finiteOrNull(row[key]))
    && (row.symbol === null || (typeof row.symbol === "string" && /^\d{6}\.(SH|SZ|BJ)$/.test(row.symbol)
      && (!ticker || ticker === row.symbol || ticker === row.symbol.slice(0, 6))))
    && (row.rangeDays === null || row.rangeDays === 1 || row.rangeDays === 3)
    && (row.conceptNames === null || (Array.isArray(row.conceptNames) && Array.from(row.conceptNames).every(stringOrNull)));
}

function validDragonTigerSeat(row: unknown): boolean {
  return object(row) && exactKeys(row, ["name", "netValueCny", "stocks"]) && stringOrNull(row.name) && finiteOrNull(row.netValueCny)
    && (row.stocks === null || (Array.isArray(row.stocks) && Array.from(row.stocks).every(validDragonTigerStock)));
}

function validateDragonTigerBoard(batch: unknown): asserts batch is DatedDragonTigerBoard {
  if (!object(batch) || !exactKeys(batch, dragonTigerKeys) || batch.source !== "fuyao"
    || batch.endpoint !== "/api/a-share/special-data/dragon-tiger-list" || batch.market !== "A"
    || batch.calendarTimeZone !== "Asia/Shanghai" || batch.coverage !== "unknown" || batch.amountUnit !== "CNY"
    || batch.ratioUnit !== "fraction" || !dailyDate(batch.tradeDate) || typeof batch.observedAt !== "string" || !instant(batch.observedAt)
    || typeof batch.providerTimestamp !== "number" || !Number.isSafeInteger(batch.providerTimestamp) || batch.providerTimestamp <= 0
    || !Number.isFinite(new Date(batch.providerTimestamp).getTime()) || !dragonCount(batch.providerRecordCount) || !dragonCount(batch.providerStockCount)
    || !Array.isArray(batch.stocks) || !Array.isArray(batch.seats)) throw fail();

  if (batch.boardKind === "hot_money") {
    if (batch.stocks.length || !Array.from(batch.seats).every(validDragonTigerSeat)) throw fail();
  } else if ((batch.boardKind !== "all" && batch.boardKind !== "org") || batch.seats.length
    || !Array.from(batch.stocks).every(validDragonTigerStock)) throw fail();
}

export async function archiveDragonTigerBoard(batch: DatedDragonTigerBoard, signal?: AbortSignal): Promise<DragonTigerArchiveRef> {
  validateDragonTigerBoard(batch);
  const content = canonical({ version: 1, kind: dragonTigerKind, batch });
  const ref: DragonTigerArchiveRef = { version: 1, kind: dragonTigerKind, revision: digest(content) };
  await writeFixedArchive(dragonTigerDir(), dragonTigerPath(ref), content, signal);
  return ref;
}

export async function loadDragonTigerArchive(ref: DragonTigerArchiveRef, signal?: AbortSignal): Promise<DatedDragonTigerBoard> {
  const data = await readFixedArchive(dragonTigerPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== dragonTigerKind) throw fail();
  validateDragonTigerBoard(data.batch);
  return data.batch;
}

const riskWarningKind = "dated-risk-warnings";
const riskWarningDir = () => join(resolveDataDir(), "risk-warning-archives-v1");

function riskWarningPath(ref: RiskWarningArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== riskWarningKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(riskWarningDir(), `${ref.revision}.json`);
}

function validateRiskWarningBatch(batch: unknown): asserts batch is StoredRiskWarningBatch {
  if (!object(batch) || batch.market !== "A" || batch.source !== "tushare" ||
    !dailyDate(batch.tradeDate) || batch.tradeDate < "2000-01-01" || !Array.isArray(batch.rows) || batch.rows.length >= 1000) throw fail();
  marketSlice(batch, "stock_st", batch.tradeDate, ["market", "source", "rows"]);
  const seen = new Set<string>();
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, ["symbol", "name", "type", "typeName"]) || typeof row.symbol !== "string" ||
      !stockSymbol.test(row.symbol) || isAIndexSymbol(row.symbol) || typeof row.name !== "string" || !row.name.trim() ||
      typeof row.type !== "string" || !row.type.trim() || typeof row.typeName !== "string" || !row.typeName.trim()) throw fail();
    const key = JSON.stringify([row.symbol, row.type]);
    if (seen.has(key)) throw fail();
    seen.add(key);
  }
}

export async function archiveRiskWarningObservations(batch: StoredRiskWarningBatch, signal?: AbortSignal): Promise<RiskWarningArchiveRef> {
  validateRiskWarningBatch(batch);
  const content = canonical({ version: 1, kind: riskWarningKind, batch });
  const ref: RiskWarningArchiveRef = { version: 1, kind: riskWarningKind, revision: digest(content) };
  await writeFixedArchive(riskWarningDir(), riskWarningPath(ref), content, signal);
  return ref;
}

export async function loadRiskWarningArchive(ref: RiskWarningArchiveRef, signal?: AbortSignal): Promise<StoredRiskWarningBatch> {
  const data = await readFixedArchive(riskWarningPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== riskWarningKind) throw fail();
  validateRiskWarningBatch(data.batch);
  return data.batch;
}

const moneyFlowKind = "dated-money-flow";
const moneyFlowDir = () => join(resolveDataDir(), "money-flow-archives-v1");
const moneyFlowBuckets = ["small", "medium", "large", "extraLarge"];
const lotsOrNull = (value: unknown) => value === null || Number.isSafeInteger(value);

function moneyFlowPath(ref: MoneyFlowArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== moneyFlowKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(moneyFlowDir(), ref.revision + ".json");
}

function validMoneyFlowBucket(bucket: unknown): boolean {
  return object(bucket) && exactKeys(bucket, ["buyVolumeHand", "buyAmount", "sellVolumeHand", "sellAmount"]) &&
    nonnegativeOrNull(bucket.buyVolumeHand) && lotsOrNull(bucket.buyVolumeHand) &&
    nonnegativeOrNull(bucket.sellVolumeHand) && lotsOrNull(bucket.sellVolumeHand) &&
    nonnegativeOrNull(bucket.buyAmount) && nonnegativeOrNull(bucket.sellAmount);
}

function validateMoneyFlowBatch(batch: unknown): asserts batch is StoredMoneyFlowBatch {
  if (!object(batch) || batch.market !== "A" || batch.source !== "tushare" || batch.volumeUnit !== "hand" ||
    batch.amountUnit !== "CNY-ten-thousand" || !dailyDate(batch.tradeDate) || batch.tradeDate < "2010-01-01" ||
    !Array.isArray(batch.rows) || batch.rows.length >= 6000) throw fail();
  marketSlice(batch, "moneyflow", batch.tradeDate, ["market", "source", "volumeUnit", "amountUnit", "rows"]);
  const seen = new Set<string>();
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, ["symbol", ...moneyFlowBuckets, "netVolumeHand", "netAmount"]) ||
      typeof row.symbol !== "string" || !stockSymbol.test(row.symbol) || row.symbol.endsWith(".BJ") ||
      isAIndexSymbol(row.symbol) || seen.has(row.symbol) || !lotsOrNull(row.netVolumeHand) ||
      !finiteOrNull(row.netAmount) || !moneyFlowBuckets.every(bucket => validMoneyFlowBucket(row[bucket]))) throw fail();
    seen.add(row.symbol);
  }
}

export async function archiveMoneyFlow(batch: StoredMoneyFlowBatch, signal?: AbortSignal): Promise<MoneyFlowArchiveRef> {
  validateMoneyFlowBatch(batch);
  const content = canonical({ version: 1, kind: moneyFlowKind, batch });
  const ref: MoneyFlowArchiveRef = { version: 1, kind: moneyFlowKind, revision: digest(content) };
  await writeFixedArchive(moneyFlowDir(), moneyFlowPath(ref), content, signal);
  return ref;
}

export async function loadMoneyFlowArchive(ref: MoneyFlowArchiveRef, signal?: AbortSignal): Promise<StoredMoneyFlowBatch> {
  const data = await readFixedArchive(moneyFlowPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== moneyFlowKind) throw fail();
  validateMoneyFlowBatch(data.batch);
  return data.batch;
}

const popularityKind = "dated-popularity-list";
const popularityDir = () => join(resolveDataDir(), "popularity-archives-v1");

function popularityPath(ref: PopularityArchiveRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 || ref.kind !== popularityKind ||
    typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(popularityDir(), ref.revision + ".json");
}

function validatePopularityList(batch: unknown): asserts batch is DatedPopularityList {
  if (!object(batch) || !exactKeys(batch, ["source", "endpoint", "market", "calendarDate", "calendarTimeZone",
    "calendarDateTimestamp", "observedAt", "coverage", "rows"]) ||
    batch.source !== "fuyao" || batch.market !== "A" || batch.endpoint !== "/api/a-share/special-data/hot-stock-list-history" ||
    batch.calendarTimeZone !== "Asia/Shanghai" || batch.coverage !== "unknown" ||
    !dailyDate(batch.calendarDate) || batch.calendarDate < "0001-01-01" ||
    typeof batch.observedAt !== "string" || !instant(batch.observedAt) ||
    !Array.isArray(batch.rows) || batch.rows.length > 30) throw fail();
  const midnight = Date.parse(batch.calendarDate + "T00:00:00+08:00");
  if (batch.calendarDateTimestamp !== midnight || midnight > Date.parse(batch.observedAt)) throw fail();

  const seen = new Set<string>();
  for (const row of batch.rows) {
    if (!object(row) || !exactKeys(row, ["symbol", "ticker", "name", "rank"]) || typeof row.symbol !== "string" ||
      !stockSymbol.test(row.symbol) || seen.has(row.symbol) || row.ticker !== row.symbol.slice(0, 6) ||
      typeof row.name !== "string" || !row.name.trim() || typeof row.rank !== "number" ||
      !Number.isSafeInteger(row.rank) || row.rank < 1) throw fail();
    seen.add(row.symbol);
  }
}

export async function archivePopularityList(batch: DatedPopularityList, signal?: AbortSignal): Promise<PopularityArchiveRef> {
  validatePopularityList(batch);
  const content = canonical({ version: 1, kind: popularityKind, batch });
  const ref: PopularityArchiveRef = { version: 1, kind: popularityKind, revision: digest(content) };
  await writeFixedArchive(popularityDir(), popularityPath(ref), content, signal);
  return ref;
}

export async function loadPopularityArchive(ref: PopularityArchiveRef, signal?: AbortSignal): Promise<DatedPopularityList> {
  const data = await readFixedArchive(popularityPath(ref), ref.revision, signal);
  if (!object(data) || !exactKeys(data, ["version", "kind", "batch"]) || data.version !== 1 || data.kind !== popularityKind) throw fail();
  validatePopularityList(data.batch);
  return data.batch;
}

const marketRegimeManifestKind = "market-regime-manifest";
const marketRegimeManifestDir = () => join(resolveDataDir(), "market-regime-manifests-v1");
export const MARKET_REGIME_MANIFEST_MAX_BYTES = 24 * 1_024 * 1_024;

function marketRegimeManifestPath(ref: MarketRegimeManifestRef): string {
  if (!object(ref) || !exactKeys(ref, ["version", "kind", "revision"]) || ref.version !== 1 ||
    ref.kind !== marketRegimeManifestKind || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision)) throw fail();
  return join(marketRegimeManifestDir(), ref.revision + ".json");
}

/** Store the fixed JSON input. Runtime validates its market scope and referenced observations. */
export async function archiveMarketRegimeManifest(json: string, signal?: AbortSignal): Promise<MarketRegimeManifestRef> {
  signal?.throwIfAborted();
  if (typeof json !== "string" || Buffer.byteLength(json) > MARKET_REGIME_MANIFEST_MAX_BYTES) throw fail();
  let manifest: unknown;
  try { manifest = JSON.parse(json); } catch { throw fail(); }
  if (!object(manifest) || Object.keys(manifest).length === 0) throw fail();
  const content = canonical({ version: 1, kind: marketRegimeManifestKind, manifest });
  if (Buffer.byteLength(content) > MARKET_REGIME_MANIFEST_MAX_BYTES) throw fail();
  const ref: MarketRegimeManifestRef = { version: 1, kind: marketRegimeManifestKind, revision: digest(content) };
  await writeFixedArchive(marketRegimeManifestDir(), marketRegimeManifestPath(ref), content, signal);
  return ref;
}

export async function loadMarketRegimeManifest(ref: MarketRegimeManifestRef, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const data = await readFixedArchive(marketRegimeManifestPath(ref), ref.revision, signal, MARKET_REGIME_MANIFEST_MAX_BYTES);
  if (!object(data) || !exactKeys(data, ["version", "kind", "manifest"]) || data.version !== 1 ||
    data.kind !== marketRegimeManifestKind || !object(data.manifest) || Object.keys(data.manifest).length === 0) throw fail();
  return data.manifest;
}

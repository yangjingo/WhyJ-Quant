/** Immutable Source observations, independent of provider clients and the daily-bar cache. */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObservationArchiveRef, StoredObservation } from "../../types/observation.ts";
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

import { createHash } from "node:crypto";
import { isDailyDate } from "../../market/bars.ts";
import type { TspExtensionCell as Cell, TspExtensionPage, TspExtensionRowsRequest,
  TspExtensionSourceField as SourceField } from "../../types/tsp-extension.ts";
import { getText } from "./http.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";

export type { TspExtensionPage, TspExtensionRowsRequest } from "../../types/tsp-extension.ts";

const responseLimit = 4 * 1024 * 1024;
const tableId = /^[a-zA-Z0-9_]{1,128}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const columnName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[,\u0000-\u001f]/.test(value);
const malformed = () => new SourceRequestError("provider-failure", "Invalid TSP extension rows response");

function decodeFields(value: unknown) {
  if (!Array.isArray(value)) throw malformed();
  const fields = new Map<string, SourceField>();
  for (const field of value) {
    if (!record(field) || !columnName(field.name) || fields.has(field.name) || typeof field.label !== "string") throw malformed();
    const { name, dtype, label } = field;
    if (dtype !== "string" && dtype !== "int" && dtype !== "float" && dtype !== "bool") throw malformed();
    fields.set(name, { name, dtype, label });
  }
  return fields;
}

function isCell(value: unknown, dtype: SourceField["dtype"]): value is Cell {
  if (value === null) return true;
  if (dtype === "string") return typeof value === "string";
  if (dtype === "bool") return typeof value === "boolean";
  return typeof value === "number" && (dtype === "int" ? Number.isSafeInteger(value) : Number.isFinite(value));
}

function decodePage(payload: unknown, request: TspExtensionRowsRequest, origin: string, endpoint: string, observedAt: string): TspExtensionPage {
  if (!record(payload)) throw malformed();
  const { id, label, mode, date, total, offset, limit, fields: rawFields, rows: rawRows } = payload;
  if (id !== request.datasetId || typeof label !== "string" || mode !== request.selection.mode ||
    offset !== request.offset || limit !== request.limit || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 ||
    !Array.isArray(rawRows) || rawRows.length !== Math.max(0, Math.min(request.limit, total - request.offset))) throw malformed();
  let partitionDate: string | null = null, snapshotSyncLocal: string | null = null;
  if (request.selection.mode === "timeseries") {
    if (date !== request.selection.date && !(date === null && total === 0)) throw malformed();
    partitionDate = date === null ? null : request.selection.date;
  } else if (date !== null) {
    if (typeof date !== "string" || !isDailyDate(date.slice(0, 10)) ||
      !/^ (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(date.slice(10))) throw malformed();
    snapshotSyncLocal = date;
  }
  const declared = decodeFields(rawFields);
  const fields = request.columns.map((column): SourceField => {
    const field = declared.get(column);
    if (field) return field;
    if (column === "symbol" || column === "code" || column === "name") return { name: column, dtype: "string", label: column };
    throw malformed();
  });
  const omitted = new Set<string>();
  const rows = rawRows.map((row: unknown) => {
    if (!record(row)) throw malformed();
    const selected: [string, Cell][] = [];
    for (const { name, dtype } of fields) {
      if (!Object.hasOwn(row, name)) { omitted.add(name); continue; }
      const value = row[name];
      if (!isCell(value, dtype)) throw malformed();
      selected.push([name, value]);
    }
    return Object.fromEntries(selected);
  });
  const omittedFields = request.columns.filter(column => omitted.has(column));
  const schemaRevision = digest([...declared.values()]);
  const revision = digest({ origin, endpoint, request, label, date, total, schemaRevision, rows });
  return {
    source: "tsp", originalPublisher: "unknown", origin, endpoint, observedAt, sourceAsOf: null, request, datasetLabel: label,
    partitionDate, snapshotSyncLocal, schemaRevision, revision, totalRows: total, fields, rows, omittedFields,
    coverage: request.offset === 0 && rows.length === total && !omittedFields.length ? "complete" : "partial",
  };
}

async function readExtensionJson(
  endpoint: string, query: URLSearchParams, connection: Omit<SourceConnection, "source">, options: SourceRequestOptions,
  kind: "rows" | "series",
) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) {
    throw new Error("Invalid TSP extension request timeout");
  }
  const env = connection.env ?? process.env;
  const token = connection.apiKey ?? env.WHYJ_QUANT_TSP_READ_EXT_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,512}$/.test(token)) {
    throw new SourceRequestError("provider-failure", "A TSP read:ext token is required");
  }
  let base: URL;
  try { base = new URL(connection.baseUrl ?? env.WHYJ_QUANT_TSP_BASE_URL ?? ""); }
  catch { throw new Error("Invalid TSP base URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
    (base.protocol !== "https:" && !(loopback && base.protocol === "http:"))) throw new Error("Invalid TSP base URL");
  const url = new URL(endpoint, base);
  url.search = query.toString();
  if (url.href.includes(token)) throw new Error("Invalid TSP base URL or request scope");
  let payload: unknown;
  try {
    const text = await getText(url.href, responseLimit, { ...options, redirect: "error" }, {
      authorization: `Bearer ${token}`, accept: "application/json",
    });
    payload = JSON.parse(text);
    if (text.includes(token) || JSON.stringify(payload).includes(token)) throw malformed();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /^Request timed out after \d+ms$/.test(error.message)) {
      throw new SourceRequestError("timeout", `TSP extension ${kind} request timed out`);
    }
    throw new SourceRequestError("provider-failure", `TSP extension ${kind} request failed`);
  }
  options.signal?.throwIfAborted();
  return { payload, origin: base.origin, observedAt: new Date().toISOString() };
}

/** Read one explicit projection from the TSP read:ext API. */
export async function fetchTspExtensionPage(
  input: TspExtensionRowsRequest, connection: Omit<SourceConnection, "source"> = {}, options: SourceRequestOptions = {},
): Promise<TspExtensionPage> {
  options.signal?.throwIfAborted();
  const { datasetId, selection, columns, offset, limit } = structuredClone(input);
  if (typeof datasetId !== "string" || !tableId.test(datasetId) || !selection ||
    (selection.mode !== "snapshot" && selection.mode !== "timeseries") ||
    (selection.mode === "snapshot" ? selection.date !== undefined : typeof selection.date !== "string" || !isDailyDate(selection.date)) ||
    !Array.isArray(columns) || !columns.length || columns.length > 128 || new Set(columns).size !== columns.length ||
    !columns.every(columnName) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Invalid TSP extension rows request");
  const endpoint = `/api/ext-data/${datasetId}/rows`;
  const query = new URLSearchParams({ columns: columns.join(","), offset: String(offset), limit: String(limit) });
  if (selection.mode === "timeseries") query.set("date", selection.date);
  const request: TspExtensionRowsRequest = { datasetId, columns, offset, limit,
    selection: selection.mode === "snapshot" ? { mode: "snapshot" } : { mode: "timeseries", date: selection.date } };
  const { payload, origin, observedAt } = await readExtensionJson(endpoint, query, connection, options, "rows");
  return decodePage(payload, request, origin, endpoint, observedAt);
}

export interface TspExtensionIntradaySeriesRequest {
  datasetId: string;
  field: string;
  date: string;
  symbols: readonly string[];
}

export interface TspExtensionIntradaySeries {
  source: "tsp";
  originalPublisher: "unknown";
  origin: string;
  endpoint: string;
  request: TspExtensionIntradaySeriesRequest;
  revision: string;
  observedAt: string;
  sourceAsOf: null;
  timeBasis: "provider-wall-clock";
  valueUnit: "unknown";
  series: { symbol: string; points: { time: string; value: number }[] | null }[];
}

const seriesSymbol = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const wallTime = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const malformedSeries = () => new SourceRequestError("provider-failure", "Invalid TSP extension intraday series response");

export async function fetchTspExtensionIntradaySeries(
  input: TspExtensionIntradaySeriesRequest, connection: Omit<SourceConnection, "source"> = {}, options: SourceRequestOptions = {},
): Promise<TspExtensionIntradaySeries> {
  options.signal?.throwIfAborted();
  const { datasetId, field, date, symbols } = structuredClone(input);
  if (typeof datasetId !== "string" || !tableId.test(datasetId) || !columnName(field) ||
    typeof date !== "string" || !isDailyDate(date) || date < "0001-01-01" ||
    !Array.isArray(symbols) || !symbols.length || symbols.length > 100 ||
    Array.from(symbols).some(symbol => typeof symbol !== "string" || !seriesSymbol.test(symbol)) ||
    new Set(symbols).size !== symbols.length) throw new Error("Invalid TSP extension intraday series request");
  const endpoint = `/api/ext-data/${datasetId}/series`;
  const query = new URLSearchParams({ field, date, symbols: symbols.join(","), granularity: "intraday" });
  const request = { datasetId, field, date, symbols };
  const { payload, origin, observedAt } = await readExtensionJson(endpoint, query, connection, options, "series");
  if (!record(payload) || payload.config_id !== datasetId || payload.field !== field || payload.date !== date ||
    payload.granularity !== "intraday" || !record(payload.items)) throw malformedSeries();
  const items = payload.items;
  const scope = new Set(symbols);
  if (Object.keys(items).some(symbol => !scope.has(symbol))) throw malformedSeries();
  const series = symbols.map(symbol => {
    if (!Object.hasOwn(items, symbol)) return { symbol, points: null };
    const points = items[symbol];
    if (!Array.isArray(points)) throw malformedSeries();
    return { symbol, points: points.map((point: unknown) => {
      if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "string" || !wallTime.test(point[0]) ||
        typeof point[1] !== "number" || !Number.isFinite(point[1])) throw malformedSeries();
      return { time: point[0], value: point[1] };
    }) };
  });
  const revision = digest({ origin, endpoint, request, series });
  return { source: "tsp", originalPublisher: "unknown", origin, endpoint, request, revision, observedAt,
    sourceAsOf: null, timeBasis: "provider-wall-clock", valueUnit: "unknown", series };
}

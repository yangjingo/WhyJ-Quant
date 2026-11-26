import { createHash } from "node:crypto";
import { isDailyDate } from "../../market/bars.ts";
import { getText } from "./http.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";

type SourceField = { name: string; dtype: "string" | "int" | "float" | "bool"; label: string };
type Cell = string | number | boolean | null;

export interface TspExtensionRowsRequest {
  datasetId: string;
  selection: { mode: "snapshot"; date?: never } | { mode: "timeseries"; date: string };
  columns: readonly string[];
  offset: number;
  limit: number;
}

export interface TspExtensionPage {
  source: "tsp";
  origin: string;
  endpoint: string;
  originalPublisher: "unknown";
  observedAt: string;
  sourceAsOf: null;
  request: TspExtensionRowsRequest;
  datasetLabel: string;
  partitionDate: string | null;
  snapshotSyncLocal: string | null;
  schemaRevision: string;
  revision: string;
  coverage: "complete" | "partial";
  totalRows: number;
  fields: SourceField[];
  rows: Record<string, Cell>[];
  omittedFields: string[];
}

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
  const endpoint = `/api/ext-data/${datasetId}/rows`;
  const url = new URL(endpoint, base);
  url.search = new URLSearchParams({ columns: columns.join(","), offset: String(offset), limit: String(limit) }).toString();
  if (selection.mode === "timeseries") url.searchParams.set("date", selection.date);
  if (url.href.includes(token)) throw new Error("Invalid TSP base URL or request scope");
  const request: TspExtensionRowsRequest = { datasetId, columns, offset, limit,
    selection: selection.mode === "snapshot" ? { mode: "snapshot" } : { mode: "timeseries", date: selection.date } };
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
      throw new SourceRequestError("timeout", "TSP extension rows request timed out");
    }
    throw new SourceRequestError("provider-failure", "TSP extension rows request failed");
  }
  options.signal?.throwIfAborted();
  return decodePage(payload, request, base.origin, endpoint, new Date().toISOString());
}

import { computeTspExtensionGroups, type TspExtensionField, type TspExtensionGroupsInput } from "../../quant/index.ts";
import { fetchTspExtensionPage, type SourceRequestOptions, type TspExtensionRowsRequest } from "../../source/index.ts";
import { archiveTspExtensionPage, loadTspExtensionPageArchive, type TspExtensionPageArchiveRef } from "../../storage/index.ts";

export interface TspExtensionGroupReplayRequest extends Pick<TspExtensionGroupsInput, "dimensionField" | "metrics"> {
  ref: TspExtensionPageArchiveRef;
  units?: Readonly<Record<string, string>>;
}

export async function collectTspExtensionPage(request: TspExtensionRowsRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  const { rows, ...capture } = await fetchTspExtensionPage(request, {}, control);
  const ref = await archiveTspExtensionPage({ ...capture, rows }, control.signal);
  return { ...capture, ref, status: rows.length ? "archived" as const : "empty" as const, rowCount: rows.length };
}

export async function replayTspExtensionPageGroups(request: TspExtensionGroupReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { ref, dimensionField, metrics, units = {} } = structuredClone(request);
  if (!units || typeof units !== "object" || Array.isArray(units)) throw new Error("Invalid extension units");
  const { rows, ...capture } = await loadTspExtensionPageArchive(ref, signal);
  const numeric = new Set(capture.fields.filter(field => field.dtype === "int" || field.dtype === "float").map(field => field.name));
  for (const [name, unit] of Object.entries(units)) {
    if (!numeric.has(name) || typeof unit !== "string" || !unit || unit !== unit.trim() || unit.toLowerCase() === "unknown") {
      throw new Error("Invalid extension units");
    }
  }
  const fields = capture.fields.map(({ name, dtype }): TspExtensionField => {
    if (dtype === "string") return { name, type: "text" };
    if (dtype === "bool") return { name, type: "boolean" };
    return { name, type: "number", unit: Object.hasOwn(units, name) ? units[name]! : "unknown" };
  });
  const unitEvidence = fields.flatMap(field => field.type === "number"
    ? [{ field: field.name, unit: field.unit, basis: Object.hasOwn(units, field.name) ? "caller-declared" as const : "unknown" as const }]
    : []);
  const dataset = {
    id: capture.request.datasetId, schemaRevision: capture.schemaRevision, revision: capture.revision, source: capture.source,
    frequency: capture.request.selection.mode === "snapshot" ? "snapshot" as const : "unknown" as const,
    effectiveDate: capture.partitionDate, sourceAsOf: capture.sourceAsOf, observedAt: capture.observedAt,
    coverage: capture.coverage, totalRows: capture.totalRows,
  };
  signal?.throwIfAborted();
  return { ...computeTspExtensionGroups({ dataset, fields, dimensionField, metrics, rows }),
    input: { ref, ...capture, unitEvidence } };
}

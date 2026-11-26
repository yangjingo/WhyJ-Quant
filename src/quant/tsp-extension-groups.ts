import { isDailyDate } from "../market/bars.ts";
import { finiteStatistic } from "./statistics.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_EXTENSION_GROUPS_FORMULA_VERSION = "tsp-extension-groups-v1";

export interface TspExtensionDataset {
  id: string;
  schemaRevision: string;
  revision: string;
  source: string;
  frequency: "snapshot" | "daily" | "intraday" | "unknown";
  effectiveDate: string | null;
  sourceAsOf: string | null;
  observedAt: string;
  coverage: "complete" | "partial" | "unknown";
  totalRows: number | null;
}

export type TspExtensionField =
  { name: string; type: "number"; unit: string } |
  { name: string; type: "text" | "date" | "boolean"; unit?: never };

export interface TspExtensionMetric {
  field: string;
  aggregate: "avg" | "sum" | "min" | "max";
}

type ExtensionRow = Readonly<Partial<Record<string, string | number | boolean | null>>>;

export interface TspExtensionGroupsInput {
  dataset: TspExtensionDataset;
  fields: readonly TspExtensionField[];
  dimensionField: string;
  metrics: readonly TspExtensionMetric[];
  rows: readonly ExtensionRow[];
}

const separators = /[、,，;；|/\s]+/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const utcInstant = (value: unknown): value is string => typeof value === "string" && isDailyDate(value.slice(0, 10)) &&
  /^T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value.slice(10));

function validateCell(field: TspExtensionField | undefined, value: unknown) {
  if (!field || (value != null && !(
    (field.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (field.type === "text" && typeof value === "string") ||
    (field.type === "date" && typeof value === "string" && isDailyDate(value)) ||
    (field.type === "boolean" && typeof value === "boolean")
  ))) throw new Error("Extension row conflicts with the declared field schema");
}

/** Compute group metrics only over the caller's fixed extension rows. */
export function computeTspExtensionGroups({ dataset, fields, dimensionField, metrics, rows }: TspExtensionGroupsInput) {
  if (!dataset || !Array.isArray(fields) || !Array.isArray(metrics) || !Array.isArray(rows)) throw new Error("Invalid extension group input");
  const { id, schemaRevision, revision, source, frequency, effectiveDate, sourceAsOf, observedAt, coverage, totalRows } = dataset;
  if (!text(id) || !text(schemaRevision) || !text(revision) || !text(source) ||
    !["snapshot", "daily", "intraday", "unknown"].includes(frequency) ||
    (effectiveDate !== null && (typeof effectiveDate !== "string" || !isDailyDate(effectiveDate))) ||
    !utcInstant(observedAt) || (sourceAsOf !== null && (!utcInstant(sourceAsOf) || Date.parse(sourceAsOf) > Date.parse(observedAt))) ||
    !["complete", "partial", "unknown"].includes(coverage) ||
    (totalRows !== null && (!Number.isSafeInteger(totalRows) || totalRows < rows.length)) ||
    (coverage === "complete" && totalRows !== rows.length)) throw new Error("Invalid extension dataset evidence");

  const schema = new Map<string, TspExtensionField>();
  for (const field of fields as readonly TspExtensionField[]) {
    if (!field || !text(field.name) || schema.has(field.name) ||
      !["number", "text", "date", "boolean"].includes(field.type) ||
      (field.type === "number" ? !text(field.unit) : field.unit !== undefined)) throw new Error("Invalid extension field schema");
    schema.set(field.name, field);
  }
  if (!schema.has(dimensionField)) throw new Error("Unknown extension dimension field");

  const seenMetrics = new Set<string>();
  const specs = Array.from(metrics as readonly TspExtensionMetric[], metric => {
    const spec = metric && schema.get(metric.field);
    const key = JSON.stringify([metric?.field, metric?.aggregate]);
    if (!spec || spec.type !== "number" || !["avg", "sum", "min", "max"].includes(metric.aggregate) ||
      seenMetrics.has(key)) throw new Error("Invalid extension metric");
    seenMetrics.add(key);
    return { field: spec.name, unit: spec.unit, aggregate: metric.aggregate };
  });

  const groups = new Map<string, ExtensionRow[]>();
  let rowsWithoutDimension = 0, memberships = 0;
  for (const row of rows as readonly ExtensionRow[]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid extension row");
    for (const [field, value] of Object.entries(row)) validateCell(schema.get(field), value);
    const dimension = Object.hasOwn(row, dimensionField) ? row[dimensionField] : null;
    const labels = dimension == null ? [] : String(dimension).trim().split(separators).filter(Boolean);
    if (!labels.length) rowsWithoutDimension++;
    memberships += labels.length;
    for (const label of labels) {
      const members = groups.get(label) ?? [];
      members.push(row);
      groups.set(label, members);
    }
  }

  return {
    producer: "whyj" as const, formulaVersion: TSP_EXTENSION_GROUPS_FORMULA_VERSION, referenceRevision: TSP_INDICATOR_REVISION,
    dataset: { id, schemaRevision, revision, source, frequency, effectiveDate, sourceAsOf, observedAt, coverage, totalRows },
    dimensionField, rowCount: rows.length, rowsWithoutDimension, memberships,
    groups: [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, members]) => ({
      key, count: members.length, metrics: specs.map(spec => {
        const { field, aggregate } = spec;
        let observedCount = 0, value: number | null = null;
        for (const row of members) {
          const cell = Object.hasOwn(row, field) ? row[field] : null;
          if (typeof cell !== "number") continue;
          observedCount++;
          if (value === null) value = cell;
          else if (aggregate === "min") value = Math.min(value, cell);
          else if (aggregate === "max") value = Math.max(value, cell);
          else value = finiteStatistic(value + cell);
        }
        if (value !== null && aggregate === "avg") value /= observedCount;
        return { ...spec, observedCount, value };
      }),
    })),
  };
}

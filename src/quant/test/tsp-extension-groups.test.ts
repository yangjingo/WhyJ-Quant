import { expect, test } from "bun:test";
import { computeTspExtensionGroups, type TspExtensionGroupsInput, type TspExtensionMetric } from "../index.ts";

const input = {
  dataset: { id: "example", schemaRevision: "fields-v4", revision: "fixture-r1", source: "fixture-provider",
    frequency: "daily", effectiveDate: "2025-06-17", sourceAsOf: "2025-06-17T07:00:00Z",
    observedAt: "2025-06-17T08:00:00Z", coverage: "partial", totalRows: 9 },
  fields: [{ name: "tag", type: "text" }, { name: "net", type: "number", unit: "CNY" },
    { name: "change", type: "number", unit: "percentage-point" }, { name: "date", type: "date" }],
  dimensionField: "tag",
  metrics: [
    { field: "net", aggregate: "avg" }, { field: "net", aggregate: "sum" }, { field: "net", aggregate: "min" },
    { field: "net", aggregate: "max" }, { field: "change", aggregate: "avg" },
  ],
  rows: [
    { tag: "B，A/A", net: 0, change: 4, date: "2025-06-17" },
    { tag: "A；C", net: -6, change: null },
    { tag: "B", net: null },
    { tag: "C", net: 8 },
    { tag: "" }, { tag: "D", net: null }, { net: 10 },
  ],
} satisfies TspExtensionGroupsInput;

test("matches reference grouping and finite numeric operations, including overlapping and repeated membership", () => {
  const report = computeTspExtensionGroups(input);
  expect(report).toMatchObject({
    producer: "whyj", formulaVersion: "tsp-extension-groups-v1", dataset: input.dataset,
    rowCount: 7, rowsWithoutDimension: 2, memberships: 8,
  });
  expect(report.groups.map(({ key, count }) => [key, count])).toEqual([["A", 3], ["B", 2], ["C", 2], ["D", 1]]);
  expect(report.groups[0]!.metrics).toEqual([
    { field: "net", aggregate: "avg", unit: "CNY", observedCount: 3, value: -2 },
    { field: "net", aggregate: "sum", unit: "CNY", observedCount: 3, value: -6 },
    { field: "net", aggregate: "min", unit: "CNY", observedCount: 3, value: -6 },
    { field: "net", aggregate: "max", unit: "CNY", observedCount: 3, value: 0 },
    { field: "change", aggregate: "avg", unit: "percentage-point", observedCount: 2, value: 4 },
  ]);
  expect(report.groups[1]!.metrics[0]).toMatchObject({ observedCount: 1, value: 0 });
  expect(report.groups[2]!.metrics[0]).toMatchObject({ observedCount: 2, value: 1 });
  expect(report.groups[3]!.metrics[0]).toMatchObject({ observedCount: 0, value: null });
});

test("keeps empty evidence and a dimension value of zero explicit", () => {
  expect(computeTspExtensionGroups({ ...input, dataset: { ...input.dataset, totalRows: null, coverage: "unknown",
    sourceAsOf: null, effectiveDate: null }, rows: [],
  })).toMatchObject({ rowCount: 0, rowsWithoutDimension: 0, memberships: 0, groups: [], dataset: { coverage: "unknown" } });
  expect(computeTspExtensionGroups({ ...input, dimensionField: "net", rows: [{ net: 0 }, { net: null }] }))
    .toMatchObject({ rowsWithoutDimension: 1, groups: [{ key: "0", count: 1 }] });
});

test("rejects schema, coverage and timing contradictions and aggregate overflow", () => {
  expect(() => computeTspExtensionGroups({ ...input, fields: [...input.fields, input.fields[0]!] })).toThrow("field schema");
  expect(() => computeTspExtensionGroups({ ...input, dimensionField: "unknown" })).toThrow("dimension field");
  expect(() => computeTspExtensionGroups({ ...input, metrics: [{ field: "tag", aggregate: "avg" }] })).toThrow("extension metric");
  expect(() => computeTspExtensionGroups({ ...input, metrics: [...input.metrics, input.metrics[0]!] })).toThrow("extension metric");
  expect(() => computeTspExtensionGroups({ ...input, metrics: new Array<TspExtensionMetric>(1) })).toThrow("extension metric");
  for (const row of [{ net: "3" }, { net: Infinity }, { date: "2025-02-30" }, { unregistered: 2 }]) {
    expect(() => computeTspExtensionGroups({ ...input, rows: [row] })).toThrow("field schema");
  }
  for (const dataset of [
    { ...input.dataset, observedAt: "2025-06-17" },
    { ...input.dataset, effectiveDate: "2025-02-30" },
    { ...input.dataset, sourceAsOf: "2025-06-18T08:00:00Z" },
    { ...input.dataset, coverage: "complete" as const },
    { ...input.dataset, totalRows: 1 },
  ]) expect(() => computeTspExtensionGroups({ ...input, dataset })).toThrow("dataset evidence");
  expect(() => computeTspExtensionGroups({ ...input, rows: [{ tag: "B", net: 1e308 }, { tag: "B", net: 1e308 }] }))
    .toThrow("finite numeric range");
});

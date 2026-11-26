import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TspExtensionRowsRequest } from "../../source/index.ts";
import { collectTspExtensionPage, replayTspExtensionPageGroups, type TspExtensionGroupReplayRequest } from "../data/tsp-extension-replay.ts";

test("collects an exact TSP projection and derives stable offline metrics with source and unit evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-tsp-extension-runtime-"));
  const vars = { OHQUANT_DIR: root, WHYJ_QUANT_TSP_BASE_URL: "https://tsp.example.test", WHYJ_QUANT_TSP_READ_EXT_TOKEN: "tsp_runtime_fixture" };
  const previous = Object.entries(vars).map(([name]) => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(vars)) process.env[name] = value;
  const date = "2025-06-18";
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    id: "flow_demo", label: "Flow", mode: "timeseries", date, total: 6, offset: 0, limit: 3,
    fields: [{ name: "group", dtype: "string", label: "Group" }, { name: "flow", dtype: "float", label: "Flow" }],
    rows: [{ group: "A/B", flow: 0 }, { group: "A", flow: 20 }, { group: "C" }],
  })).mockRejectedValue(new Error("Unexpected provider call"));
  const storage = join(root, "data", "tsp-extension-page-archives-v1");
  const request: TspExtensionRowsRequest = {
    datasetId: "flow_demo", selection: { mode: "timeseries", date }, columns: ["group", "flow"], offset: 0, limit: 3,
  };
  try {
    await expect(collectTspExtensionPage(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(storage)).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    const captured = await collectTspExtensionPage(request);
    expect(captured).toMatchObject({ source: "tsp", request, rowCount: 3, totalRows: 6, status: "archived",
      omittedFields: ["flow"], coverage: "partial", partitionDate: date, ref: { version: 1, kind: "tsp-extension-page" },
    });
    expect(captured).not.toHaveProperty("rows");
    const input: TspExtensionGroupReplayRequest = {
      ref: captured.ref, dimensionField: "group", metrics: [{ field: "flow", aggregate: "avg" }],
    };
    const report = await replayTspExtensionPageGroups(input);
    expect(report).toMatchObject({
      producer: "whyj", dataset: { id: "flow_demo", source: "tsp", effectiveDate: date, frequency: "unknown", coverage: "partial",
        revision: captured.revision, schemaRevision: captured.schemaRevision, observedAt: captured.observedAt },
      groups: [
        { key: "A", count: 2, metrics: [{ value: 10, unit: "unknown", observedCount: 2 }] },
        { key: "B", count: 1, metrics: [{ value: 0, observedCount: 1 }] },
        { key: "C", count: 1, metrics: [{ value: null, observedCount: 0 }] },
      ],
      input: { ref: captured.ref, source: "tsp", originalPublisher: "unknown", sourceAsOf: null, omittedFields: ["flow"],
        unitEvidence: [{ field: "flow", unit: "unknown", basis: "unknown" }] },
    });
    expect(await replayTspExtensionPageGroups(input)).toEqual(report);
    expect(await replayTspExtensionPageGroups({ ...input, units: { flow: "CNY" } })).toMatchObject({
      groups: [{ metrics: [{ unit: "CNY" }] }, { metrics: [{ unit: "CNY" }] }, { metrics: [{ unit: "CNY" }] }],
      input: { unitEvidence: [{ field: "flow", unit: "CNY", basis: "caller-declared" }] },
    });
    await expect(replayTspExtensionPageGroups({ ...input, units: { group: "CNY" } })).rejects.toThrow("Invalid extension units");
    await expect(replayTspExtensionPageGroups({ ...input, units: { flow: " CNY " } })).rejects.toThrow("Invalid extension units");
    await expect(replayTspExtensionPageGroups({ ...input, units: { flow: "Unknown" } })).rejects.toThrow("Invalid extension units");
    await expect(replayTspExtensionPageGroups({ ...input, ref: { ...input.ref, revision: "0".repeat(64) } }))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(replayTspExtensionPageGroups(input, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(collectTspExtensionPage(request)).rejects.toMatchObject({ code: "provider-failure" });
    expect(readdirSync(storage)).toEqual([captured.ref.revision + ".json"]);
    expect(await replayTspExtensionPageGroups(input)).toEqual(report);
  } finally {
    provider.mockRestore();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TspExtensionPage } from "../../types/tsp-extension.ts";
import { archiveTspExtensionPage, loadTspExtensionPageArchive } from "../index.ts";
import { withFileLockAsync } from "../src/atomic-file.ts";

const date = "2025-06-18";
const page = (): TspExtensionPage => ({
  source: "tsp", origin: "https://tsp.example.test", endpoint: "/api/ext-data/flow_demo/rows", originalPublisher: "unknown",
  observedAt: "2025-06-18T08:00:00Z", sourceAsOf: null,
  request: { datasetId: "flow_demo", selection: { mode: "timeseries", date }, columns: ["category", "flow"], offset: 0, limit: 3 },
  datasetLabel: "Flow", partitionDate: date, snapshotSyncLocal: null, schemaRevision: "f".repeat(64), revision: "a".repeat(64),
  coverage: "partial", totalRows: 3, fields: [{ name: "category", dtype: "string", label: "Category" },
    { name: "flow", dtype: "float", label: "Flow" }],
  rows: [{ category: "A", flow: 0 }, { category: "B", flow: null }, { category: "C" }], omittedFields: ["flow"],
});
let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-tsp-extension-archives-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const dir = () => join(root, "data", "tsp-extension-page-archives-v1");

test("reopens deterministic dated and snapshot receipts with raw row and schema provenance", async () => {
  const dated = page();
  const [ref, same] = await Promise.all([archiveTspExtensionPage(dated), archiveTspExtensionPage({
    ...dated, rows: [{ flow: 0, category: "A" }, ...dated.rows.slice(1)],
  })]);
  expect(ref).toEqual(same);
  expect(ref).toMatchObject({ version: 1, kind: "tsp-extension-page" });
  expect(ref.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadTspExtensionPageArchive(ref)).toEqual(dated);
  const corrected = { ...dated, revision: "b".repeat(64), rows: [{ category: "A", flow: 2 }, ...dated.rows.slice(1)] };
  const second = await archiveTspExtensionPage(corrected);
  expect(second).not.toEqual(ref);
  expect(await loadTspExtensionPageArchive(second)).toEqual(corrected);
  expect(await archiveTspExtensionPage({ ...dated, observedAt: "2025-06-18T08:01:00Z" })).not.toEqual(ref);
  expect(await loadTspExtensionPageArchive(ref)).toEqual(dated);
  const snapshot: TspExtensionPage = { ...dated, request: { ...dated.request, selection: { mode: "snapshot" }, offset: 3 },
    partitionDate: null, snapshotSyncLocal: "2025-06-18 16:00:00", rows: [], omittedFields: [],
  };
  expect(await loadTspExtensionPageArchive(await archiveTspExtensionPage(snapshot))).toEqual(snapshot);
});

test("rejects conflicting metadata, scope, coverage, credentials and canceled writes", async () => {
  const copy = page();
  for (const invalid of [
    { ...copy, endpoint: copy.endpoint + "?token=fixture" },
    { ...copy, origin: "https://user:fixture@tsp.example.test" },
    { ...copy, partitionDate: "2025-06-19" }, { ...copy, totalRows: 2 },
    { ...copy, coverage: "complete" as const }, { ...copy, omittedFields: [] },
    { ...copy, rows: [{ category: "A", flow: "0" }, ...copy.rows.slice(1)] },
    { ...copy, rows: [{ category: "A", flow: 0, extra: 1 }, ...copy.rows.slice(1)] },
    { ...copy, fields: copy.fields.toReversed() },
  ]) await expect(archiveTspExtensionPage(invalid)).rejects.toThrow("Invalid observation archive");
  await expect(archiveTspExtensionPage(copy, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(existsSync(dir())).toBe(false);
});

test("validates references and refuses corrupt stored bytes", async () => {
  const ref = await archiveTspExtensionPage(page());
  await expect(loadTspExtensionPageArchive({ ...ref, revision: "../outside" })).rejects.toThrow("Invalid observation archive");
  await expect(loadTspExtensionPageArchive({ ...ref, revision: "0".repeat(64) })).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(dir(), ref.revision + ".json"), "{}");
  await expect(loadTspExtensionPageArchive(ref)).rejects.toThrow("Observation archive is damaged");
  await expect(archiveTspExtensionPage(page())).rejects.toThrow("Observation archive is damaged");
});

test("cancellation while another writer holds the lease cannot publish a page", async () => {
  const receipt = page();
  const ref = await archiveTspExtensionPage(receipt);
  const target = join(dir(), ref.revision + ".json");
  unlinkSync(target);
  const controller = new AbortController();
  const reason = new Error("cancel extension page capture");
  await withFileLockAsync(target, async () => {
    const pending = archiveTspExtensionPage(receipt, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(existsSync(target)).toBe(false);
  });
  expect(await archiveTspExtensionPage(receipt)).toEqual(ref);
});

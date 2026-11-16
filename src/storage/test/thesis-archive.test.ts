import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { artifactReference, listArtifacts, listArtifactVersions, loadArtifactSnapshot, saveArtifact } from "../src/artifacts.ts";
import type { ThesisBaselineArchive, ThesisSourceArchive, ThesisTspArchive } from "../../types/thesis-archive.ts";

let root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-thesis-archive-")); process.env.OHQUANT_DIR = root; });
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous;
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture directory");
  rmSync(root, { recursive: true, force: true });
});
function fixture(): ThesisBaselineArchive {
  return { version: 1, kind: "baseline", workspaceId: "workspace", sessionId: "session", requestId: "request", requestFingerprint: "a".repeat(64), recordedAt: "2026-11-15T00:00:00.000Z",
    source: { artifactId: "original", revision: "b".repeat(64) }, groupId: "group", symbol: "600000.SH",
    assumption: { asOf: "2026-11-15T00:00:00.000Z", assumptionId: "margin", statement: "Private assumption", metric: { name: "margin", value: 22, unit: "percent", period: "2026-Q3", definition: "disclosed gross margin", adjustment: "none" }, threshold: { operator: "gte", value: 20 } } };
}

test("private baseline is retained immutably while metadata listings contain no payload", () => {
  const payload = fixture(), first = saveArtifact("manual", "<p>first</p>", { privateResearch: payload }, null);
  const second = saveArtifact("manual", "<p>ordinary report</p>", {}, first.revision);
  const saved = loadArtifactSnapshot(artifactReference(first))!;
  expect(saved.privateResearch).toEqual(payload); expect(saved.html).toBe("<p>first</p>");
  expect(loadArtifactSnapshot(artifactReference(second))!.privateResearch).toBeUndefined();
  expect(JSON.stringify(listArtifacts())).not.toContain("Private assumption");
  expect(JSON.stringify(listArtifactVersions("manual"))).not.toContain("Private assumption");
  expect(first).not.toHaveProperty("privateResearch");
});

test("tampering or stripping retained data invalidates only that snapshot and never uses a newer version", () => {
  const first = saveArtifact("manual", "<p>first</p>", { privateResearch: fixture() }, null);
  saveArtifact("manual", "<p>second</p>", {}, first.revision);
  const archive = join(root, "artifacts/.revisions/manual", first.revision!, "report.json");
  const original = readFileSync(archive, "utf8"), damaged = JSON.parse(original);
  damaged.privateResearch.assumption.metric.value = 99; writeFileSync(archive, JSON.stringify(damaged));
  expect(loadArtifactSnapshot(artifactReference(first))).toBeNull();
  delete damaged.privateResearch; writeFileSync(archive, JSON.stringify(damaged));
  expect(loadArtifactSnapshot(artifactReference(first))).toBeNull();
  writeFileSync(archive, original); expect(loadArtifactSnapshot(artifactReference(first))!.privateResearch).toEqual(fixture());
});

test("old reports keep the original fingerprint format", () => {
  const meta = saveArtifact("old", "original", { title: "Old" }, null), { revision, ...fields } = meta;
  expect(revision).toBe(createHash("sha256").update(JSON.stringify({ version: 1, meta: fields, html: "original" })).digest("hex"));
  expect(loadArtifactSnapshot(artifactReference(meta))!.html).toBe("original");
});

test("TSP raw result is retained only inside its immutable private envelope", () => {
  const base = fixture(), content = '{"alerts":[],"private":"original-tool-bytes"}';
  const payload: ThesisTspArchive = { version: 1, kind: "tsp-observation", workspaceId: base.workspaceId, sessionId: base.sessionId,
    requestId: base.requestId, requestFingerprint: base.requestFingerprint, recordedAt: base.recordedAt, baseline: base.source,
    batch: { version: 1, server: "tsp", symbol: base.symbol, configuredScopes: ["read:market", "read:analysis"], observations: [
      { tool: "get_recent_alerts", parameters: { limit: 20 }, sourceUrl: "http://127.0.0.1:3018/api/alerts", retrievedAt: base.recordedAt,
        status: "available", content, sha256: createHash("sha256").update(content).digest("hex"), reason: null },
    ] } };
  const meta = saveArtifact("tsp", "<p>private observation</p>", { privateResearch: payload }, null);
  expect(loadArtifactSnapshot(artifactReference(meta))!.privateResearch).toEqual(payload);
  expect(JSON.stringify(listArtifacts())).not.toContain("original-tool-bytes");
  const path = join(root, "artifacts/.revisions/tsp", meta.revision!, "report.json"), damaged = JSON.parse(readFileSync(path, "utf8"));
  damaged.privateResearch.batch.observations[0].content = "{}"; writeFileSync(path, JSON.stringify(damaged));
  expect(loadArtifactSnapshot(artifactReference(meta))).toBeNull();
});

test("source-check text remains private and every retained page participates in the snapshot hash", () => {
  const base = fixture(), pages = [{ page: 1, text: "private synthetic disclosure" }];
  const payload: ThesisSourceArchive = { version: 1, kind: "source-check", workspaceId: base.workspaceId, sessionId: base.sessionId,
    requestId: base.requestId, requestFingerprint: base.requestFingerprint, recordedAt: base.recordedAt, baseline: base.source,
    disclosureUrl: "https://static.cninfo.com.cn/synthetic.pdf",
    price: { symbol: base.symbol, start: "2020-01-02", end: "2020-01-03", checkedAt: base.recordedAt, status: "unavailable", reason: "Synthetic unavailable source" },
    disclosure: { symbol: base.symbol, requestedUrl: "https://static.cninfo.com.cn/synthetic.pdf", finalUrl: "https://static.cninfo.com.cn/synthetic.pdf",
      fetchedAt: base.recordedAt, status: "available", method: "unpdf-1.9.1-page-text", originalSha256: "c".repeat(64), originalBytes: 100,
      textSha256: createHash("sha256").update(JSON.stringify(pages)).digest("hex"), totalPages: 1, pages, symbolMention: "unverified", reason: "Synthetic fixture" } };
  const first = saveArtifact("sources", "<p>fixed</p>", { privateResearch: payload }, null);
  saveArtifact("sources", "<p>later</p>", {}, first.revision);
  expect(loadArtifactSnapshot(artifactReference(first))!.privateResearch).toEqual(payload);
  expect(JSON.stringify(listArtifacts())).not.toContain(pages[0]!.text);
  expect(JSON.stringify(listArtifactVersions("sources"))).not.toContain(pages[0]!.text);
  const path = join(root, "artifacts/.revisions/sources", first.revision!, "report.json"), damaged = JSON.parse(readFileSync(path, "utf8"));
  damaged.privateResearch.disclosure.pages[0].text = "replacement"; writeFileSync(path, JSON.stringify(damaged));
  expect(loadArtifactSnapshot(artifactReference(first))).toBeNull();
  expect(loadArtifactSnapshot("sources")!.html).toBe("<p>later</p>");
});

test("invalid, oversized and non-JSON private inputs are rejected before any head is created", () => {
  for (const change of [
    (value: any) => { value.version = 2; }, (value: any) => { value.kind = "unknown"; },
    (value: any) => { value.sessionId = "../other"; }, (value: any) => { value.requestFingerprint = "not-a-hash"; },
    (value: any) => { value.assumption.statement = "x".repeat(4 * 1024 * 1024); },
    (value: any) => { value.assumption.metric.value = NaN; }, (value: any) => { value.assumption.threshold = undefined; },
  ]) {
    const payload = fixture(); change(payload);
    expect(() => saveArtifact("invalid", "body", { privateResearch: payload }, null)).toThrow();
    expect(loadArtifactSnapshot("invalid")).toBeNull();
  }
});

test("stale writes preserve the committed private baseline and HTML", () => {
  const first = saveArtifact("manual", "original", { privateResearch: fixture() }, null);
  expect(() => saveArtifact("manual", "replacement", {}, null)).toThrow("Report changed");
  expect(loadArtifactSnapshot("manual")!.meta.revision).toBe(first.revision);
  expect(loadArtifactSnapshot("manual")!.privateResearch).toEqual(fixture());
});

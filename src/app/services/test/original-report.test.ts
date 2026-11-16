import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveArtifact } from "../../../storage/index.ts";
import type { ArtifactRequest, SessionSnapshot } from "../../../types/workbench.ts";
import { MAX_ORIGINAL_REPORT_BYTES, readOriginalReport } from "../artifacts.ts";

let root: string, previous: string | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "whyj-original-report-")); previous = process.env.OHQUANT_DIR; process.env.OHQUANT_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
function fixture(html = '<!doctype html><title>原始报告</title>\r\n<script>window.original = true</script>') {
  const meta = saveArtifact("original", html, { title: "Original", messageCount: 0 }, null);
  const request: ArtifactRequest = { workspaceId: "workspace", sessionId: "session", artifactId: "original", sha256: meta.revision! };
  const artifact = { id: "original", title: "Original", version: 1, sha256: meta.revision!, createdAt: meta.createdAt, runId: "run" };
  const snapshot = { identity: { workspaceId: "workspace", sessionId: "session" }, state: "running", revision: 7,
    output: { artifacts: [artifact] } } as unknown as SessionSnapshot;
  const path = join(root, "artifacts", ".revisions", "original", meta.revision!, "report.json");
  return { html, request, snapshot, path };
}
test("original HTML is byte-identical and an older revision remains readable without changing the running snapshot", () => {
  const { html, request, snapshot, path } = fixture(), before = structuredClone(snapshot), stored = readFileSync(path);
  saveArtifact("original", "<title>New report</title>", {}, request.sha256);
  const result = readOriginalReport(request, snapshot);
  expect(Buffer.from(result.html)).toEqual(Buffer.from(html));
  expect(result.bytes).toBe(Buffer.byteLength(html));
  expect(result.htmlSha256).toBe(createHash("sha256").update(html).digest("hex"));
  expect(result.htmlSha256).not.toBe(request.sha256);
  expect(result.artifact.sha256).toBe(request.sha256);
  expect(snapshot).toEqual(before); expect(readFileSync(path)).toEqual(stored);
});
test("membership binds workspace, session, artifact and exact revision before reading", () => {
  const { request, snapshot } = fixture();
  for (const change of [{ workspaceId: "other" }, { sessionId: "other" }, { artifactId: "other" }, { sha256: "a".repeat(64) }]) {
    expect(() => readOriginalReport({ ...request, ...change }, snapshot)).toThrow("固定报告版本无法读取或验证");
  }
  expect(() => readOriginalReport(request, { ...snapshot, output: { ...snapshot.output, artifacts: [] } })).toThrow();
});
test("corrupt or missing immutable content never falls back to the newer head or exposes paths", () => {
  const { request, snapshot, path } = fixture();
  saveArtifact("original", "<title>New report</title>", {}, request.sha256);
  const saved = JSON.parse(readFileSync(path, "utf8")); saved.html += "tampered";
  writeFileSync(path, JSON.stringify(saved));
  for (const missing of [false, true]) {
    if (missing) unlinkSync(path);
    try { readOriginalReport(request, snapshot); throw new Error("Unexpected success"); }
    catch (error) { expect(error).toMatchObject({ code: "ARTIFACT_UNAVAILABLE", status: 409 }); expect(String(error)).not.toContain(root); }
  }
});
test("empty verified reports remain empty and over-limit UTF-8 HTML is explicitly refused", () => {
  const empty = fixture(""); expect(readOriginalReport(empty.request, empty.snapshot).bytes).toBe(0);
  const html = "中".repeat(Math.floor(MAX_ORIGINAL_REPORT_BYTES / 3) + 1);
  const meta = saveArtifact("original", html, {}, empty.request.sha256);
  const request = { ...empty.request, sha256: meta.revision! };
  const snapshot = { ...empty.snapshot, output: { ...empty.snapshot.output, artifacts: [{ ...empty.snapshot.output.artifacts[0]!, sha256: meta.revision! }] } };
  expect(() => readOriginalReport(request, snapshot)).toThrow("8 MiB");
});

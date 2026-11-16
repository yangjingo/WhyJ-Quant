import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { acquireResourceLeases, createWorkbenchSessionStore, listArtifacts, loadArtifactSnapshot, readSettings, saveArtifact, saveSettings } from "../../../storage/index.ts";
import { createDefaultSessionDependencies } from "../../../runtime/session-dependencies.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { ArtifactSummary, WorkspaceIdentity } from "../../../types/workbench.ts";
import type { ThesisBaselineRequest, ThesisReviewRequest } from "../../../types/thesis-workbench.ts";
import { createResearchService } from "../research.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";
import { createHostClient } from "../../host/client.ts";

let root: string, prior: Record<string, string | undefined>, identity: WorkspaceIdentity, source: ArtifactSummary;
let service: ReturnType<typeof createResearchService>, host: ReturnType<typeof startWorkbenchServer> | undefined;
let store: ReturnType<typeof createWorkbenchSessionStore>, failSave: boolean, dependencyCalls: number;
function options() {
  return { cwd: root, store: { ...store, async save(...args: Parameters<typeof store.save>) {
    if (failSave) { failSave = false; throw new Error("Synthetic checkpoint failure"); }
    return store.save(...args);
  } }, dependencies: () => { dependencyCalls++; throw new Error("Manual reviews must not create an Agent environment"); },
    overview: { intervalMs: 0, loadPortfolio: () => ({ symbols: [] }), quoteFetcher: async () => [] } };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "whyj-thesis-service-")); prior = {};
  for (const [key, value] of Object.entries({ OHQUANT_DIR: root, PI_CODING_AGENT_DIR: join(root, "pi"), OHQUANT_SKILLS_DIR: join(root, "skills"), WHYJ_RESOURCE_LEASE_ROOT: join(root, "leases"), NO_PROXY: "127.0.0.1,localhost" })) { prior[key] = process.env[key]; process.env[key] = value; }
  const settings = structuredClone(DEFAULT_SETTINGS); settings.provider = "custom"; settings.model = "synthetic";
  settings.providers = { custom: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-private-key-254" } }; saveSettings(settings);
  failSave = false; dependencyCalls = 0; store = createWorkbenchSessionStore();
  service = createResearchService(options()); identity = await service.client.identity(); await service.close();
  const meta = saveArtifact("original", "<!doctype html><title>Existing synthetic report</title><p>Historical report, no structured assumption.</p>", { title: "Original" }, null);
  source = { id: meta.sessionId, version: 1, title: meta.title, sha256: meta.revision!, createdAt: meta.createdAt };
  const loaded = store.load(identity.workspaceId, identity.sessionId);
  await store.save({ ...loaded.record, snapshot: { ...loaded.record.snapshot, revision: loaded.record.snapshot.revision! + 1,
    output: { ...loaded.record.snapshot.output, artifacts: [source] } } }, loaded.revision);
  service = createResearchService(options());
});
afterEach(async () => {
  if (host) { await host.close(); host = undefined; } else await service.close();
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root");
  rmSync(root, { recursive: true, force: true });
});
const ref = (artifact: ArtifactSummary) => ({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, artifactId: artifact.id, sha256: artifact.sha256 });
function configureTsp(mode = "normal", alertMs?: number) {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"), JSON.stringify({ mcpServers: { tsp: {
    enabled: mode !== "disabled", command: process.execPath, args: [resolve(import.meta.dirname, "../../../runtime/test/fixtures/tsp-mcp-server.ts")],
    env: { TSP_BASE: "http://127.0.0.1:3018", TSP_TOKEN: "fixture-tsp-key", TSP_SCOPES: "read:market,read:analysis", TSP_FIXTURE_MODE: mode, TSP_FIXTURE_LOG: join(root, "tsp-calls.jsonl"), ...(alertMs === undefined ? {} : { TSP_FIXTURE_ALERT_MS: String(alertMs) }) },
  } } }));
}
const tspEvents = () => existsSync(join(root, "tsp-calls.jsonl")) ? readFileSync(join(root, "tsp-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
async function tspRequest(base: ArtifactSummary, requestId = "tsp-1") {
  return { ...ref(base), requestId, expectedRevision: (await service.client.session(identity.sessionId)).revision! };
}
async function baselineRequest(requestId = "baseline-1"): Promise<ThesisBaselineRequest> {
  return { ...ref(source), requestId, expectedRevision: (await service.client.session(identity.sessionId)).revision!, groupId: "synthetic-group", symbol: "600000.SH",
    assumption: { assumptionId: "margin", statement: "Synthetic margin remains at least 20 percent", metric: { name: "margin", value: 22, period: "2026-Q3", unit: "percent", definition: "consolidated gross margin", adjustment: "none" }, threshold: { operator: "gte", value: 20 } } };
}
async function reviewRequest(base: ArtifactSummary, requestId = "review-1"): Promise<ThesisReviewRequest> {
  const baseline = await service.client.readThesis!(ref(base)); if (baseline.kind !== "baseline") throw new Error("Not a baseline");
  const now = new Date().toISOString(), content = "Synthetic original disclosure: consolidated gross margin 18 percent for 2026-Q3. private-source-body";
  return { ...ref(base), requestId, expectedRevision: (await service.client.session(identity.sessionId)).revision!, cutoff: now,
    event: { id: "event-1", kind: "fundamental", occurredAt: baseline.recordedAt, sourceUrl: "https://example.com/event", summary: "Synthetic corrected disclosure" },
    evidence: [{ id: "disclosure", symbol: "600000.SH", kind: "fundamental", sourceUrl: "https://example.com/disclosure", publishedAt: baseline.recordedAt, retrievedAt: now, origin: "source",
      dataRef: { id: "retained", sha256: createHash("sha256").update(content).digest("hex") }, metric: { ...baseline.assumption.metric, value: 18 } }],
    parameters: { synthetic: true }, decision: null, retainedEvidence: [{ id: "retained", mediaType: "text/plain", content }], price: null };
}

test("explicit baseline and review persist exact provenance without an Agent and reopen after restart", async () => {
  const started = new Date().toISOString(), request = await baselineRequest();
  const base = await service.client.establishThesis!(request), baseline = await service.client.readThesis!(ref(base));
  expect(baseline.kind).toBe("baseline"); expect(baseline.recordedAt >= started).toBe(true);
  const input = await reviewRequest(base), review = await service.client.saveThesisReview!(input);
  const saved = loadArtifactSnapshot(`${review.id}@${review.sha256}`)!;
  expect(saved.privateResearch?.kind).toBe("review"); expect(saved.html).toContain("18 percent");
  expect(saved.meta.sourceSessionId).toBe(source.id); expect(base.kind).toBe("thesis-baseline"); expect(review.kind).toBe("thesis-review");
  expect(saved.html).toContain(base.sha256); expect(dependencyCalls).toBe(0);
  await service.close(); service = createResearchService(options());
  const view = await service.client.readThesis!(ref(review)); expect(view.kind).toBe("review");
  if (view.kind !== "review") throw new Error("Wrong view");
  expect(view.result.outcome).toBe("assumption_review"); expect(view.result.input.decision).toBeNull();
  expect(JSON.stringify(view)).not.toContain("private-source-body"); expect(view.retainedEvidence[0]!.sha256).toBe(input.evidence[0]!.dataRef!.sha256);
  expect((await service.client.readReport!(ref(review))).html).toBe(saved.html);
  expect(await service.client.saveThesisReview!(input)).toEqual(review);
  expect((await service.client.session(identity.sessionId)).output.artifacts).toHaveLength(3);
});

test("duplicate concurrent commands share one result and changed input with the same id conflicts", async () => {
  const input = await baselineRequest();
  const [a, b] = await Promise.all([service.client.establishThesis!(input), service.client.establishThesis!(input)]);
  expect(a).toEqual(b); expect(listArtifacts()).toHaveLength(2);
  await expect(service.client.establishThesis!({ ...input, groupId: "different" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  expect((await service.client.session(identity.sessionId)).output.artifacts).toHaveLength(2);
});

test("checkpoint failure leaves one recoverable candidate and retry after restart attaches those exact bytes", async () => {
  const input = await baselineRequest(); failSave = true;
  await expect(service.client.establishThesis!(input)).rejects.toMatchObject({ code: "SESSION_STORAGE" });
  const orphan = listArtifacts().find(item => item.sessionId !== source.id)!;
  expect(orphan).toBeDefined(); const fixed = loadArtifactSnapshot(`${orphan.sessionId}@${orphan.revision}`)!;
  await service.close(); service = createResearchService(options());
  expect((await service.client.session(identity.sessionId)).output.artifacts).toHaveLength(1);
  const result = await service.client.establishThesis!(input);
  expect(result.sha256).toBe(orphan.revision!); expect(loadArtifactSnapshot(`${result.id}@${result.sha256}`)!.html).toBe(fixed.html);
  expect(listArtifacts()).toHaveLength(2); expect((await service.client.session(identity.sessionId)).output.artifacts).toHaveLength(2);
});

test("missing evidence is pending, while a claimed retained version without matching bytes is rejected", async () => {
  const base = await service.client.establishThesis!(await baselineRequest()), input = await reviewRequest(base);
  await expect(service.client.saveThesisReview!({ ...input, retainedEvidence: [] })).rejects.toMatchObject({ code: "THESIS_EVIDENCE_UNAVAILABLE" });
  const report = await service.client.saveThesisReview!({ ...input, evidence: [], retainedEvidence: [] });
  const view = await service.client.readThesis!(ref(report)); expect(view.kind === "review" && view.result.outcome).toBe("pending_verification");
});

test("workspace, membership, revision and credential violations cannot create a baseline", async () => {
  const input = await baselineRequest(), other = await service.client.createSession();
  await expect(service.client.establishThesis!({ ...input, workspaceId: "wrong" })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  await expect(service.client.establishThesis!({ ...input, sessionId: other.sessionId })).rejects.toMatchObject({ code: "THESIS_UNAVAILABLE" });
  await expect(service.client.establishThesis!({ ...input, expectedRevision: 999 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(service.client.establishThesis!({ ...input, assumption: { ...input.assumption, statement: "fixture-private-key-254" } })).rejects.toMatchObject({ code: "THESIS_PRIVATE_INPUT" });
  expect(listArtifacts()).toHaveLength(1);
});

test("corrupt exact baseline never falls back to a different report version", async () => {
  const base = await service.client.establishThesis!(await baselineRequest()), input = await reviewRequest(base), report = await service.client.saveThesisReview!(input);
  const path = join(root, "artifacts/.revisions", base.id, base.sha256, "report.json"), data = JSON.parse(readFileSync(path, "utf8"));
  data.privateResearch.assumption.metric.value = 999; writeFileSync(path, JSON.stringify(data));
  await expect(service.client.readThesis!(ref(report))).rejects.toMatchObject({ code: "THESIS_UNAVAILABLE" });
  await expect(service.client.saveThesisReview!({ ...input, requestId: "another", expectedRevision: (await service.client.session(identity.sessionId)).revision! })).rejects.toMatchObject({ code: "THESIS_UNAVAILABLE" });
  expect(loadArtifactSnapshot(`${report.id}@${report.sha256}`)!.html).toContain("18 percent");
});

test("authenticated Host RPC exposes bounded manual records and rejects unauthenticated writes", async () => {
  const assetsRoot = join(root, "assets"); mkdirSync(assetsRoot); writeFileSync(join(assetsRoot, "index.html"), "<title>Synthetic API fixture</title>");
  host = startWorkbenchServer({ service, assetsRoot, port: 0 }); await host.ready;
  const input = await baselineRequest(), url = host.server.url.origin;
  const denied = await fetch(url + "/api/workbench/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "establishThesis", args: [input] }) });
  expect(denied.status).toBe(401); expect(listArtifacts()).toHaveLength(1);
  const client = createHostClient({ baseUrl: url }), base = await client.establishThesis!(input);
  const request = await reviewRequest(base), report = await client.saveThesisReview!(request), view = await client.readThesis!(ref(report));
  expect(view.kind === "review" && view.result.outcome).toBe("assumption_review"); expect(dependencyCalls).toBe(0);
});

test("historical events stay pending and future cutoffs cannot manufacture a new observation", async () => {
  const base = await service.client.establishThesis!(await baselineRequest()), input = await reviewRequest(base);
  await expect(service.client.saveThesisReview!({ ...input, cutoff: "2099-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "THESIS_INPUT_INVALID" });
  const report = await service.client.saveThesisReview!({ ...input, event: { ...input.event, occurredAt: "2020-01-01T00:00:00.000Z" } });
  const view = await service.client.readThesis!(ref(report));
  expect(view.kind === "review" && view.result.outcome).toBe("pending_verification");
  expect(view.kind === "review" && view.result.reasons).toContain("event_outside_baseline_cutoff");
});

test("fixed price data and explicit decision survive restart, while changed retained bytes fail closed", async () => {
  const base = await service.client.establishThesis!(await baselineRequest()), input = await reviewRequest(base);
  const rows = [{ date: "2020-01-02", open: 10, high: 12, low: 9, close: 11, vol: 100 }, { date: "2020-01-03", open: 11, high: 13, low: 10, close: 12, vol: 110 }];
  const content = JSON.stringify(rows), dataRef = { id: "prices", sha256: createHash("sha256").update(content).digest("hex") };
  const request: ThesisReviewRequest = { ...input, price: { symbol: "600000.SH", sourceUrl: "https://example.com/prices", retrievedAt: input.cutoff, adjustment: "none", currency: "CNY", volumeUnit: "shares", rows, dataRef },
    decision: { action: "defer", rationale: "Human decision: verify the disclosure first", decidedAt: input.cutoff },
    retainedEvidence: [...input.retainedEvidence, { id: "prices", mediaType: "application/json", content }] };
  await expect(service.client.saveThesisReview!({ ...request, retainedEvidence: request.retainedEvidence.map(item => item.id === "prices" ? { ...item, content: "[]" } : item) })).rejects.toMatchObject({ code: "THESIS_EVIDENCE_UNAVAILABLE" });
  const report = await service.client.saveThesisReview!(request);
  await service.close(); service = createResearchService(options());
  const view = await service.client.readThesis!(ref(report));
  expect(view.kind === "review" && view.price?.rows).toEqual(rows);
  expect(view.kind === "review" && view.result.input.decision).toEqual(request.decision);
  expect(view.kind === "review" && view.result.outcome).toBe("assumption_review");
  const path = join(root, "artifacts/.revisions", report.id, report.sha256, "report.json"), data = JSON.parse(readFileSync(path, "utf8"));
  data.privateResearch.retainedEvidence[0].content = "changed bytes"; writeFileSync(path, JSON.stringify(data));
  await expect(service.client.readThesis!(ref(report))).rejects.toMatchObject({ code: "THESIS_UNAVAILABLE" });
});

test("reading a baseline preserves an active run and manual writes wait for it to finish", async () => {
  const base = await service.client.establishThesis!(await baselineRequest()), input = await reviewRequest(base);
  await service.close(); let requests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": waiting\n\n")); } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const settings = readSettings(); settings.providers!.custom!.baseUrl = model.url.origin + "/v1"; saveSettings(settings);
    service = createResearchService({ ...options(), dependencies: () => createDefaultSessionDependencies({ cwd: root }) });
    const run = await service.client.submit({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, expectedRevision: (await service.client.session(identity.sessionId)).revision!, requestId: "held-run", text: "Hold a synthetic research run" });
    for (let i = 0; i < 200 && requests === 0; i++) await Bun.sleep(25);
    expect(requests).toBe(1);
    expect((await service.client.readThesis!(ref(base))).kind).toBe("baseline");
    await expect(service.client.saveThesisReview!(input)).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await expect(service.client.collectThesisTsp!(await tspRequest(base))).rejects.toMatchObject({ code: "SESSION_BUSY" });
    const current = await service.client.session(identity.sessionId);
    expect(current.state).toBe("running"); expect(current.identity.runId).toBe(run.runId); expect(requests).toBe(1); expect(listArtifacts()).toHaveLength(2);
  } finally { await service.close(); model.stop(true); }
}, 20000);

test("TSP collection uses actual Pi transport, keeps large raw bodies on Host, coalesces retries and reopens without fetching", async () => {
  configureTsp("large"); const base = await service.client.establishThesis!(await baselineRequest()), input = await tspRequest(base);
  const [first, concurrent] = await Promise.all([service.client.collectThesisTsp!(input), service.client.collectThesisTsp!(input)]);
  expect(first).toEqual(concurrent); expect(first.symbol).toBe("600000.SH");
  expect(first.observations[0]!.bytes).toBeGreaterThan(128 * 1024); expect(JSON.stringify(first)).not.toContain("synthetic-raw-");
  expect(first.baseline).toEqual(ref(base)); expect(first.artifact.kind).toBe("tsp-observation");
  const saved = loadArtifactSnapshot(`${first.artifact.id}@${first.artifact.sha256}`)!;
  expect(saved.privateResearch?.kind).toBe("tsp-observation"); expect(saved.html).toContain("synthetic-raw-");
  expect(JSON.stringify(saved)).not.toContain("fixture-tsp-key"); expect(JSON.stringify(listArtifacts())).not.toContain("synthetic-raw-");
  expect(tspEvents().filter(item => item.type === "call").map(item => item.name)).toEqual(["get_recent_alerts", "get_kline"]);
  expect(dependencyCalls).toBe(0); expect((await service.client.session(identity.sessionId)).output.artifacts).toHaveLength(3);
  await service.close(); service = createResearchService(options()); configureTsp("hold");
  expect(await service.client.readThesisTsp!(ref(first.artifact))).toEqual(first);
  expect(await service.client.collectThesisTsp!(input)).toEqual(first);
  expect(tspEvents().filter(item => item.type === "call")).toHaveLength(2);
  const secondBase = await service.client.establishThesis!(await baselineRequest("baseline-2"));
  await expect(service.client.collectThesisTsp!({ ...input, artifactId: secondBase.id, sha256: secondBase.sha256 })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
});

test("TSP orphan retry after checkpoint failure attaches the same snapshot without a second collection", async () => {
  configureTsp(); const base = await service.client.establishThesis!(await baselineRequest()), input = await tspRequest(base);
  failSave = true;
  await expect(service.client.collectThesisTsp!(input)).rejects.toMatchObject({ code: "SESSION_STORAGE" });
  const orphan = listArtifacts().find(item => item.title.includes("TSP"))!; expect(orphan).toBeDefined();
  expect(store.load(identity.workspaceId, identity.sessionId).record.snapshot.output.artifacts).toHaveLength(2);
  await service.close(); service = createResearchService(options()); configureTsp("hold");
  const recovered = await service.client.collectThesisTsp!(input);
  expect(recovered.artifact.sha256).toBe(orphan.revision!); expect(tspEvents().filter(item => item.type === "call")).toHaveLength(2);
  expect((await service.client.session(identity.sessionId)).output.artifacts).toHaveLength(3);
});

test("TSP missing tool results stay explicit and authenticated RPC returns bounded references", async () => {
  configureTsp("missing"); const base = await service.client.establishThesis!(await baselineRequest()), input = await tspRequest(base);
  const assetsRoot = join(root, "assets"); mkdirSync(assetsRoot); writeFileSync(join(assetsRoot, "index.html"), "<title>Synthetic TSP API fixture</title>");
  host = startWorkbenchServer({ service, assetsRoot, port: 0 }); await host.ready; const url = host.server.url.origin;
  const denied = await fetch(url + "/api/workbench/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "collectThesisTsp", args: [input] }) });
  expect(denied.status).toBe(401); expect(tspEvents()).toHaveLength(0);
  const client = createHostClient({ baseUrl: url });
  configureTsp("disabled"); await expect(client.collectThesisTsp!(input)).rejects.toThrow("TSP 只读连接不可用"); expect(tspEvents()).toHaveLength(0);
  configureTsp("missing"); const result = await client.collectThesisTsp!(input);
  expect(result.observations.map(item => item.status)).toEqual(["unavailable", "available"]);
  expect(result.observations[0]!.sha256).toBeNull(); expect(await client.readThesisTsp!(ref(result.artifact))).toEqual(result);
  const bootstrap = await (await fetch(url + "/api/workbench/bootstrap")).json() as { token: string };
  const report = await fetch(url + "/api/workbench/report", { method: "POST", headers: { "content-type": "application/json", "x-workbench-token": bootstrap.token }, body: JSON.stringify(ref(result.artifact)) });
  expect(report.status).toBe(200); expect(await report.text()).toContain("不可用");
});

test("TSP rejects foreign or corrupt baseline, stale revisions and conflicting request kinds before opening a connection", async () => {
  configureTsp(); const base = await service.client.establishThesis!(await baselineRequest()), input = await tspRequest(base);
  const other = await service.client.createSession();
  await expect(service.client.collectThesisTsp!({ ...input, sessionId: other.sessionId })).rejects.toMatchObject({ code: "THESIS_UNAVAILABLE" });
  await expect(service.client.collectThesisTsp!({ ...input, expectedRevision: 999 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(service.client.collectThesisTsp!({ ...input, requestId: "baseline-1" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  const path = join(root, "artifacts/.revisions", base.id, base.sha256, "report.json"), data = JSON.parse(readFileSync(path, "utf8"));
  data.html += "damage"; writeFileSync(path, JSON.stringify(data));
  await expect(service.client.collectThesisTsp!(input)).rejects.toMatchObject({ code: "THESIS_UNAVAILABLE" });
  expect(tspEvents()).toHaveLength(0);
});

test("TSP collection respects resource leases, blocks concurrent mutation and service close awaits the cancelled child", async () => {
  configureTsp("hold"); const base = await service.client.establishThesis!(await baselineRequest()), input = await tspRequest(base);
  const release = await acquireResourceLeases([process.env.PI_CODING_AGENT_DIR!], "write");
  try { await expect(service.client.collectThesisTsp!(input)).rejects.toMatchObject({ code: "RESOURCES_IN_USE" }); }
  finally { release(); }
  expect(tspEvents()).toHaveLength(0);
  const promise = service.client.collectThesisTsp!(input), settled = promise.then(() => null, error => error);
  for (let i = 0; i < 100 && !tspEvents().some(item => item.type === "call"); i++) await Bun.sleep(20);
  expect(tspEvents().filter(item => item.type === "call")).toHaveLength(1);
  await expect(service.client.establishThesis!(await baselineRequest("blocked"))).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await expect(service.client.submit({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, requestId: "blocked-run", expectedRevision: input.expectedRevision, text: "new run" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  expect((await service.client.readThesis!(ref(base))).kind).toBe("baseline");
  await service.close(); expect(await settled).toBeInstanceOf(Error);
  const pid = tspEvents().find(item => item.type === "start").pid; expect(() => process.kill(pid, 0)).toThrow();
  expect(tspEvents().filter(item => item.type === "call")).toHaveLength(1); expect(listArtifacts()).toHaveLength(2);
});

test("damaged TSP snapshot fails closed and cannot silently refetch or fall back to another version", async () => {
  configureTsp(); const base = await service.client.establishThesis!(await baselineRequest()), input = await tspRequest(base);
  const first = await service.client.collectThesisTsp!(input);
  const path = join(root, "artifacts/.revisions", first.artifact.id, first.artifact.sha256, "report.json"), data = JSON.parse(readFileSync(path, "utf8"));
  data.privateResearch.batch.observations[0].content = "{}"; writeFileSync(path, JSON.stringify(data));
  await expect(service.client.readThesisTsp!(ref(first.artifact))).rejects.toMatchObject({ code: "TSP_OBSERVATION_UNAVAILABLE" });
  await expect(service.client.collectThesisTsp!(input)).rejects.toMatchObject({ code: "TSP_OBSERVATION_UNAVAILABLE" });
  expect(tspEvents().filter(item => item.type === "call")).toHaveLength(2);
});

test("review selects an exact retained TSP alert and fixed closed-day window, without re-fetching or trusting client bars", async () => {
  const base = await service.client.establishThesis!(await baselineRequest());
  const baseline = await service.client.readThesis!(ref(base)); if (baseline.kind !== "baseline") throw new Error("Not a baseline");
  // A child process clock can lead the Host by milliseconds on Windows; pin the synthetic event to the Host baseline.
  configureTsp("selection", Date.parse(baseline.recordedAt));
  const capture = await service.client.collectThesisTsp!(await tspRequest(base));
  expect(capture.alerts).toHaveLength(1); expect(capture.omittedAlerts).toBe(2);
  expect(capture.daily).toEqual({ count: 2, start: "2026-11-12", end: "2026-11-13" });
  const input: ThesisReviewRequest = { ...await reviewRequest(base), event: capture.alerts[0]!.event, evidence: [], retainedEvidence: [],
    tsp: { artifactId: capture.artifact.id, revision: capture.artifact.sha256, alertIndex: capture.alerts[0]!.index,
      price: { start: "2026-11-12", end: "2026-11-13", volumeUnit: "lots" } } };
  let report: ArtifactSummary;
  try { report = await service.client.saveThesisReview!(input); }
  catch (error) {
    console.error("Synthetic TSP selection timing", JSON.stringify({ event: input.event.occurredAt, cutoff: input.cutoff, observations: capture.observations.map(item => ({ tool: item.tool, retrievedAt: item.retrievedAt })), daily: capture.daily }));
    throw error;
  }
  const html = (await service.client.readReport!(ref(report))).html;
  expect(html).toContain(capture.artifact.sha256); expect(html).toContain("前复权"); expect(html).toContain("原始提醒索引 0");
  await service.close(); service = createResearchService(options()); configureTsp("hold");
  const view = await service.client.readThesis!(ref(report)); if (view.kind !== "review") throw new Error();
  if (view.result.outcome !== "price_observation") console.error("Synthetic TSP classification", JSON.stringify({ result: view.result, observations: capture.observations.map(item => ({ tool: item.tool, retrievedAt: item.retrievedAt })), daily: capture.daily }));
  expect(view.result.outcome).toBe("price_observation"); expect(view.result.input.decision).toBeNull();
  expect(view.result.input.evidence[0]!.metric.value).toBe(11); expect(view.price?.rows).toHaveLength(2);
  expect(view.price?.rows[1]!.vol).toBe(100); expect(view.price?.volumeUnit).toBe("lots");
  expect(view.tsp?.selection).toEqual(input.tsp); expect(view.tsp?.artifact).toEqual(capture.artifact);
  expect(view.retainedEvidence.map(item => item.id)).toEqual(["tsp-alerts", "tsp-kline"]);
  expect(await service.client.saveThesisReview!(input)).toEqual(report);
  expect((await service.client.readReport!(ref(report))).html).toBe(html); expect(tspEvents().filter(item => item.type === "call")).toHaveLength(2);
});

test("TSP context never substitutes original fundamental disclosure and malformed daily bars stay unavailable", async () => {
  configureTsp("malformed"); const base = await service.client.establishThesis!(await baselineRequest());
  const capture = await service.client.collectThesisTsp!(await tspRequest(base)); expect(capture.daily).toBeNull(); expect(capture.dailyReason).toContain("无法核验");
  const input: ThesisReviewRequest = { ...await reviewRequest(base), evidence: [], retainedEvidence: [],
    tsp: { artifactId: capture.artifact.id, revision: capture.artifact.sha256, alertIndex: null, price: null } };
  const missing = await service.client.saveThesisReview!(input), view = await service.client.readThesis!(ref(missing));
  expect(view.kind === "review" && view.result.outcome).toBe("pending_verification");
  const complete = await service.client.saveThesisReview!({ ...await reviewRequest(base, "disclosed"), tsp: input.tsp });
  const reviewed = await service.client.readThesis!(ref(complete)); expect(reviewed.kind === "review" && reviewed.result.outcome).toBe("assumption_review");
  await expect(service.client.saveThesisReview!({ ...await reviewRequest(base, "bad-bars"), tsp: { ...input.tsp!, price: { start: "2026-11-12", end: "2026-11-13", volumeUnit: "shares" } } })).rejects.toMatchObject({ code: "TSP_SELECTION_INVALID" });
});

test("selected TSP source rejects fabricated events, foreign baselines, late retrieval and duplicate injected price evidence", async () => {
  configureTsp("selection"); const base = await service.client.establishThesis!(await baselineRequest());
  const capture = await service.client.collectThesisTsp!(await tspRequest(base));
  const input: ThesisReviewRequest = { ...await reviewRequest(base), event: capture.alerts[0]!.event, evidence: [], retainedEvidence: [],
    tsp: { artifactId: capture.artifact.id, revision: capture.artifact.sha256, alertIndex: 0, price: null } };
  for (const changed of [
    { ...input, event: { ...input.event, kind: "fundamental" } },
    { ...input, event: { ...input.event, summary: "Invented source claim" } },
    { ...input, cutoff: "2020-01-01T00:00:00.000Z" },
    { ...input, tsp: { ...input.tsp!, alertIndex: 1 } },
    { ...input, tsp: { ...input.tsp!, price: { start: "2026-11-12", end: "2026-11-13", volumeUnit: "unknown" } } },
  ]) await expect(service.client.saveThesisReview!(changed as ThesisReviewRequest)).rejects.toMatchObject({ code: "TSP_SELECTION_INVALID" });
  const supplied = await reviewRequest(base);
  await expect(service.client.saveThesisReview!({ ...input, evidence: [{ ...supplied.evidence[0]!, id: "tsp-alert-price" }], retainedEvidence: supplied.retainedEvidence })).rejects.toMatchObject({ code: "THESIS_INPUT_INVALID" });
  const otherBase = await service.client.establishThesis!(await baselineRequest("base-other"));
  await expect(service.client.saveThesisReview!({ ...input, ...ref(otherBase), expectedRevision: (await service.client.session(identity.sessionId)).revision! })).rejects.toMatchObject({ code: "TSP_SELECTION_INVALID" });
  expect(tspEvents().filter(item => item.type === "call")).toHaveLength(2);
});

test("reopening a linked review rejects missing or damaged observation without replacing saved report bytes", async () => {
  configureTsp("selection"); const base = await service.client.establishThesis!(await baselineRequest());
  const capture = await service.client.collectThesisTsp!(await tspRequest(base));
  const input = { ...await reviewRequest(base), tsp: { artifactId: capture.artifact.id, revision: capture.artifact.sha256, alertIndex: null, price: null } };
  const review = await service.client.saveThesisReview!(input), original = await service.client.readReport!(ref(review));
  const path = join(root, "artifacts/.revisions", capture.artifact.id, capture.artifact.sha256, "report.json"), raw = JSON.parse(readFileSync(path, "utf8"));
  raw.privateResearch.batch.observations[0].content = "{}"; writeFileSync(path, JSON.stringify(raw));
  await expect(service.client.readThesis!(ref(review))).rejects.toMatchObject({ code: "TSP_OBSERVATION_UNAVAILABLE" });
  expect((await service.client.readReport!(ref(review))).html).toBe(original.html);
  expect(tspEvents().filter(item => item.type === "call")).toHaveLength(2);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkbenchSessionStore, listArtifacts, loadArtifactSnapshot, saveArtifact, saveBars, saveSettings } from "../../../storage/index.ts";
import { readDisclosurePdf } from "../../../source/index.ts";
import { disclosurePdf } from "../../../source/tests/fixtures/disclosure-pdf.ts";
import { collectThesisPriceCheck } from "../../../runtime/research/thesis-price-check.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { ArtifactSummary, WorkspaceIdentity } from "../../../types/workbench.ts";
import type { ThesisReviewRequest, ThesisSourcesRequest, ThesisSourcesView } from "../../../types/thesis-workbench.ts";
import { createResearchService } from "../research.ts";
import { startWorkbenchServer } from "../../workbench/server.ts";
import { createHostClient } from "../../host/client.ts";

const url = "https://static.cninfo.com.cn/finalpage/2026-11-15/synthetic.pdf";
const pdfText = "证券代码：600000 合成披露 毛利率18%";
const window = { start: "2020-01-02", end: "2020-01-03" };
const bars = [window.start, window.end].map(date => ({ date, open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null }));
let root: string, prior: Record<string, string | undefined>, identity: WorkspaceIdentity, base: ArtifactSummary;
let service: ReturnType<typeof createResearchService>, store: ReturnType<typeof createWorkbenchSessionStore>, host: ReturnType<typeof startWorkbenchServer> | undefined;
let priceCalls: number, pdfCalls: number, modelCalls: number, failSave: boolean, sourceChecks: NonNullable<Parameters<typeof createResearchService>[0]>["sourceChecks"];
const ref = (artifact: ArtifactSummary) => ({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, artifactId: artifact.id, sha256: artifact.sha256 });
const options = () => ({ cwd: root, sourceChecks, dependencies: () => { modelCalls++; throw new Error("No model allowed"); },
  store: { ...store, async save(...args: Parameters<typeof store.save>) { if (failSave) { failSave = false; throw new Error("Synthetic checkpoint failure"); } return store.save(...args); } },
  overview: { intervalMs: 0, loadPortfolio: () => ({ symbols: [] }), quoteFetcher: async () => [] } });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "whyj-thesis-sources-")); prior = {};
  for (const [key, value] of Object.entries({ OHQUANT_DIR: root, PI_CODING_AGENT_DIR: join(root, "pi"), OHQUANT_SKILLS_DIR: join(root, "skills"), WHYJ_RESOURCE_LEASE_ROOT: join(root, "leases"), NO_PROXY: "127.0.0.1,localhost" })) { prior[key] = process.env[key]; process.env[key] = value; }
  saveSettings(structuredClone(DEFAULT_SETTINGS)); priceCalls = pdfCalls = modelCalls = 0; failSave = false;
  sourceChecks = {
    prices: async (request, options) => { priceCalls++;
      const dataset = (await saveBars(request.symbol, "akshare", bars, request.start, request.end, options?.signal, "stock_zh_a_hist", "forward-adjusted"))!;
      return collectThesisPriceCheck(request, { signal: options?.signal, fetch: async () => ({ bars, dataset, source: "akshare", origin: "provider", attempts: [], asOfDate: request.end }) });
    },
    disclosure: (symbol, requestedUrl, options) => readDisclosurePdf(symbol, requestedUrl, { ...options,
      fetch: (async (_input: string | URL | Request) => { pdfCalls++; return new Response(disclosurePdf(pdfText), { headers: { "content-type": "application/pdf" } }); }) as typeof fetch }),
  };
  store = createWorkbenchSessionStore(); service = createResearchService(options()); identity = await service.client.identity(); await service.close();
  const original = saveArtifact("original", "<p>Existing report</p>", { title: "Original" }, null);
  const source: ArtifactSummary = { id: original.sessionId, version: 1, title: original.title, sha256: original.revision!, createdAt: original.createdAt };
  const loaded = store.load(identity.workspaceId, identity.sessionId);
  await store.save({ ...loaded.record, snapshot: { ...loaded.record.snapshot, revision: loaded.record.snapshot.revision! + 1, output: { ...loaded.record.snapshot.output, artifacts: [source] } } }, loaded.revision);
  service = createResearchService(options());
  base = await service.client.establishThesis!({ ...ref(source), requestId: "baseline", expectedRevision: (await service.client.session(identity.sessionId)).revision!, groupId: "Synthetic", symbol: "600000.SH",
    assumption: { assumptionId: "margin", statement: "Synthetic margin stays at least 20 percent", metric: { name: "margin", value: 22, period: "2026-Q3", unit: "percent", definition: "consolidated", adjustment: "none" }, threshold: { operator: "gte", value: 20 } } });
});
afterEach(async () => {
  if (host) { await host.close(); host = undefined; } else await service.close();
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root"); rmSync(root, { recursive: true, force: true });
});
async function request(id = "check-1"): Promise<ThesisSourcesRequest> { return { ...ref(base), ...window, disclosureUrl: url, requestId: id, expectedRevision: (await service.client.session(identity.sessionId)).revision! }; }
async function review(checked: ThesisSourcesView, confirmed = true): Promise<ThesisReviewRequest> {
  const baseline = await service.client.readThesis!(ref(base)); if (baseline.kind !== "baseline") throw new Error();
  const page = await service.client.readThesisSources!({ ...ref(checked.artifact), page: 1 });
  const quote = page.page!.text; expect(quote).toContain("毛利率18%");
  return { ...ref(base), requestId: "review-" + confirmed, expectedRevision: (await service.client.session(identity.sessionId)).revision!, cutoff: new Date().toISOString(),
    event: { id: "event", kind: "fundamental", occurredAt: baseline.recordedAt, sourceUrl: url, summary: "Synthetic new disclosure" },
    evidence: [], retainedEvidence: [], price: null, parameters: { synthetic: true }, decision: null,
    checks: { artifactId: checked.artifact.id, revision: checked.artifact.sha256, disclosure: { page: 1, quote, publishedAt: baseline.recordedAt, metric: { ...baseline.assumption.metric, value: 18 }, confirmed } } };
}

test("authenticated source collection, exact PDF page and linked review persist without a model or refetch", async () => {
  const assetsRoot = join(root, "assets"); mkdirSync(assetsRoot); writeFileSync(join(assetsRoot, "index.html"), "<title>Synthetic source API fixture</title>");
  host = startWorkbenchServer({ port: 0, service, assetsRoot }); await host.ready;
  const client = createHostClient({ baseUrl: host.server.url.origin });
  const input = await request(), [a, b] = await Promise.all([client.collectThesisSources!(input), client.collectThesisSources!(input)]);
  expect(a).toEqual(b); expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1);
  expect(a.artifact.kind).toBe("source-check"); expect(a.page).toBeNull(); expect(a.price).not.toHaveProperty("bars");
  expect(JSON.stringify(a)).not.toContain("毛利率18%");
  const page = await client.readThesisSources!({ ...ref(a.artifact), page: 1 }); expect(page.page?.text).toContain("毛利率18%");
  const quote = page.page!.text;
  const inputReview = await review(a), saved = await client.saveThesisReview!(inputReview), html = (await service.client.readReport!(ref(saved))).html;
  expect(html).toContain("行情与原始披露核对"); expect(html).toContain(a.artifact.sha256); expect(html).toContain("用户已确认"); expect(html).toContain("第 1 页");
  const record = await client.readThesis!(ref(saved)); expect(record.kind).toBe("review"); if (record.kind !== "review") throw new Error();
  expect(record.result.outcome).toBe("assumption_review"); expect(record.result.input.decision).toBeNull();
  expect(record.retainedEvidence[0]?.sha256).toBe(createHash("sha256").update(quote).digest("hex")); expect(record.checks?.selection.disclosure?.confirmed).toBe(true);
  await host.close(); host = undefined; service = createResearchService(options());
  expect(await service.client.collectThesisSources!(input)).toEqual(a);
  expect((await service.client.readReport!(ref(saved))).html).toBe(html); expect((await service.client.readThesis!(ref(saved))).kind).toBe("review");
  expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1); expect(modelCalls).toBe(0);
});

test("unconfirmed or missing disclosure stays pending and fabricated quotes or source selections are rejected", async () => {
  const checked = await service.client.collectThesisSources!(await request()), input = await review(checked, false);
  const saved = await service.client.saveThesisReview!(input), view = await service.client.readThesis!(ref(saved));
  expect(view.kind === "review" && view.result.outcome).toBe("pending_verification");
  await expect(service.client.saveThesisReview!({ ...input, requestId: "fabricated", checks: { ...input.checks!, disclosure: { ...input.checks!.disclosure!, quote: "invented source quote" } } })).rejects.toMatchObject({ code: "THESIS_SOURCES_INVALID" });
  const missing = { ...await review(checked), requestId: "missing", checks: { ...input.checks!, disclosure: null } };
  const absent = await service.client.saveThesisReview!(missing), pending = await service.client.readThesis!(ref(absent));
  expect(pending.kind === "review" && pending.result.outcome).toBe("pending_verification");
  await expect(service.client.readThesisSources!({ ...ref(checked.artifact), page: 2 })).rejects.toMatchObject({ code: "THESIS_SOURCES_INVALID" });
  await expect(service.client.collectThesisSources!({ ...await request("stale"), expectedRevision: 0 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(service.client.collectThesisSources!({ ...await request("bad-url"), disclosureUrl: url + "?token=secret" })).rejects.toMatchObject({ code: "THESIS_SOURCES_INVALID" });
  expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1);
});

test("checkpoint failure retries the existing source snapshot after restart without another collection", async () => {
  const input = await request(); failSave = true;
  await expect(service.client.collectThesisSources!(input)).rejects.toMatchObject({ code: "SESSION_STORAGE" });
  const orphan = listArtifacts().find(item => loadArtifactSnapshot(`${item.sessionId}@${item.revision}`)?.privateResearch?.kind === "source-check")!;
  await service.close(); service = createResearchService(options()); const attached = await service.client.collectThesisSources!(input);
  expect(attached.artifact.sha256).toBe(orphan.revision!); expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1);
  await expect(service.client.collectThesisSources!({ ...input, disclosureUrl: null })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
});

test("damaged source cannot be substituted when reopening its review and original report bytes stay fixed", async () => {
  const checked = await service.client.collectThesisSources!(await request()), saved = await service.client.saveThesisReview!(await review(checked));
  const original = (await service.client.readReport!(ref(saved))).html;
  const path = join(root, "artifacts/.revisions", checked.artifact.id, checked.artifact.sha256, "report.json"), damaged = JSON.parse(readFileSync(path, "utf8"));
  damaged.privateResearch.disclosure.pages[0].text = "replaced text"; writeFileSync(path, JSON.stringify(damaged));
  await expect(service.client.readThesis!(ref(saved))).rejects.toBeDefined();
  await expect(service.client.collectThesisSources!(await request())).rejects.toBeDefined();
  expect((await service.client.readReport!(ref(saved))).html).toBe(original); expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1);
});

test("pending source reads block mutations and close aborts and drains both source calls", async () => {
  await service.close(); let started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; });
  let cleaned = 0;
  const held = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    const abort = () => { cleaned++; reject(new Error("cancelled")); }; signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  sourceChecks = { prices: async (_request, options) => { started(); return held(options?.signal); }, disclosure: async (_symbol, _url, options) => held(options?.signal) };
  service = createResearchService(options()); const input = await request(), pending = service.client.collectThesisSources!(input); const outcome = pending.catch(error => error);
  await reached;
  await expect(service.client.collectThesisSources!({ ...input, requestId: "different" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await expect(service.client.renameSession!({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, title: "Blocked", expectedRevision: input.expectedRevision })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await service.close(); expect(cleaned).toBe(2); expect((await outcome).code).toBe("SOURCES_CANCELLED"); expect(modelCalls).toBe(0);
});

test("source selection rejects a late observation, injected evidence and a different fixed version", async () => {
  const checked = await service.client.collectThesisSources!(await request()), input = await review(checked);
  const staleCutoff = new Date(Date.parse(checked.recordedAt) - 60_000).toISOString();
  await expect(service.client.saveThesisReview!({ ...input, requestId: "late-source", cutoff: staleCutoff })).rejects.toMatchObject({ code: "THESIS_SOURCES_INVALID" });
  await expect(service.client.saveThesisReview!({ ...input, requestId: "fake-version", checks: { ...input.checks!, revision: "0".repeat(64) } })).rejects.toBeDefined();
  await expect(service.client.saveThesisReview!({ ...input, requestId: "injected-raw", retainedEvidence: [{ id: "checks-disclosure-quote", mediaType: "text/plain", content: "replacement" }] })).rejects.toBeDefined();
  expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1);
});

test("fixed OHLC comparison binds the supplied price context without refetching either source", async () => {
  const checked = await service.client.collectThesisSources!(await request()), input = await review(checked);
  const content = JSON.stringify(bars), retrievedAt = checked.price.checkedAt;
  const price = { symbol: "600000.SH", sourceUrl: "https://example.com/synthetic-prices", retrievedAt, adjustment: "forward" as const,
    currency: "CNY" as const, volumeUnit: "shares" as const, dataRef: { id: "manual-prices", sha256: createHash("sha256").update(content).digest("hex") },
    rows: bars.map(({ amount: _amount, volume, ...bar }) => ({ ...bar, vol: volume })) };
  const saved = await service.client.saveThesisReview!({ ...input, price, retainedEvidence: [{ id: "manual-prices", mediaType: "application/json", content }] });
  const view = await service.client.readThesis!(ref(saved));
  expect(view.kind === "review" && view.checks?.priceComparison?.outcome).toBe("matching");
  expect(priceCalls).toBe(1); expect(pdfCalls).toBe(1); expect(modelCalls).toBe(0);
});

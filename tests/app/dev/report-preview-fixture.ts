import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkbenchSessionStore, saveArtifact, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";
import { createResearchService } from "../../../src/app/services/research.ts";
import { startWorkbenchServer } from "../../../src/app/workbench/server.ts";
import { renderArtifactTemplate } from "../../../src/artifact/src/template.ts";
import { renderEchartsKline } from "../../../src/artifact/src/renderers.ts";
const home = mkdtempSync(join(tmpdir(), "whyj-report-preview-"));
const desktop = process.argv.includes("--desktop");
const root = desktop ? join(home, "workspace", ".ohquant") : home;
const cwd = desktop ? join(home, "workspace") : root;
mkdirSync(root, { recursive: true });
process.env.OHQUANT_DIR = root; process.env.OHQUANT_SKILLS_DIR = join(root, "skills"); process.env.WHYJ_RESOURCE_LEASE_ROOT = join(root, "leases"); process.env.NO_PROXY = "127.0.0.1,localhost";
let modelRequests = 0;
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { modelRequests++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": synthetic hold\n\n")); } }), { headers: { "Content-Type": "text/event-stream" } }); } });
const settings = structuredClone(DEFAULT_SETTINGS); settings.provider = "custom"; settings.model = "fixture"; settings.thinkingLevel = "off";
settings.providers = { custom: { api: "openai-completions", baseUrl: model.url.origin + "/v1", apiKey: "synthetic-only" } }; saveSettings(settings);
const options = { cwd, overview: { intervalMs: 0, loadPortfolio: () => ({ symbols: [] }), quoteFetcher: async () => [] } };
let service = createResearchService(options); const identity = await service.client.identity();
await service.client.renameSession({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, expectedRevision: (await service.client.session(identity.sessionId)).revision!, title: "报告体验 · 合成研究" });
const second = await service.client.createSession(); await service.close();
const chart = renderEchartsKline([{ header: ["日期", "开", "高", "低", "收", "量"], timeframe: "日K", rows: Array.from({ length: 70 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10), open: 20 + i / 10, high: 21 + i / 10, low: 19 + i / 10, close: 20.5 + i / 10, vol: 100000 + i * 700 })) }]);
const html = renderArtifactTemplate({ title: "固定报告交互体验（合成数据）", sessionId: identity.sessionId, createdAt: "2026-11-15T00:00:00.000Z", generatedAt: "2026-11-15T00:00:00.000Z", messageCount: 2,
  dashboardHtml: '<p>合成行情：用于验证图表、导航与版本，不是投资结论。</p>', bodyHtml: '<h2>研究假设</h2><p>报告保存时的数值应保持不变。</p>', dockHtml: chart, trajectoryHtml: '<h2>合成轨迹</h2><p>保留原始报告，不访问实时数据。</p>' });
const reports = [saveArtifact("synthetic-report", html, { title: "固定报告交互体验（合成数据）" }, null), saveArtifact("empty-report", "", { title: "空文件边界（合成）" }, null)];
const store = createWorkbenchSessionStore(), loaded = store.load(identity.workspaceId, identity.sessionId);
await store.save({ ...loaded.record, snapshot: { ...loaded.record.snapshot, revision: (loaded.record.snapshot.revision ?? 0) + 1,
  output: { ...loaded.record.snapshot.output, artifacts: reports.map(meta => ({ id: meta.sessionId, title: meta.title, version: 1, sha256: meta.revision!, createdAt: meta.createdAt })) } } }, loaded.revision);
service = createResearchService(options); const host = startWorkbenchServer({ service, assetsRoot: resolve("apps/web/dist"), port: 0 }); await host.ready;
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/start") { const snapshot = await service.client.session(identity.sessionId); await service.client.submit({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, requestId: crypto.randomUUID(), expectedRevision: snapshot.revision!, text: "Synthetic held run" }); }
  if (path === "/state") return Response.json({ modelRequests, snapshot: await service.client.session(identity.sessionId) });
  return Response.json({ ok: true });
} });
const receipt = { origin: host.server.url.origin, control: control.url.origin, identity, secondSessionId: second.sessionId, root, ...(desktop ? { desktopHome: home } : {}) };
mkdirSync("output/127", { recursive: true }); writeFileSync(`output/127/${desktop ? "desktop-fixture" : "fixture"}.json`, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
const close = async () => { await host.close(); model.stop(true); control.stop(true); process.exit(0); };
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());

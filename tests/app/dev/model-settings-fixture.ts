import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createResearchService } from "../../../src/app/services/research.ts";
import { startWorkbenchServer } from "../../../src/app/workbench/server.ts";
import { readSettings, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

// An isolated Host and loopback model provider; never uses personal settings or a paid model.
const root = mkdtempSync(join(tmpdir(), "whyj-model-settings-"));
process.env.OHQUANT_DIR = root; process.env.OHQUANT_SKILLS_DIR = join(root, "skills"); process.env.WHYJ_RESOURCE_LEASE_ROOT = join(root, "leases");
let mode = "ready", checks = 0, expectedKeyObserved = false, replacementKeyObserved = false, requestedModel = "", requestPath = "";
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  checks++; const auth = request.headers.get("cf-aig-authorization") ?? request.headers.get("authorization");
  expectedKeyObserved = auth === "Bearer synthetic-model-key"; replacementKeyObserved = auth === "Bearer synthetic-replacement-key";
  requestPath = new URL(request.url).pathname;
  const body = await request.json() as { model?: unknown }; requestedModel = typeof body.model === "string" ? body.model : "";
  if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 4000));
  if (mode === "auth-failed") return new Response("unauthorized", { status: 401 });
  if (mode === "permission-denied") return new Response("forbidden", { status: 403 });
  if (mode === "unavailable") return new Response("unavailable", { status: 503 });
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0,
    model: "local-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
const settings = structuredClone(DEFAULT_SETTINGS);
settings.provider = "custom"; settings.model = "local-model"; settings.thinkingLevel = "off";
settings.providers = { custom: { api: "openai-completions", baseUrl: `${provider.url.origin}/v1` } };
saveSettings(settings);
const service = createResearchService({ overview: { intervalMs: 0, loadPortfolio: () => ({ symbols: [] }), quoteFetcher: async () => [] } });
const host = startWorkbenchServer({ service, assetsRoot: resolve("apps/web/dist"), port: 0 }); await host.ready;
let running: { workspaceId: string; sessionId: string; runId: string } | undefined;
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/mode") { const value = url.searchParams.get("value");
    if (!["ready", "slow", "auth-failed", "permission-denied", "unavailable"].includes(value ?? "")) return new Response("invalid", { status: 400 });
    mode = value!; }
  if (url.pathname === "/conflict") { const current = readSettings(); current.showPortfolioPanel = !current.showPortfolioPanel; saveSettings(current); }
  if (url.pathname === "/start-run") {
    const identity = await service.client.identity(), snapshot = await service.client.session(identity.sessionId);
    const accepted = await service.client.submit({ workspaceId: identity.workspaceId, sessionId: identity.sessionId, text: "Say OK",
      requestId: randomUUID(), expectedRevision: snapshot.revision! });
    running = { workspaceId: identity.workspaceId, sessionId: identity.sessionId, runId: accepted.runId };
  }
  if (url.pathname === "/stop-run" && running) { await service.client.cancel(running); running = undefined; }
  const current = readSettings();
  return Response.json({ provider: current.provider, model: current.model, keyConfigured: !!current.providers?.custom?.apiKey, checks, expectedKeyObserved, replacementKeyObserved, requestedModel,
    providerUrl: provider.url.origin, requestPath, cloudAccountConfigured: !!current.providers?.["cloudflare-ai-gateway"]?.env?.CLOUDFLARE_ACCOUNT_ID,
    cloudGatewayConfigured: !!current.providers?.["cloudflare-ai-gateway"]?.env?.CLOUDFLARE_GATEWAY_ID });
} });
console.log(JSON.stringify({ origin: host.server.url.origin, control: control.url.origin, synthetic: true }));
const close = async () => { await host.close(); control.stop(true); provider.stop(true); process.exit(0); };
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());

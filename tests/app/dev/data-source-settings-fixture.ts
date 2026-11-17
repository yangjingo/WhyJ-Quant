import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createResearchService } from "../../../src/app/services/research.ts";
import { startWorkbenchServer } from "../../../src/app/workbench/server.ts";
import { readSettings, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";
import type { DataReadinessStatus } from "../../../src/types/data-readiness.ts";

// Isolated synthetic Host; no real provider, model, account, or personal settings.
const root = mkdtempSync(join(tmpdir(), "whyj-data-settings-"));
process.env.OHQUANT_DIR = root; process.env.OHQUANT_SKILLS_DIR = join(root, "skills"); process.env.WHYJ_RESOURCE_LEASE_ROOT = join(root, "leases");
saveSettings(structuredClone(DEFAULT_SETTINGS));
let mode: DataReadinessStatus | "slow" = "ready", checks = 0;
const service = createResearchService({ dataDraftOptions: { processEnv: {}, probe: async (settings, request) => {
  checks++; const current = mode;
  if (current === "slow") await new Promise(resolve => setTimeout(resolve, 4000));
  const configured = request.source === "akshare" || !!settings.env.WHYJ_QUANT_TICKFLOW_API_KEY;
  const result: DataReadinessStatus = !configured ? "missing-credential" : current === "slow" ? "ready" : current;
  return { ...request, status: result, detail: "synthetic", action: "synthetic", credentialSource: configured ? "config" : "missing",
    rowCount: result === "ready" ? 2 : 0, asOfDate: result === "ready" ? request.end : null, observedAt: new Date().toISOString(), durationMs: 1,
    capability: request.market === "Fund" ? "unit-nav" : "daily-bars" };
} }, overview: { intervalMs: 0, loadPortfolio: () => ({ symbols: [] }), quoteFetcher: async () => [] } });
const host = startWorkbenchServer({ service, assetsRoot: resolve("apps/web/dist"), port: 0 }); await host.ready;
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/mode") { const value = url.searchParams.get("value");
    if (!["ready", "slow", "empty", "auth-failed", "permission-denied", "timeout", "unavailable", "invalid-input"].includes(value ?? "")) return new Response("invalid", { status: 400 });
    mode = value as typeof mode; }
  if (url.pathname === "/conflict") { const settings = readSettings(); settings.showPortfolioPanel = !settings.showPortfolioPanel; saveSettings(settings); }
  const current = readSettings();
  return Response.json({ source: current.preferences.source, keyConfigured: !!current.env.WHYJ_QUANT_TICKFLOW_API_KEY, checks });
} });
console.log(JSON.stringify({ origin: host.server.url.origin, control: control.url.origin, synthetic: true }));
const close = async () => { await host.close(); control.stop(true); process.exit(0); };
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());

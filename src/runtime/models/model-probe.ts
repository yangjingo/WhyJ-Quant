import { completeSimple } from "../../agent/src/kernel/llm.ts";
import { resolveConfiguredAuth, resolveConfiguredModel } from "../../agent/src/model-config.ts";
import type { OhQuantSettings } from "../../types/config.ts";

export type ModelProbeStatus = "ready" | "missing-credential" | "auth-failed" | "permission-denied"
  | "timeout" | "cancelled" | "invalid-config" | "unsupported" | "empty-response" | "unavailable";
export interface ModelProbeResult { status: ModelProbeStatus; ok: boolean; detail: string }
export interface ModelProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  processEnv?: Record<string, string | undefined>;
  /** Injectable transport for deterministic local tests; production uses the Pi dispatcher. */
  complete?: typeof completeSimple;
}

const details: Record<ModelProbeStatus, string> = {
  ready: "Model response received",
  "missing-credential": "Missing model provider credentials",
  "auth-failed": "Unauthorized: model provider rejected the credentials",
  "permission-denied": "Model provider denied access",
  timeout: "Model check timed out",
  cancelled: "Model check cancelled",
  "invalid-config": "Model configuration is invalid",
  unsupported: "Model protocol is unsupported",
  "empty-response": "Model returned no text",
  unavailable: "Model connection is unavailable",
};

function result(status: ModelProbeStatus): ModelProbeResult {
  return { status, ok: status === "ready", detail: details[status] };
}

function classify(error: unknown): ModelProbeStatus {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode : undefined;
  if (status === 401) return "auth-failed";
  if (status === 402 || status === 403) return "permission-denied";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/\b401\b|unauthori[sz]ed|invalid[ _-]?(?:api[ _-]?)?key|authentication failed/i.test(message)) return "auth-failed";
  if (/\b(?:402|403)\b|permission denied|forbidden/i.test(message)) return "permission-denied";
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(message)) return "timeout";
  if (/unsupported (?:model )?(?:protocol|api)|requires oauth/i.test(message)) return "unsupported";
  return "unavailable";
}

/** Verify an in-memory connection snapshot; never persist it or return provider-controlled text. */
export async function probeModelConnection(settings: OhQuantSettings, options: ModelProbeOptions = {}): Promise<ModelProbeResult> {
  const snapshot = structuredClone(settings);
  const env = { ...(options.processEnv ?? process.env) };
  if (options.signal?.aborted) return result("cancelled");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) return result("invalid-config");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort: (() => void) | undefined;
  try {
    const probe = async (): Promise<ModelProbeResult> => {
      let model: ReturnType<typeof resolveConfiguredModel>;
      try { model = resolveConfiguredModel(snapshot); } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return result(/protocol.*supported|unsupported.*protocol/i.test(message) ? "unsupported" : "invalid-config");
      }
      let auth: Awaited<ReturnType<typeof resolveConfiguredAuth>>;
      try { auth = await resolveConfiguredAuth(snapshot, model, env, signal); }
      catch (error) { return result(signal.aborted ? (options.signal?.aborted ? "cancelled" : "timeout") : classify(error)); }
      if (signal.aborted) return result(options.signal?.aborted ? "cancelled" : "timeout");
      if (!auth) return result("missing-credential");
      const requestModel = auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
      try {
        const response = await (options.complete ?? completeSimple)(requestModel, {
          messages: [{ role: "user", content: "Reply with only OK.", timestamp: Date.now() }],
        }, { ...auth.auth, env: auth.env, maxTokens: Math.min(32, model.maxTokens), maxRetries: 0, timeoutMs, signal });
        if (signal.aborted) return result(options.signal?.aborted ? "cancelled" : "timeout");
        const text = response.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
        if (response.stopReason === "error") return result(classify(response.errorMessage));
        if (response.stopReason === "aborted") return result("unavailable");
        if (!text) return result("empty-response");
        return result("ready");
      } catch (error) { return result(signal.aborted ? (options.signal?.aborted ? "cancelled" : "timeout") : classify(error)); }
    };
    return await Promise.race([probe(), new Promise<ModelProbeResult>(resolve => {
      onAbort = () => resolve(result(options.signal?.aborted ? "cancelled" : "timeout"));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

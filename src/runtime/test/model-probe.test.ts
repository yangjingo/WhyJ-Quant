import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS, type OhQuantSettings } from "../../types/config.ts";
import { probeModelConnection, type ModelProbeOptions, type ModelProbeStatus } from "../models/model-probe.ts";

const secret = "fixture-model-private-key";
function settings(): OhQuantSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), provider: "custom", model: "local-model",
    providers: { custom: { api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", apiKey: secret } } };
}
const response = (text: string, stopReason = "stop", errorMessage?: string) =>
  ({ content: [{ type: "text", text }], stopReason, errorMessage }) as never;

test("checks an immutable unsaved snapshot using bounded Pi options", async () => {
  const draft = settings(); let seenModel = "", seenKey = "";
  const complete: NonNullable<ModelProbeOptions["complete"]> = async (model, context, options) => {
    seenModel = model.id; seenKey = options?.apiKey ?? "";
    expect(context.messages).toHaveLength(1);
    expect(options).toMatchObject({ maxTokens: 32, maxRetries: 0, timeoutMs: 2000 });
    return response("OK");
  };
  const pending = probeModelConnection(draft, { processEnv: {}, timeoutMs: 2000, complete });
  draft.model = "later-edit"; draft.providers!.custom!.apiKey = "later-key";
  const checked = await pending;
  expect(checked).toEqual({ status: "ready", ok: true, detail: "Model response received" });
  expect(seenModel).toBe("local-model"); expect(seenKey).toBe(secret);
  expect(JSON.stringify(checked)).not.toContain(secret);
});

test("uses the real Pi transport against a controlled loopback provider", async () => {
  let calls = 0, authorization = "", requestBody: Record<string, unknown> = {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++; authorization = request.headers.get("authorization") ?? "";
    requestBody = await request.json() as Record<string, unknown>;
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0,
      model: "local-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const draft = settings(); draft.providers!.custom!.baseUrl = `${server.url.origin}/v1`;
    const checked = await probeModelConnection(draft, { processEnv: {}, timeoutMs: 5000 });
    expect(checked.status).toBe("ready"); expect(calls).toBe(1);
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(requestBody.model).toBe("local-model");
    expect(JSON.stringify(checked)).not.toContain(secret);
  } finally { server.stop(true); }
});

test("reports only safe failure categories and does not expose provider content", async () => {
  const cases: [string, ModelProbeStatus][] = [
    [`HTTP 401 Authorization: Bearer ${secret}`, "auth-failed"],
    [`HTTP 403 permission denied ${secret}`, "permission-denied"],
    [`Unsupported model protocol ${secret}`, "unsupported"],
    [`Connection reset ${secret}`, "unavailable"],
  ];
  for (const [message, status] of cases) {
    const checked = await probeModelConnection(settings(), { processEnv: {}, complete: async () => { throw new Error(message); } });
    expect(checked.status).toBe(status); expect(JSON.stringify(checked)).not.toContain(secret);
  }
  const returned = await probeModelConnection(settings(), { processEnv: {}, complete: async () => response(secret, "error", `HTTP 401 ${secret}`) });
  expect(returned.status).toBe("auth-failed"); expect(JSON.stringify(returned)).not.toContain(secret);
  const structured = await probeModelConnection(settings(), { processEnv: {}, complete: async () => { throw { status: 403, body: secret }; } });
  expect(structured.status).toBe("permission-denied"); expect(JSON.stringify(structured)).not.toContain(secret);
  const empty = await probeModelConnection(settings(), { processEnv: {}, complete: async () => response(" ") });
  expect(empty.status).toBe("empty-response");
  const invalid = settings(); invalid.providers!.custom!.baseUrl = "file:///secret";
  expect((await probeModelConnection(invalid, { processEnv: {} })).status).toBe("invalid-config");
  const missing = { ...structuredClone(DEFAULT_SETTINGS), provider: "openai", model: "gpt-4o", providers: {} };
  expect((await probeModelConnection(missing, { processEnv: {} })).status).toBe("missing-credential");
});

test("cancellation and timeout settle even if a provider ignores abort and responds later", async () => {
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const complete: NonNullable<ModelProbeOptions["complete"]> = async () => {
    started(); await new Promise<void>(resolve => { release = resolve; }); return response("OK");
  };
  const controller = new AbortController();
  const checking = probeModelConnection(settings(), { processEnv: {}, timeoutMs: 2000, signal: controller.signal, complete });
  await begun; controller.abort(); expect((await checking).status).toBe("cancelled");
  release(); await Promise.resolve();
  const timeout = await probeModelConnection(settings(), { processEnv: {}, timeoutMs: 10, complete: async () => new Promise(() => {}) });
  expect(timeout.status).toBe("timeout");
  const aborting: NonNullable<ModelProbeOptions["complete"]> = async (_model, _context, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(new Error(`provider error ${secret}`)), { once: true });
  });
  const timed = await probeModelConnection(settings(), { processEnv: {}, timeoutMs: 10, complete: aborting });
  expect(timed.status).toBe("timeout"); expect(JSON.stringify(timed)).not.toContain(secret);
  expect((await probeModelConnection(settings(), { timeoutMs: 0 })).status).toBe("invalid-config");
});

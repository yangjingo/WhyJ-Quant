import { HOST_PROTOCOL_VERSION, HOST_SERVICE_CONTRACT_VERSION } from "../../types/workbench-host.ts";
import { isWorkbenchSnapshot, isMarketSnapshot, type Preferences, type WorkbenchClient, type WorkbenchEvent } from "../../types/workbench.ts";
import { terminalRequestConnection } from "./request-body.ts";

const failure = "研究服务连接已中断，请重新连接核对当前会话。关闭页面不会停止服务中的研究。";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export type HostFetch = (url: URL, init?: RequestInit) => Promise<Response>;

export function createHostClient(options: { baseUrl: string; fetch?: HostFetch; retryMs?: number; connection?: { token: string; instanceId: string; workspaceId: string } }): WorkbenchClient {
  const baseUrl = options.baseUrl, request = options.fetch ?? globalThis.fetch;
  let bootstrap: Promise<string> | undefined, observer: AbortController | undefined;
  const listeners = new Set<(event: WorkbenchEvent) => void>();
  const emit = (event: WorkbenchEvent) => { for (const listener of [...listeners]) { if (!listeners.has(listener)) continue;
    try { listener(structuredClone(event)); } catch { /* A detached observer cannot affect shared work. */ } } };
  const token = () => options.connection ? Promise.resolve(options.connection.token) : bootstrap ??= (async () => {
    try {
      const response = await request(new URL("/api/workbench/bootstrap", baseUrl), { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(failure);
      const value: unknown = await response.json();
      if (!object(value) || value.version !== 1 || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("研究服务启动信息无效，请检查服务版本。");
      if (value.protocolVersion !== HOST_PROTOCOL_VERSION || value.serviceContractVersion !== HOST_SERVICE_CONTRACT_VERSION)
        throw new Error("研究服务版本不兼容，请先停止旧服务。");
      return value.token;
    } catch (error) { bootstrap = undefined; throw error; }
  })();
  const rpc = async <T>(method: string, args: unknown[] = []): Promise<T> => {
    let response: Response;
    const capability = await token();
    try { const body = JSON.stringify({ method, args });
      response = await request(new URL("/api/workbench/rpc", baseUrl), { method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
      ...(options.connection || ["establishThesis", "saveThesisReview", "readThesis", "collectThesisTsp", "readThesisTsp", "collectThesisSources", "readThesisSources"].includes(method) ? { signal: AbortSignal.timeout(method === "collectThesisSources" ? 45_000 : 30_000) } : {}),
      headers: { "Content-Type": "application/json", "x-workbench-token": capability,
        ...(options.connection ? { "x-host-instance-id": options.connection.instanceId } : {}) },
      ...(options.connection ? terminalRequestConnection(body) : {}), body }); }
    catch { throw new Error("请求结果未确认，请重新连接核对会话后再操作；界面不会自动重复提交。"); }
    if (response.status === 401) bootstrap = undefined;
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("研究服务返回了无效响应。"); }
    if (!response.ok || !object(value) || value.ok !== true || !Object.hasOwn(value, "result")) {
      const message = object(value) && object(value.error) && typeof value.error.message === "string" ? value.error.message.slice(0, 500) : failure;
      const error = new Error(message);
      // An older Host can share the protocol version without supporting a newer optional RPC.
      // Preserve only this fixed code so callers can distinguish it from connection failures.
      if (response.status === 404 && object(value) && object(value.error) && value.error.code === "METHOD_NOT_FOUND")
        Object.assign(error, { code: "METHOD_NOT_FOUND" });
      // These specific job rejections are decided before a start is accepted, or identify a missing job.
      // Other errors remain ambiguous: the Host may have accepted a request before the connection failed.
      if (object(value) && value.ok === false && object(value.error) && typeof value.error.message === "string") {
        const code = value.error.code;
        if ((method === "startObservationJob" && ((response.status === 400 && code === "INPUT_INVALID") || (response.status === 409 && code === "OBSERVATION_BUSY")))
          || ((method === "readObservationJob" || method === "cancelObservationJob") && response.status === 404 && code === "OBSERVATION_JOB_NOT_FOUND"))
          Object.assign(error, { code });
      }
      throw error;
    }
    return value.result as T;
  };
  const pause = (signal: AbortSignal) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, options.retryMs ?? 1500); signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
  const observe = async (signal: AbortSignal) => {
    let connected = false;
    while (!signal.aborted) {
      let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
      try {
        const response = await request(new URL("/api/workbench/events", baseUrl), { credentials: "omit", cache: "no-store", signal, redirect: "error",
          headers: { "x-workbench-token": await token(), ...(options.connection ? { "x-host-instance-id": options.connection.instanceId } : {}) } });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error(failure);
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(failure);
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw new Error("研究会话快照过大，请重新连接。");
          const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? "";
          for (const frame of frames) {
            if (signal.aborted) break;
            const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event: unknown = JSON.parse(data);
            if (options.connection && (!object(event) || event.instanceId !== options.connection.instanceId
              || (event.type === "ready" ? event.workspaceId : object(event.identity) && event.identity.workspaceId) !== options.connection.workspaceId)) {
              throw new Error("Host identity changed; reconnect explicitly.");
            }
            if (object(event) && event.type === "ready" && typeof event.workspaceId === "string" && event.workspaceId.length > 0) {
              if (!connected) { connected = true; emit({ type: "connection", connected: true }); }
              continue;
            }
            if (object(event) && event.type === "session-error" && object(event.identity) && typeof event.identity.workspaceId === "string"
              && typeof event.identity.sessionId === "string" && (event.identity.runId === null || typeof event.identity.runId === "string")
              && typeof event.message === "string" && event.message.length <= 500) {
              emit({ type: "session-error", identity: { workspaceId: event.identity.workspaceId, sessionId: event.identity.sessionId, runId: event.identity.runId }, message: event.message });
              continue;
            }
            if (object(event) && event.type === "market" && isMarketSnapshot(event.snapshot) && object(event.identity)
              && typeof event.identity.workspaceId === "string" && typeof event.identity.sessionId === "string" && event.identity.runId === null) {
              emit({ type: "market", identity: { workspaceId: event.identity.workspaceId, sessionId: event.identity.sessionId, runId: null }, snapshot: event.snapshot }); continue;
            }
            if (!object(event) || event.type !== "snapshot" || !isWorkbenchSnapshot(event.snapshot) || !object(event.identity)
              || event.identity.workspaceId !== event.snapshot.identity.workspaceId || event.identity.sessionId !== event.snapshot.identity.sessionId || event.identity.runId !== event.snapshot.identity.runId) throw new Error("研究服务事件无效，请重新连接。");
            if (!connected) { connected = true; emit({ type: "connection", connected: true }); }
            emit({ type: "snapshot", identity: event.snapshot.identity, snapshot: event.snapshot });
          }
        }
      } catch {
        if (signal.aborted) break;
        bootstrap = undefined;
        if (connected) { connected = false; emit({ type: "connection", connected: false, error: failure }); }
        else emit({ type: "connection", connected: false, error: failure });
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      if (!signal.aborted) await pause(signal);
    }
  };
  return {
    mode: "host",
    startObservationJob: input => rpc("startObservationJob", [input]),
    readObservationJob: id => rpc("readObservationJob", [id]),
    cancelObservationJob: id => rpc("cancelObservationJob", [id]),
    identity: () => rpc("identity"), workspaces: () => rpc("workspaces"), preferences: () => rpc("preferences"),
    market: async () => { const value = await rpc("market"); if (!isMarketSnapshot(value)) throw new Error("行情响应无效。"); return value; },
    refreshMarket: async failedOnly => { const value = await rpc("refreshMarket", [failedOnly]); if (!isMarketSnapshot(value)) throw new Error("行情响应无效。"); return value; },
    session: async id => { const value: unknown = await rpc("session", [id]);
      if (!isWorkbenchSnapshot(value) || value.identity.sessionId !== id
        || options.connection && value.identity.workspaceId !== options.connection.workspaceId) throw new Error("研究服务会话无效。"); return value; },
    transcript: id => rpc("transcript", [id]), output: id => rpc("output", [id]), createSession: () => rpc("createSession"),
    renameSession: value => rpc("renameSession", [value]), references: (id, query) => rpc("references", [id, query]),
    updatePreferences: (next: Preferences) => rpc("updatePreferences", [{ revision: next.revision, model: next.model, source: next.source, portfolio: next.portfolio, ...(next.researchSource === undefined ? {} : { researchSource: next.researchSource }), ...(next.thinkingLevel === undefined ? {} : { thinkingLevel: next.thinkingLevel }) }]),
    startDataDraft: () => rpc("startDataDraft"), editDataDraft: input => rpc("editDataDraft", [input]),
    verifyDataDraft: id => rpc("verifyDataDraft", [id]), cancelDataDraft: id => rpc("cancelDataDraft", [id]),
    saveDataDraft: input => rpc("saveDataDraft", [input]), closeDataDraft: id => rpc("closeDataDraft", [id]),
    startModelDraft: () => rpc("startModelDraft"), editModelDraft: input => rpc("editModelDraft", [input]),
    verifyModelDraft: id => rpc("verifyModelDraft", [id]), cancelModelDraft: id => rpc("cancelModelDraft", [id]),
    saveModelDraft: input => rpc("saveModelDraft", [input]), closeModelDraft: id => rpc("closeModelDraft", [id]),
    removeModelCredential: input => rpc("removeModelCredential", [input]),
    removeDataCredential: input => rpc("removeDataCredential", [input]),
    submit: value => rpc("submit", [value]), cancel: id => rpc("cancel", [id]),
    continue: value => rpc("continue", [value]), followup: value => rpc("followup", [value]),
    save: value => rpc("save", [value]), reload: value => rpc("reload", [value]),
    establishThesis: value => rpc("establishThesis", [value]), saveThesisReview: value => rpc("saveThesisReview", [value]), readThesis: value => rpc("readThesis", [value]),
    collectThesisSources: value => rpc("collectThesisSources", [value]), readThesisSources: value => rpc("readThesisSources", [value]),
    collectThesisTsp: value => rpc("collectThesisTsp", [value]), readThesisTsp: value => rpc("readThesisTsp", [value]),
    readReport: async input => {
      const snapshot = await rpc("session", [input.sessionId]);
      if (!isWorkbenchSnapshot(snapshot) || snapshot.identity.workspaceId !== input.workspaceId || snapshot.identity.sessionId !== input.sessionId)
        throw new Error("报告所属会话无法验证。");
      const artifact = snapshot.output.artifacts.find(item => item.id === input.artifactId && item.sha256 === input.sha256);
      if (!artifact) throw new Error("当前会话中没有这个固定报告版本。");
      const response = await request(new URL("/api/workbench/report", baseUrl), { method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json", "x-workbench-token": await token(),
          ...(options.connection ? { "x-host-instance-id": options.connection.instanceId } : {}) }, body: JSON.stringify(input) });
      if (response.status === 401) bootstrap = undefined;
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => null);
        throw new Error(object(value) && object(value.error) && typeof value.error.message === "string" ? value.error.message.slice(0, 500) : "原始报告暂时无法读取。");
      }
      const hash = response.headers.get("x-report-content-sha256"), length = Number(response.headers.get("content-length"));
      if (!response.headers.get("content-type")?.startsWith("text/html") || response.headers.get("x-report-revision") !== input.sha256
        || !hash || !/^[a-f0-9]{64}$/.test(hash) || !response.headers.has("content-length") || !Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024 || !response.body) {
        await response.body?.cancel(); throw new Error("原始报告响应标识或大小无效。");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > length || bytes > 8 * 1024 * 1024) throw new Error("报告响应超出声明的大小。");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (bytes !== length) throw new Error("原始报告传输不完整。");
      const content = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
      const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== hash) throw new Error("原始报告内容校验失败，未打开或下载。");
      const html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
      return { artifact, html, htmlSha256: actual, bytes };
    },
    review: value => rpc("review", [value]),
    deleteSession: value => rpc("deleteSession", [value]),
    acknowledgeInterruption: id => rpc("acknowledgeInterruption", [id]),
    subscribe(listener) {
      listeners.add(listener);
      if (!observer) { observer = new AbortController(); void observe(observer.signal); }
      return () => { listeners.delete(listener); if (!listeners.size) { observer?.abort(); observer = undefined; } };
    },
  };
}

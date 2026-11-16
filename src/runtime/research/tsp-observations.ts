import { createHash } from "node:crypto";
import { getAgentDir, loadMcpConfig, loadPiMcpRuntime } from "../../agent/src/pi-mcp.ts";
import { normalizeSymbol } from "../../market/symbols.ts";
import type { TspObservation, TspObservationTool, TspObservations } from "../../types/thesis-tsp.ts";

const unavailable = () => new Error("TSP 只读连接不可用。请检查 Pi 用户配置中的 tsp、服务地址、只读授权和本地启动环境后重试；原记录未改变。");
const resolveValue = (value: string | undefined): string => {
  if (typeof value !== "string" || value.startsWith("!") || value.length > 8192) throw unavailable();
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const item = process.env[key]; if (item === undefined) throw unavailable(); return item;
  });
  if (!resolved || resolved.includes("${")) throw unavailable();
  return resolved;
};

/** One explicit read, using Pi's global config and existing MCP transport. No model, save or polling. */
export async function collectTspObservations(symbol: string, options: { cwd: string; agentDir?: string; signal?: AbortSignal } ): Promise<TspObservations> {
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol) || normalizeSymbol(symbol, "A") !== symbol) throw new Error("请选择有效的 A 股代码。");
  options.signal?.throwIfAborted();
  const loaded = loadMcpConfig({ agentDir: options.agentDir ?? getAgentDir(), cwd: options.cwd, projectTrusted: false });
  const found = loaded.servers.find(entry => entry.name === "tsp");
  if (loaded.errors.length || !found || found.config.enabled === false || !("command" in found.config)) throw unavailable();
  // The upstream TSP bridge is stdio. Do not interpret a panel HTTP URL as an MCP endpoint.
  const config = structuredClone(found.config), token = resolveValue(config.env?.TSP_TOKEN);
  let base: URL;
  try { base = new URL(resolveValue(config.env?.TSP_BASE)); } catch { throw unavailable(); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.href.includes(token)) throw unavailable();
  const scopes = resolveValue(config.env?.TSP_SCOPES).split(",").map(item => item.trim());
  if (scopes.length !== 2 || !scopes.includes("read:market") || !scopes.includes("read:analysis")) throw unavailable();
  // Freeze resolved source credentials for this operation; Pi still owns spawning and JSON-RPC.
  config.env = { ...config.env, TSP_BASE: base.href.replace(/\/$/, ""), TSP_TOKEN: token, TSP_SCOPES: "read:market,read:analysis" };
  config.timeout = 20;
  const { McpServerConnection, createDefaultTransport, McpOAuthCredentialStore } = await loadPiMcpRuntime().catch(() => { throw unavailable(); });
  const connection = new McpServerConnection({ entry: { ...found, config }, cwd: options.cwd,
    createTransport: createDefaultTransport, credentials: new McpOAuthCredentialStore(), onTools() {} });
  const controller = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= connection.close();
  const cancel = () => { controller.abort(); void close().catch(() => {}); };
  const timer = setTimeout(cancel, 25_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    await connection.getClient(); controller.signal.throwIfAborted();
    const observations: TspObservation[] = [];
    const calls: [TspObservationTool, Record<string, string | number>, string][] = [
      ["get_recent_alerts", { limit: 20 }, "api/alerts"], ["get_kline", { symbol, limit: 100 }, "api/kline/daily"],
    ];
    for (const [tool, parameters, path] of calls) {
      controller.signal.throwIfAborted();
      const sourceUrl = new URL(path, config.env.TSP_BASE + "/").href;
      let content: string | null = null, reason: string | null = null;
      try {
        if (!connection.tools.some(item => item.name === tool)) throw unavailable();
        const result = await connection.callTool(tool, parameters, { signal: controller.signal, timeoutMs: 20_000 });
        if (result.isError || !Array.isArray(result.content) || !result.content.length || result.content.some(item => item.type !== "text")) throw unavailable();
        const texts = result.content.map(item => item.type === "text" ? item.text : "");
        const raw = texts.join("\n");
        // Enriched daily responses include indicator fields; retain exact bytes within the archive's per-item bound.
        if (!raw.trim() || Buffer.byteLength(raw) > 512 * 1024 || raw.includes(token)) throw unavailable();
        // TSP reports connection/HTTP errors as plain text without isError; only JSON is an observation.
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || JSON.stringify(parsed).includes(token)) throw unavailable();
        content = raw;
      } catch { controller.signal.throwIfAborted(); reason = "工具未返回可用的有界 JSON 观察；请检查连接、权限和数据可用性。"; }
      observations.push({ tool, parameters, sourceUrl, retrievedAt: new Date().toISOString(), content,
        status: content === null ? "unavailable" : "available", sha256: content === null ? null : createHash("sha256").update(content).digest("hex"), reason });
    }
    return { version: 1, server: "tsp", symbol, configuredScopes: ["read:market", "read:analysis"], observations };
  } catch { if (options.signal?.aborted) options.signal.throwIfAborted(); throw unavailable(); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); await close().catch(() => { throw unavailable(); }); }
}

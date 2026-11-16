import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const log = process.env.TSP_FIXTURE_LOG!, mode = process.env.TSP_FIXTURE_MODE ?? "normal";
appendFileSync(log, JSON.stringify({ type: "start", pid: process.pid }) + "\n");
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const tools = ["get_recent_alerts", "get_kline", "write_ext_rows", "run_backtest"];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize") reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-tsp", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: (mode === "missing" ? tools.slice(1) : tools).map(name => ({ name, description: "Synthetic read boundary fixture", inputSchema: { type: "object", properties: {} } })) });
  else if (request.method === "tools/call") {
    appendFileSync(log, JSON.stringify({ type: "call", name: request.params.name, arguments: request.params.arguments }) + "\n");
    if (mode === "hold") continue;
    if (mode === "at-limit" || mode === "over-limit") {
      const bytes = 512 * 1024 + (mode === "over-limit" ? 1 : 0);
      const text = JSON.stringify({ details: "界".repeat(174000) });
      reply(request.id, { content: [{ type: "text", text: text + " ".repeat(bytes - Buffer.byteLength(text)) }] }); continue;
    }
    if (mode === "selection" || mode === "malformed") {
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const data = request.params.name === "get_recent_alerts"
        ? { alerts: [{ ts: Date.now(), symbol: "600000.SH", price: 11, message: "Synthetic source price move <safe>" },
            { ts: Date.now(), symbol: "", message: "Do not bind a batch alert" }, { ts: Date.now(), symbol: "000001.SZ", message: "Other stock" }], total: 3 }
        : { symbol: request.params.arguments.symbol, asset_type: "stock", source: "live", rows: [
            { date: "2026-11-12", open: 9, high: 11, low: 8, close: 10, volume: 90 },
            { date: "2026-11-13", open: 10, high: mode === "malformed" ? -12 : 12, low: 9, close: 11, volume: 100 },
            { date: today, open: 11, high: 13, low: 10, close: 12, volume: 50 },
          ] };
      reply(request.id, { content: [{ type: "text", text: JSON.stringify(data) }] }); continue;
    }
    const text = mode === "error" ? "HTTP 403: synthetic denied" : mode === "secret" ? JSON.stringify({ accidental: process.env.TSP_TOKEN })
      : request.params.name === "get_recent_alerts" ? JSON.stringify({ alerts: [{ ts: 1794700800000, rule_id: "synthetic-rule", symbol: "600000.SH", source: "price", type: "price", message: "Synthetic price move" }], total: 1, ...(mode === "large" ? { originalDetails: "synthetic-raw-".repeat(13000) } : {}) })
      : JSON.stringify({ symbol: request.params.arguments.symbol, asset_type: "stock", source: "enriched", rows: [{ date: "2026-11-12", open: 9, high: 11, low: 8, close: 10, volume: 90 }, { date: "2026-11-13", open: 10, high: 12, low: 9, close: 11, volume: 100 }] });
    reply(request.id, { content: [{ type: "text", text }] });
  } else if (request.method === "ping") reply(request.id, {});
  else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } }) + "\n");
}

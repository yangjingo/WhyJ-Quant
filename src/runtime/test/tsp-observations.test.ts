import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { collectTspObservations } from "../research/tsp-observations.ts";

let root: string, log: string;
const token = "fixture-tsp-private-key";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "whyj-tsp-")); log = join(root, "calls.jsonl"); });
afterEach(() => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected temporary root");
  rmSync(root, { recursive: true, force: true });
});
function configure(mode = "normal", extra: Record<string, unknown> = {}) {
  const config = { command: process.execPath, args: [resolve(import.meta.dirname, "fixtures/tsp-mcp-server.ts")],
    env: { TSP_BASE: "http://127.0.0.1:3018", TSP_TOKEN: token, TSP_SCOPES: "read:market,read:analysis", TSP_FIXTURE_LOG: log, TSP_FIXTURE_MODE: mode }, ...extra };
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { tsp: config } }));
}
const collect = (signal?: AbortSignal) => collectTspObservations("600000.SH", { cwd: root, agentDir: root, signal });
const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
function assertClosed() {
  const pid = events().find(item => item.type === "start")?.pid; expect(pid).toBeDefined();
  let live = true; try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false; else throw error; }
  expect(live).toBe(false);
}

test("Pi stdio connection calls only the two allowed tools and preserves original JSON with hashes", async () => {
  configure(); const result = await collect();
  expect(result.configuredScopes).toEqual(["read:market", "read:analysis"]);
  expect(events().filter(item => item.type === "call").map(item => item.name)).toEqual(["get_recent_alerts", "get_kline"]);
  expect(events().filter(item => item.type === "call")[1].arguments).toEqual({ symbol: "600000.SH", limit: 100 });
  for (const item of result.observations) {
    expect(item.status).toBe("available"); expect(item.sha256).toBe(createHash("sha256").update(item.content!).digest("hex"));
    expect(item.retrievedAt).toMatch(/^\d{4}-/);
  }
  expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(root); assertClosed();
});

test("bounded enriched responses preserve exact bytes while oversized UTF-8 responses stay unavailable", async () => {
  for (const mode of ["large", "at-limit", "over-limit"]) {
    configure(mode); const result = await collect();
    const item = result.observations[0]!;
    if (mode === "over-limit") {
      expect(item.status).toBe("unavailable"); expect(item.content).toBeNull(); expect(item.sha256).toBeNull();
    } else {
      expect(item.status).toBe("available"); expect(Buffer.byteLength(item.content!)).toBeGreaterThan(128 * 1024);
      if (mode === "at-limit") expect(Buffer.byteLength(item.content!)).toBe(512 * 1024);
      expect(item.sha256).toBe(createHash("sha256").update(item.content!).digest("hex"));
    }
    const pid = events().filter(item => item.type === "start").at(-1).pid;
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

test("missing tools, TSP plain-text failures and credential echoes stay unavailable", async () => {
  for (const mode of ["missing", "error", "secret"]) {
    configure(mode); const result = await collect();
    expect(result.observations[0]!.status).toBe("unavailable");
    if (mode !== "missing") expect(result.observations[1]!.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(token);
    // Every operation closes its process; inspect the latest launch for repeated collection.
    const pid = events().filter(item => item.type === "start").at(-1).pid;
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

test("missing, disabled and write-scoped config cannot start a server", async () => {
  await expect(collect()).rejects.toThrow("TSP 只读连接不可用");
  configure("normal", { enabled: false }); await expect(collect()).rejects.toThrow("TSP 只读连接不可用");
  configure("normal", { env: { TSP_BASE: "http://127.0.0.1:3018", TSP_TOKEN: token, TSP_SCOPES: "read:market,read:analysis,write:ext" } });
  await expect(collect()).rejects.toThrow("TSP 只读连接不可用"); expect(events()).toEqual([]);
});

test("cancelling a held call closes Pi's child and does not fetch another tool", async () => {
  configure("hold"); const controller = new AbortController(), promise = collect(controller.signal);
  for (let i = 0; i < 100 && !events().some(item => item.type === "call"); i++) await Bun.sleep(20);
  controller.abort(); await expect(promise).rejects.toThrow();
  expect(events().filter(item => item.type === "call").map(item => item.name)).toEqual(["get_recent_alerts"]); assertClosed();
});

test("invalid endpoints and startup failures expose no configuration paths or credentials", async () => {
  for (const extra of [
    { command: join(root, "nonexistent-python") },
    { env: { TSP_BASE: "invalid private endpoint " + token, TSP_TOKEN: token, TSP_SCOPES: "read:market,read:analysis" } },
    { env: { TSP_BASE: "http://user:secret@127.0.0.1:3018", TSP_TOKEN: token, TSP_SCOPES: "read:market,read:analysis" } },
  ]) {
    configure("normal", extra);
    try { await collect(); throw new Error("Unexpected success"); }
    catch (error) {
      expect(String(error)).toContain("TSP 只读连接不可用"); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain(root);
    }
  }
});

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createDemoClient } from "../dev/demo-client";
import { createHostClient } from "../src/client/host";

async function fixture(change: (response: { body: string; headers: Record<string, string> }) => void = () => {}) {
  const demo = createDemoClient(), identity = await demo.identity(), snapshot = { ...await demo.session(identity.sessionId), revision: 0 };
  const artifact = snapshot.output.artifacts[0]!;
  const input = { workspaceId: identity.workspaceId, sessionId: identity.sessionId, artifactId: artifact.id, sha256: artifact.sha256 };
  const html = '\ufeff<!doctype html><title>原始 HTML</title>\r\n<p>固定版本</p>', calls: string[] = [];
  const client = createHostClient({ baseUrl: "http://fixture.test", fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path.endsWith("bootstrap")) return Response.json({ version: 1, protocolVersion: 1, serviceContractVersion: 4, token: "a".repeat(64) });
    if (path.endsWith("rpc")) { expect(JSON.parse(String(init?.body))).toEqual({ method: "session", args: [identity.sessionId] }); return Response.json({ ok: true, result: snapshot }); }
    expect(init?.redirect).toBe("error"); expect(new Headers(init?.headers).get("x-workbench-token")).toBe("a".repeat(64));
    expect(JSON.parse(String(init?.body))).toEqual(input);
    const response = { body: html, headers: { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(html)),
      "x-report-content-sha256": createHash("sha256").update(html).digest("hex"), "x-report-revision": artifact.sha256 } };
    change(response); return new Response(response.body, { headers: response.headers });
  }) as typeof fetch });
  return { client, input, html, calls };
}
test("original report client verifies original UTF-8 bytes including BOM without model mutation", async () => {
  const { client, input, html, calls } = await fixture(); const result = await client.readReport!(input);
  expect(result.html).toBe(html); expect(Buffer.from(result.html)).toEqual(Buffer.from(html));
  expect(result.htmlSha256).toBe(createHash("sha256").update(html).digest("hex"));
  expect(calls.filter(path => path.endsWith("report"))).toHaveLength(1);
});
for (const [name, change] of [
  ["wrong revision", (value: any) => { value.headers["x-report-revision"] = "f".repeat(64); }],
  ["wrong digest", (value: any) => { value.headers["x-report-content-sha256"] = "f".repeat(64); }],
  ["truncated bytes", (value: any) => { value.body = "short"; }],
  ["too many bytes", (value: any) => { value.headers["content-length"] = "1"; }],
  ["over limit", (value: any) => { value.headers["content-length"] = String(9 * 1024 * 1024); }],
] as const) test(`original report client rejects ${name} before preview or download`, async () => {
  const { client, input, calls } = await fixture(change); await expect(client.readReport!(input)).rejects.toThrow();
  expect(calls.filter(path => path.endsWith("report"))).toHaveLength(1);
});

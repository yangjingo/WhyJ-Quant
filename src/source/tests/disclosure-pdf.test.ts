import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readDisclosurePdf } from "../src/disclosure-pdf.ts";
import { extractDisclosurePdf } from "../src/disclosure-pdf-worker.ts";
import { disclosurePdf } from "./fixtures/disclosure-pdf.ts";

const url = "https://static.cninfo.com.cn/finalpage/2020-01-04/synthetic.PDF";
const bytes = disclosurePdf("证券代码：600000 合成测试公告 毛利率22% 不代表真实财务信息");
const source = (): Response => new Response(bytes, { headers: { "content-type": "application/pdf" } });
const fakeFetch = (handler: (input: string, init?: RequestInit) => Response | Promise<Response>) =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

it("extracts a real Chinese PDF, binds original bytes and page text, and only claims a code hint", async () => {
  let calls = 0;
  const doc = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch((input, init) => {
    calls++; expect(input).toBe(url); expect(init).toMatchObject({ credentials: "omit", redirect: "manual" }); return source();
  }) });
  expect(calls).toBe(1); expect(doc.status).toBe("available"); expect(doc.symbolMention).toBe("header-match");
  expect(doc.pages[0]?.text).toContain("毛利率22%"); expect(doc.totalPages).toBe(1);
  expect(doc.originalSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(doc.textSha256).toBe(createHash("sha256").update(JSON.stringify(doc.pages)).digest("hex"));
  expect(doc.reason).toContain("不等于财务事实认证");
  const foreign = await readDisclosurePdf("000001.SZ", url, { fetch: fakeFetch(() => source()) });
  expect(foreign.symbolMention).toBe("unverified");
});

it("does not turn a holding-table mention into issuer identity", async () => {
  const doc = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(() => new Response(disclosurePdf("证券代码 证券名称 市值 600000 浦发银行 100 合成持仓表"),
    { headers: { "content-type": "application/pdf" } })) });
  expect(doc.status).toBe("available"); expect(doc.symbolMention).toBe("unverified");
});

it("marks retained text as truncated instead of claiming a complete disclosure", async () => {
  const long = disclosurePdf("证券代码：600000 " + "合成正文".repeat(55_000));
  const doc = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(() => new Response(long, { headers: { "content-type": "application/pdf" } })) });
  expect(doc.status).toBe("truncated"); expect(doc.pages.reduce((sum, page) => sum + page.text.length, 0)).toBe(200_000);
  expect(doc.totalPages).toBe(367); expect(doc.symbolMention).toBe("header-match");
}, 10_000);

it("rejects unsupported/authenticated addresses without a network call and validates redirects", async () => {
  let calls = 0; const fetch = fakeFetch(() => { calls++; return source(); });
  for (const target of ["http://static.cninfo.com.cn/a.pdf", "https://localhost/a.pdf", url + "?token=private", "https://user:password@static.cninfo.com.cn/a.pdf", url.replace(".PDF", ".html")]) {
    const result = await readDisclosurePdf("600000.SH", target, { fetch });
    expect(result.status).toBe("unsupported"); expect(result.requestedUrl).toBe("");
  }
  expect(calls).toBe(0);
  const denied = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(() => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.pdf" } }); }) });
  expect(denied.status).toBe("restricted"); expect(calls).toBe(1);
  const final = url.replace("synthetic.PDF", "redirect.PDF");
  const accepted = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(input => input === url ? new Response(null, { status: 302, headers: { location: final } }) : source()) });
  expect(accepted.finalUrl).toBe(final); expect(accepted.originalSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("bounds streamed bytes and propagates caller cancellation while reading the response", async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  const result = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(() => new Response(oversized, { headers: { "content-type": "application/pdf" } })) });
  expect(result.status).toBe("unavailable"); expect(cancelled).toBe(true);
  const controller = new AbortController(); let streamCancelled = false;
  const pending = new ReadableStream<Uint8Array>({ start() { setTimeout(() => controller.abort(), 5); }, cancel() { streamCancelled = true; } });
  await expect(readDisclosurePdf("600000.SH", url, { signal: controller.signal, fetch: fakeFetch(() => new Response(pending, { headers: { "content-type": "application/pdf" } })) })).rejects.toThrow();
  expect(streamCancelled).toBe(true);
});

it("keeps inaccessible, oversize, malformed and textless PDFs unavailable or empty", async () => {
  for (const response of [new Response(null, { status: 403 }), new Response("login", { headers: { "content-type": "text/html" } }),
    new Response(bytes, { headers: { "content-type": "application/pdf", "content-length": String(9 * 1024 * 1024) } }),
    new Response("%PDF-broken", { headers: { "content-type": "application/pdf" } })]) {
    const doc = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(() => response) });
    expect(["restricted", "unavailable"]).toContain(doc.status); expect(doc.pages).toEqual([]);
  }
  const empty = await readDisclosurePdf("600000.SH", url, { fetch: fakeFetch(() => new Response(disclosurePdf(""), { headers: { "content-type": "application/pdf" } })) });
  expect(empty.status).toBe("empty"); expect(empty.symbolMention).toBe("unverified");
});

it("cancels active PDF work and terminates a timed-out worker before returning", async () => {
  const controller = new AbortController();
  const active = extractDisclosurePdf(bytes, { signal: controller.signal }); controller.abort();
  await expect(active).rejects.toThrow();
  await expect(extractDisclosurePdf(bytes, { timeoutMs: 1 })).rejects.toThrow("timed out");
  // A subsequent parse still runs; cancelled workers do not own or detach the caller's bytes.
  expect((await extractDisclosurePdf(bytes)).pages[0]?.text).toContain("证券代码");
});

it("bundles the actual reader and worker without runtime node_modules or worker files", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-disclosure-bundle-"));
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/disclosure-compiled.ts")], outdir: root, target: "bun" });
    expect(built.success).toBe(true); expect(built.outputs).toHaveLength(1);
    const input = join(root, "synthetic.pdf"); writeFileSync(input, bytes);
    const child = Bun.spawn([process.execPath, join(root, "disclosure-compiled.js"), input], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe(""); expect(code).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ status: "available", symbolMention: "header-match" });
    } finally { child.kill(); await child.exited; }
  } finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected bundle fixture root");
    rmSync(root, { recursive: true, force: true });
  }
});

import { createHash } from "node:crypto";
import { normalizeSymbol } from "../../market/symbols.ts";
import type { DisclosureDocument } from "../../types/disclosure.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const hosts = new Set(["static.cninfo.com.cn", "disc.static.szse.cn", "static.sse.com.cn"]);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function disclosureUrl(value: string): URL | null {
  try {
    if (value.length > 2048) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.username || url.password || url.search || !/\.pdf$/i.test(url.pathname)) return null;
    url.hash = ""; return url;
  } catch { return null; }
}

/** Explicit public PDF URL only. No authentication, web crawling, model, OCR or source-fact certification. */
export async function readDisclosurePdf(symbol: string, requestedUrl: string, options: {
  signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch;
} = {}): Promise<DisclosureDocument> {
  options.signal?.throwIfAborted();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol) || normalizeSymbol(symbol, "A") !== symbol) throw new Error("Invalid disclosure stock code");
  const initialUrl = disclosureUrl(requestedUrl);
  const result: DisclosureDocument = { symbol, requestedUrl: initialUrl?.href ?? "", finalUrl: null, fetchedAt: new Date().toISOString(), status: "unsupported",
    method: "unpdf-1.9.1-page-text", originalSha256: null, originalBytes: 0, textSha256: null, totalPages: 0, pages: [], symbolMention: "unverified",
    reason: "需要巨潮或沪深交易所静态公告域名的 HTTPS PDF 直链；未读取列表页、任意网站或带认证参数的地址。" };
  if (!initialUrl) return result;
  let url: URL = initialUrl;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(25_000, options.timeoutMs ?? 25_000));
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const response = await (options.fetch ?? fetch)(url.href, { signal, redirect: "manual", credentials: "omit", headers: { accept: "application/pdf" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        const next = location ? disclosureUrl(new URL(location, url).href) : null;
        if (!next) return { ...result, status: "restricted", reason: "公告重定向离开支持的公开 PDF 地址，未继续请求。" };
        url = next; continue;
      }
      if (!response.ok) {
        await response.body?.cancel(); return { ...result, status: [401, 403].includes(response.status) ? "restricted" : "unavailable", reason: `公告请求返回 HTTP ${response.status}。` };
      }
      if (!response.body || !/application\/(pdf|octet-stream)/i.test(response.headers.get("content-type") ?? "") || Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body?.cancel(); return { ...result, status: "unavailable", reason: "公告不是支持的 PDF 响应或超过 8 MiB。" };
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > MAX_BYTES) throw new Error("Disclosure exceeds limit"); chunks.push(chunk.value);
        }
      } finally { signal.removeEventListener("abort", cancel); await reader.cancel(); reader.releaseLock(); }
      signal.throwIfAborted();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const { extractDisclosurePdf } = await import("./disclosure-pdf-worker.ts");
      const originalSha256 = digest(bytes), extracted = await extractDisclosurePdf(bytes, { signal });
      signal.throwIfAborted();
      const text = extracted.pages.map(page => page.text).join("\n");
      // A labeled first-page mention is only an issuer cue; a portfolio holding table is not issuer identity.
      const header = (extracted.pages[0]?.text ?? "").slice(0, 2000).replace(/\s+/g, "");
      const symbolMention = new RegExp(`(?:证券代码|股票代码|Securitiescode|Stockcode)[:：]${symbol.slice(0, 6)}(?![0-9])`, "i").test(header) ? "header-match" : "unverified";
      return { ...result, finalUrl: url.href, fetchedAt: new Date().toISOString(), originalSha256, originalBytes: size,
        textSha256: digest(JSON.stringify(extracted.pages)), totalPages: extracted.totalPages, pages: extracted.pages, symbolMention,
        status: !text.trim() ? "empty" : extracted.truncated ? "truncated" : "available",
        reason: "保存按页提取的文本快照与原文件摘要，不保存原 PDF。表格排版可能丢失；代码匹配只是页首线索，仍须核对发行人、披露日期、指标口径及所引原文。扫描件不自动 OCR，提取成功不等于财务事实认证。" };
    }
    return { ...result, status: "unavailable", reason: "公告超过重定向次数上限。" };
  } catch {
    options.signal?.throwIfAborted();
    return { ...result, status: "unavailable", reason: "公告无法在大小、页数或时间限制内取得可读文本；可核对原链接后重试。" };
  } finally { clearTimeout(timer); }
}

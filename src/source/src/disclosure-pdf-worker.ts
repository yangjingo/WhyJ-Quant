// @ts-expect-error Bun's text loader exports a string; upstream declarations describe executable JavaScript.
import pdfjsText from "unpdf/pdfjs" with { type: "text" };
import { Worker } from "node:worker_threads";

export interface DisclosurePdfText { pages: { page: number; text: string }[]; totalPages: number; truncated: boolean }

// Bun embeds this pinned module as text, including in compiled Hosts. No worker file or node_modules lookup at runtime.
const workerCode = (pdfjsText as unknown as string) + `
import { parentPort as disclosurePort } from "node:worker_threads";
globalThis.fetch = async () => { throw new Error("PDF subresources disabled"); };
disclosurePort.once("message", async data => {
  let task;
  try {
    task = globalThis.pdfjsLib.getDocument({data, isEvalSupported:false, useSystemFonts:false,
      disableFontFace:true, useWorkerFetch:false, maxImageSize:1, verbosity:0});
    const doc = await task.promise;
    if (doc.numPages < 1 || doc.numPages > 400) throw new Error("Page limit");
    const pages = []; let characters = 0, truncated = false;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number), content = await page.getTextContent();
      const text = content.items.map(item => typeof item.str === "string" ? item.str + (item.hasEOL ? "\\n" : " ") : "").join("")
        .replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]/g," ").trim();
      const remaining = 200000 - characters;
      pages.push({page:number,text:text.slice(0,remaining)}); characters += Math.min(text.length,remaining);
      page.cleanup();
      if (text.length > remaining || characters >= 200000 && number < doc.numPages) { truncated = true; break; }
    }
    disclosurePort.postMessage({pages,totalPages:doc.numPages,truncated});
  } catch { disclosurePort.postMessage({error:true}); }
  finally { await task?.destroy(); disclosurePort.close(); }
});`;

/** Hard wall-clock bound runs outside the Host event loop. Always waits for worker termination. */
export async function extractDisclosurePdf(bytes: Uint8Array, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DisclosurePdfText> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > 8 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error("Unsupported disclosure PDF");
  const worker = new Worker(workerCode, { eval: true });
  let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined;
  try {
    return await new Promise<DisclosurePdfText>((resolve, reject) => {
      aborted = () => reject(options.signal?.reason ?? new Error("Disclosure read cancelled"));
      options.signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => reject(new Error("Disclosure extraction timed out")), Math.min(15_000, options.timeoutMs ?? 15_000));
      worker.once("message", (result: DisclosurePdfText & { error?: boolean }) => result.error ? reject(new Error("Disclosure PDF could not be read within limits")) : resolve(result));
      worker.once("error", () => reject(new Error("Disclosure PDF worker failed")));
      worker.once("exit", () => reject(new Error("Disclosure PDF worker exited")));
      if (options.signal?.aborted) { aborted(); return; }
      worker.postMessage(bytes);
    });
  } finally {
    clearTimeout(timer);
    if (aborted) options.signal?.removeEventListener("abort", aborted);
    await worker.terminate();
  }
}

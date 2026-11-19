import { getText } from "./http.ts";
import { SourceRequestError } from "./market-data-error.ts";
import type { SourceConnection, SourceRequestOptions } from "./market-data.ts";

const DEFAULT_BASE_URL = "https://fuyao.aicubes.cn";

export async function readFuyao(
  endpoint: string,
  query: Record<string, string>,
  maxBytes: number,
  dataset: string,
  connection: Omit<SourceConnection, "source">,
  options: SourceRequestOptions,
): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) {
    throw new Error("Invalid Fuyao request timeout");
  }
  const env = connection.env ?? process.env;
  const key = connection.apiKey ?? env.WHYJ_QUANT_FUYAO_API_KEY;
  if (!key?.trim()) throw new SourceRequestError("provider-failure", "WHYJ_QUANT_FUYAO_API_KEY is not configured");

  let base: URL;
  try { base = new URL(connection.baseUrl ?? env.FUYAO_BASE_URL ?? DEFAULT_BASE_URL); }
  catch { throw new Error("Invalid Fuyao base URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))) {
    throw new Error("Invalid Fuyao base URL");
  }
  const url = new URL(endpoint, base);
  url.search = new URLSearchParams(query).toString();

  try {
    return JSON.parse(await getText(url.href, maxBytes, { ...options, redirect: "error" }, { "X-api-key": key }));
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /^Request timed out after \d+ms$/.test(error.message)) {
      throw new SourceRequestError("timeout", `Fuyao ${dataset} request timed out`);
    }
    throw new SourceRequestError("provider-failure", `Fuyao ${dataset} request failed`);
  }
}

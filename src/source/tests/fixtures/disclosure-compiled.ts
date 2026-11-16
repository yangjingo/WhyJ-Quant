import { readFileSync } from "node:fs";
import { readDisclosurePdf } from "../../src/disclosure-pdf.ts";

const bytes = readFileSync(process.argv[2]!);
const result = await readDisclosurePdf("600000.SH", "https://static.cninfo.com.cn/finalpage/2020-01-04/synthetic.PDF", {
  fetch: (async (_input: string | URL | Request, _init?: RequestInit) => new Response(bytes, { headers: { "content-type": "application/pdf" } })) as typeof fetch,
});
console.log(JSON.stringify({ status: result.status, symbolMention: result.symbolMention, text: result.pages[0]?.text }));
if (result.status !== "available" || result.symbolMention !== "header-match") process.exitCode = 1;

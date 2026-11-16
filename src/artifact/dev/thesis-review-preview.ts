import { mkdirSync, writeFileSync } from "node:fs";
import { renderThesisReviewArtifact } from "../src/thesis-review.ts";
import { thesisFixture, thesisPriceFixture } from "../test/thesis-review-fixture.ts";

// Standalone synthetic rendering only; service membership/storage are separate acceptance.
const reports = new Map<string, string>();
for (const name of ["fundamental", "price", "missing", "wording"]) {
  const input = thesisFixture();
  if (name === "price") { input.event.kind = "price"; input.evidence[0]!.kind = "price"; }
  if (name === "missing") input.evidence = [];
  if (name === "wording") { input.event.kind = "wording"; input.evidence = []; }
  const { html } = renderThesisReviewArtifact(input, { reportId: `synthetic-${name}`, generatedAt: "2026-11-15T13:00:00.000Z", price: thesisPriceFixture() });
  reports.set(`/${name}`, html);
  mkdirSync("output/playwright/thesis-review", { recursive: true }); writeFileSync(`output/playwright/thesis-review/${name}.html`, html);
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const html = reports.get(new URL(request.url).pathname);
  return new Response(html ?? "Not found", { status: html ? 200 : 404, headers: { "Content-Type": "text/html;charset=utf-8" } });
} });
console.log(JSON.stringify({ origin: server.url.origin, cases: [...reports.keys()], synthetic: true }));

import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderThesisReviewArtifact, type ThesisTspReportContext } from "../src/thesis-review.ts";
import { renderEchartsKline } from "../src/renderers.ts";
import { thesisFixture, thesisPriceFixture } from "./thesis-review-fixture.ts";
const options = { reportId: "comparison-1", generatedAt: "2026-11-15T13:00:00.000Z" };

test("fixed private comparison retains provenance, thresholds and an unrecorded decision", () => {
  const input = thesisFixture(), before = structuredClone(input), price = thesisPriceFixture();
  const output = renderThesisReviewArtifact(input, { ...options, price });
  expect(output.result.outcome).toBe("assumption_review"); expect(input).toEqual(before);
  expect(output.html).toBe(renderThesisReviewArtifact(input, { ...options, price }).html);
  const { document } = parseHTML(output.html);
  expect(document.querySelector('[data-thesis-outcome="assumption_review"]')).not.toBeNull();
  expect(document.querySelector('[href="https://example.com/disclosure"]')).not.toBeNull();
  expect(document.querySelector('[data-event-day="true"]')?.textContent).toContain("2026-11-13");
  for (const text of [input.baseline.revision, input.evidence[0]!.dataRef!.sha256, input.evidence[0]!.retrievedAt,
    "22 percent", "18 percent", "≥ 20 percent", "满足 → 不满足", "尚未记录", "来源陈述", "synthetic", "成交量单位 股"]) expect(document.body.textContent).toContain(text);
  expect(document.querySelector('[data-share-report]')).toBeNull();
  expect(document.querySelector('#share-preview-open')?.hasAttribute('disabled')).toBe(true);
});

test("price, insufficient evidence and wording remain distinct in the fixed report", () => {
  const price = thesisFixture(); price.event = { ...price.event, kind: "price" }; price.evidence = [{ ...price.evidence[0]!, kind: "price" }];
  const pending = thesisFixture(); pending.evidence = [{ ...pending.evidence[0]!, metric: { ...pending.evidence[0]!.metric, period: "2025-Q3" } }];
  const wording = thesisFixture(); wording.event = { ...wording.event, kind: "wording" }; wording.evidence = [];
  for (const [input, outcome, message] of [[price, "price_observation", "未据此否定基本面假设"], [pending, "pending_verification", "incomparable_period"], [wording, "no_material_change", "wording_does_not_change_evidence"]] as const) {
    const result = renderThesisReviewArtifact(input, options);
    expect(result.result.outcome).toBe(outcome); expect(result.html).toContain(message);
    expect(result.html).toContain("不作数值对照"); expect(result.html).toContain("未提供固定价量快照");
  }
});

test("an explicit user decision stays independent of pending evidence", () => {
  const input = thesisFixture(); input.evidence = [];
  input.decision = { action: "defer", rationale: "等待原始披露", decidedAt: input.cutoff };
  const { result, html } = renderThesisReviewArtifact(input, options);
  expect(result.outcome).toBe("pending_verification"); expect(html).toContain("暂缓"); expect(html).toContain("等待原始披露");
});

test("untrusted text is escaped in HTML and script contexts", () => {
  const input = thesisFixture(), payload = '</script><img src=x onerror="globalThis.injected=1">';
  input.baseline = { ...input.baseline, statement: payload }; input.event = { ...input.event, summary: payload };
  const { html } = renderThesisReviewArtifact(input, { ...options, price: thesisPriceFixture() });
  const { document } = parseHTML(html);
  expect(document.querySelector('img[src="x"]')).toBeNull(); expect(document.body.textContent).toContain(payload);
  for (const script of document.querySelectorAll('script:not([src])')) expect(() => new Function(script.textContent!)).not.toThrow();
  expect(() => renderThesisReviewArtifact(input, { ...options, reportId: payload })).toThrow();
});

for (const invalid of ["symbol", "future", "order", "ohlc", "version", "url", "volume"] as const) test(`invalid ${invalid} chart remains unavailable without changing evidence classification`, () => {
  const price = thesisPriceFixture();
  if (invalid === "symbol") price.symbol = "000001.SZ";
  if (invalid === "future") price.rows[1]!.date = "2026-12-01";
  if (invalid === "order") price.rows.reverse();
  if (invalid === "ohlc") price.rows[1]!.high = 1;
  if (invalid === "version") price.dataRef.sha256 = "bad";
  if (invalid === "url") price.sourceUrl = "javascript:alert(1)";
  if (invalid === "volume") price.rows[1]!.vol = -1;
  const result = renderThesisReviewArtifact(thesisFixture(), { ...options, price });
  expect(result.html).toContain("价量观察不可用"); expect(result.html).not.toContain('id="thesis-price"');
  expect(result.result.outcome).toBe("assumption_review");
});

test("events absent from the fixed observations are not moved or invented", () => {
  const price = thesisPriceFixture(); price.rows[1]!.date = "2026-11-12"; price.rows[0]!.date = "2026-11-11";
  const { html } = renderThesisReviewArtifact(thesisFixture(), { ...options, price });
  expect(html).toContain("事件日没有对应观察"); expect(html).not.toContain('data-event-day="true"');
});

test("chart event annotation uses only exact saved dates and validates identifiers", () => {
  const rows = thesisPriceFixture().rows;
  const chart = renderEchartsKline([{ header: [], rows }], { id: "fixed-chart", eventDate: "2026-11-13" });
  const { document } = parseHTML(chart), emitted: any[] = [];
  const script = document.querySelector('script')!.textContent!;
  const element = { innerHTML: "", parentElement: { parentElement: { querySelectorAll: () => [] } } };
  new Function('document', 'echarts', 'getComputedStyle', 'window', script)(
    { getElementById: () => element }, { init: () => ({ setOption: (option: unknown) => emitted.push(option), resize() {} }) },
    () => ({ getPropertyValue: () => "" }), { addEventListener() {} });
  expect(emitted[0].series[0].markLine.data).toEqual([{ xAxis: "2026-11-13" }]);
  expect(() => renderEchartsKline([{ header: [], rows }], { id: "<script>" })).toThrow();
  expect(() => renderEchartsKline([{ header: [], rows }], { eventDate: "2026-02-30" })).toThrow();
});

test("fixed TSP provenance displays exact observation identity and escaped limitations without altering evidence outcome", () => {
  const tsp: ThesisTspReportContext = { selection: { artifactId: "source-capture", revision: "e".repeat(64), alertIndex: null, price: null },
    view: { recordedAt: options.generatedAt, observations: [
      { tool: "get_recent_alerts" as const, sourceUrl: "http://127.0.0.1:3018/api/alerts", retrievedAt: options.generatedAt, parameters: { limit: 20 }, status: "unavailable" as const, sha256: null, reason: '<img src=x onerror="alert(1)">' },
      { tool: "get_kline" as const, sourceUrl: "http://127.0.0.1:3018/api/kline/daily", retrievedAt: options.generatedAt, parameters: { symbol: "600000.SH", limit: 100 }, status: "available" as const, sha256: "f".repeat(64), reason: null },
    ] } };
  const output = renderThesisReviewArtifact(thesisFixture(), { ...options, tsp }), { document } = parseHTML(output.html);
  expect(output.result.outcome).toBe("assumption_review"); expect(document.querySelector('#tsp-observation img')).toBeNull();
  expect(document.querySelector('#tsp-observation')?.textContent).toContain(tsp.selection.revision);
  expect(document.querySelector('#tsp-observation')?.textContent).toContain("没有把提醒指定为本次事件");
  expect(document.querySelector('#tsp-observation')?.textContent).toContain("缺少原始披露");
  expect(() => renderThesisReviewArtifact(thesisFixture(), { ...options, tsp: { ...tsp, selection: { ...tsp.selection, alertIndex: '<img src=x>' as any } } })).toThrow("Invalid TSP");
  expect(() => renderThesisReviewArtifact(thesisFixture(), { ...options, tsp: { ...tsp, view: { ...tsp.view, observations: tsp.view.observations.map(item => ({ ...item, sourceUrl: "javascript:alert(1)" })) } } })).toThrow("Invalid TSP");
});

test("source context preserves fixed provenance and escapes disclosure text without certifying it", () => {
  const checks: import("../src/thesis-review.ts").ThesisSourcesReportContext = {
    selection: { artifactId: "source-check", revision: "d".repeat(64), disclosure: { page: 1, quote: '<img src=x onerror="alert(1)">', publishedAt: options.generatedAt, confirmed: false } },
    view: { recordedAt: options.generatedAt, price: { status: "unavailable", checkedAt: options.generatedAt, start: "2020-01-02", end: "2020-01-03" },
      disclosure: { status: "available", finalUrl: "https://static.cninfo.com.cn/synthetic.pdf", fetchedAt: options.generatedAt,
        originalSha256: "e".repeat(64), textSha256: "f".repeat(64), totalPages: 1, symbolMention: "unverified", reason: "Synthetic disclosure" } },
    priceComparison: { outcome: "different", reason: "Synthetic difference", comparedDates: ["2020-01-02"], missingDates: [],
      differences: [{ date: "2020-01-02", field: "close", reference: 10, checked: 11 }], tolerance: 1e-8 },
  };
  const output = renderThesisReviewArtifact(thesisFixture(), { ...options, checks }), { document } = parseHTML(output.html);
  const section = document.querySelector("#thesis-sources")!;
  expect(section.querySelector("img")).toBeNull(); expect(section.textContent).toContain(checks.selection.disclosure!.quote);
  for (const value of [checks.selection.revision, checks.view.disclosure!.originalSha256!, checks.view.disclosure!.textSha256!,
    "用户尚未确认", "固定 OHLC 存在差异", "参考 10 / 核对 11", "不证明上游独立"]) expect(section.textContent).toContain(value);
  expect(output.result.outcome).toBe("assumption_review");
  expect(section.querySelector("a")?.getAttribute("href")).toBe(checks.view.disclosure!.finalUrl);
  expect(() => renderThesisReviewArtifact(thesisFixture(), { ...options, checks: { ...checks, view: { ...checks.view,
    disclosure: { ...checks.view.disclosure!, finalUrl: "javascript:alert(1)" } } } })).toThrow("Invalid disclosure");
  const absent = renderThesisReviewArtifact(thesisFixture(), { ...options, checks: { ...checks, selection: { ...checks.selection, disclosure: null }, view: { ...checks.view, disclosure: null }, priceComparison: null } });
  expect(absent.html).toContain("未取得原始披露"); expect(absent.html).toContain("取得行情不等于已确认价格一致");
});

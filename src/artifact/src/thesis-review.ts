import { compareThesisReview } from "../../research/thesis-review.ts";
import type { ThesisReviewInput, ThesisReviewResult } from "../../types/thesis-review.ts";
import type { TspObservation } from "../../types/thesis-tsp.ts";
import type { DisclosureDocument } from "../../types/disclosure.ts";
import type { ThesisPriceComparison } from "../../types/thesis-price-check.ts";
import { esc, renderArtifactTemplate } from "./template.ts";
import { renderEchartsKline } from "./renderers.ts";

/** Supplied fixed chart context. The owning service verifies archive membership. */
export interface ThesisPriceContext {
  symbol: string;
  sourceUrl: string;
  retrievedAt: string;
  adjustment: "none" | "forward" | "backward";
  currency: "CNY";
  volumeUnit: "shares" | "lots";
  dataRef: { id: string; sha256: string };
  rows: { date: string; open: number; high: number; low: number; close: number; vol: number }[];
}

const outcomes: Record<ThesisReviewResult["outcome"], string> = {
  price_observation: "价格观察 · 未据此否定基本面假设",
  assumption_review: "假设待复核 · 出现可比新数据",
  pending_verification: "待核实 · 证据不足或口径不可比",
  no_material_change: "未发现实质变化 · 仅限本次输入",
};
const originLabels = { source: "来源陈述", calculation: "计算结果", interpretation: "解释，待来源核对" };
const decisions = { maintain: "维持", revise: "修订", defer: "暂缓" };
const operators = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
const number = (value: number | null) => value === null ? "未提供" : String(value);
const link = (url: string, label: string) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const day = (instant: string) => new Date(Date.parse(instant) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
function reasonLabel(reason: string): string {
  const parts = reason.split(":"), code = parts.at(-1)!;
  const labels: Record<string, string> = {
    event_outside_baseline_cutoff: "事件时间不在基线与观察截止之间", decision_precedes_event: "决定时间早于事件，需核对",
    wording_event_contains_observations: "措辞事件包含新观察，需重新确认事件类型", wording_does_not_change_evidence: "只改写措辞，没有新增证据",
    missing_evidence: "缺少新证据", symbol_mismatch: "证据对象与研究对象不一致", event_kind_mismatch: "证据类型与事件类型不一致",
    missing_retained_data: "缺少固定数据版本", interpretation_requires_source: "只有解释，缺少原始来源事实", outside_cutoff: "发布时间或取得时间超出观察边界",
    stale_evidence: "证据早于基线或本次事件", missing_value: "缺少观察数值", missing_baseline_value: "基线数值缺失",
    incomparable_name: "指标名称不可比", incomparable_period: "报告期不可比", incomparable_unit: "计量单位不可比",
    incomparable_definition: "业务定义不可比", incomparable_adjustment: "复权口径不可比", conflicting_observations: "新观察数值互相冲突",
    price_does_not_invalidate_fundamental_assumption: "价格变动不直接否定基本面假设", unchanged_observation: "可比观察数值未变",
    assumption_has_new_comparable_evidence: "存在触及该假设的可比新数值，需人工复核",
  };
  return (parts.length > 1 ? parts[0] + "：" : "") + (labels[code] ?? "需要核对证据边界");
}

export function validateThesisPriceContext(raw: unknown, input: Pick<ThesisReviewInput, "symbol" | "cutoff" | "event">): ThesisPriceContext {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid price context");
    const value = raw as ThesisPriceContext;
    const url = new URL(value.sourceUrl);
    if (Object.keys(value).some(key => !["symbol", "sourceUrl", "retrievedAt", "adjustment", "currency", "volumeUnit", "dataRef", "rows"].includes(key))
      || value.symbol !== input.symbol || !["https:", "http:"].includes(url.protocol) || url.username || url.password
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.retrievedAt) || !Number.isFinite(Date.parse(value.retrievedAt)) || new Date(value.retrievedAt).toISOString() !== value.retrievedAt
      || value.retrievedAt > input.cutoff || value.retrievedAt < input.event.occurredAt
      || !["none", "forward", "backward"].includes(value.adjustment) || value.currency !== "CNY" || !["shares", "lots"].includes(value.volumeUnit)
      || !value.dataRef || Object.keys(value.dataRef).length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value.dataRef.id) || !/^[a-f0-9]{64}$/.test(value.dataRef.sha256)
      || !Array.isArray(value.rows) || value.rows.length < 2 || value.rows.length > 1500) throw new Error();
    let previous = "";
    for (const row of value.rows) {
      if (!row || Object.keys(row).length !== 6 || !/^\d{4}-\d\d-\d\d$/.test(row.date) || new Date(row.date).toISOString().slice(0, 10) !== row.date
        || row.date <= previous || row.date > day(input.cutoff)
        || ![row.open, row.high, row.low, row.close, row.vol].every(Number.isFinite)
        || Math.min(row.open, row.close, row.low) <= 0 || row.high < Math.max(row.open, row.close, row.low)
        || row.low > Math.min(row.open, row.close) || row.vol < 0) throw new Error();
      previous = row.date;
    }
    return structuredClone(value);
}

function priceContext(value: ThesisPriceContext | null, result: ThesisReviewResult): string {
  if (!value) return '<section><h3>价量观察</h3><p>未提供固定价量快照。事件不自动补成行情，图表缺失不改变证据分类。</p></section>';
  try {
    value = validateThesisPriceContext(value, result.input);
    const eventDay = day(result.input.event.occurredAt);
    // Reuse fixed-data chart rendering. Event date is explicit in the adjacent raw-data table;
    // a non-trading-day event is not moved to the nearest candle.
    const chart = renderEchartsKline([{ timeframe: "日K", header: ["日期", "开", "高", "低", "收", "量"], rows: value.rows }], { id: "thesis-price", eventDate: eventDay });
    return `<section><h3>价量观察 · 事件日 ${esc(eventDay)}（北京时间）</h3><p>${link(value.sourceUrl, "行情来源")} · ${esc(value.adjustment)} adjustment · ${value.currency} · 成交量单位 ${value.volumeUnit === "shares" ? "股" : "手"} · 取得 ${esc(value.retrievedAt)}</p>
      <p>固定快照声明 ${esc(value.dataRef.id)} / <code>${value.dataRef.sha256}</code>；归档存在性由读取服务核对。行情不替代披露证据。</p>${chart}
      <details><summary>事件与价量逐日对照</summary><div class="research-table" role="region" tabindex="0" aria-label="事件与固定价量对照"><table><thead><tr><th>日期</th><th>收盘 / CNY</th><th>成交量</th><th>事件</th></tr></thead><tbody>${value.rows.map(row => `<tr${row.date === eventDay ? ' data-event-day="true"' : ""}><td>${row.date}</td><td>${row.close}</td><td>${row.vol}</td><td>${row.date === eventDay ? esc(result.input.event.summary) : "—"}</td></tr>`).join("")}</tbody></table></div></details>
      ${value.rows.some(row => row.date === eventDay) ? "" : '<p>事件日没有对应观察；不移动事件日期或插值生成蜡烛。</p>'}</section>`;
  } catch { return '<section><h3>价量观察不可用</h3><p>输入的对象、日期、口径、快照标识或 OHLCV 无效。未替换为最新行情，证据分类仍单独展示。</p></section>'; }
}

/** Pure private report assembly: no source fetch, persistence, Agent call or public projection. */
export interface ThesisTspReportContext {
  selection: { artifactId: string; revision: string; alertIndex: number | null; price: { start: string; end: string; volumeUnit: "shares" | "lots" } | null };
  view: { recordedAt: string; observations: readonly Omit<TspObservation, "content">[] };
}
function tspContext(context: ThesisTspReportContext | undefined): string {
  if (!context) return "";
  const { selection, view } = context;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(selection.artifactId) || !/^[a-f0-9]{64}$/.test(selection.revision) || view.observations.length !== 2
    || selection.alertIndex !== null && (!Number.isSafeInteger(selection.alertIndex) || selection.alertIndex < 0)) throw new Error("Invalid TSP report context");
  for (const item of view.observations) {
    const source = new URL(item.sourceUrl);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password || !["get_recent_alerts", "get_kline"].includes(item.tool)) throw new Error("Invalid TSP report source");
  }
  return `<section id="tsp-observation"><h3>TSP 固定观察</h3><p>观察报告 <code>${esc(selection.artifactId)}</code> / <code>${selection.revision}</code> · 保存 ${esc(view.recordedAt)}。应用按此精确版本打开原始结果，不会重新获取最新数据。</p>
    <p>${selection.alertIndex === null ? "没有把提醒指定为本次事件；行情仅作背景。" : `选择原始提醒索引 ${selection.alertIndex}，仅作为价格事件；提醒不认证基本面披露。`}</p>
    <p>${selection.price ? `固定日线窗口 ${esc(selection.price.start)} 至 ${esc(selection.price.end)} · 前复权 · 用户确认成交量单位 ${selection.price.volumeUnit === "shares" ? "股" : "手"}。只使用采集日前的日线，不插值或补齐。` : "未使用 TSP 日线绘图。"}</p>
    <ul>${view.observations.map(item => `<li>${item.tool} · ${item.status === "available" ? "已保留工具 JSON，数据仍需核对" : "不可用"} · ${link(item.sourceUrl, "工具来源")} · 取得 ${esc(item.retrievedAt)}<br>参数 ${esc(JSON.stringify(item.parameters))} · SHA256 <code>${esc(item.sha256 ?? "无")}</code>${item.reason ? `<br>${esc(item.reason)}` : ""}</li>`).join("")}</ul>
    <p>配置限定 read:market / read:analysis，实际授权由服务端验证。提醒最多描述近七日；K 线 limit 参数不保证返回窗口，当日数据可能未完成。固定字节和来源声明不等于独立行情或披露认证。缺少原始披露时，不能据此维持或否定基本面假设。</p></section>`;
}

export interface ThesisSourcesReportContext {
  selection: { artifactId: string; revision: string; disclosure: { page: number; quote: string; publishedAt: string; confirmed: boolean } | null };
  view: { recordedAt: string; price: { status: string; checkedAt: string; start: string; end: string; source?: string; origin?: string };
    disclosure: Pick<DisclosureDocument, "status" | "finalUrl" | "fetchedAt" | "originalSha256" | "textSha256" | "totalPages" | "symbolMention" | "reason"> | null };
  priceComparison: ThesisPriceComparison | null;
}
function sourceContext(context: ThesisSourcesReportContext | undefined): string {
  if (!context) return "";
  const { selection, view, priceComparison: comparison } = context, doc = view.disclosure;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(selection.artifactId) || !/^[a-f0-9]{64}$/.test(selection.revision)
    || selection.disclosure && (!Number.isSafeInteger(selection.disclosure.page) || selection.disclosure.page < 1 || selection.disclosure.page > 400 || selection.disclosure.quote.length > 4000))
    throw new Error("Invalid fixed source report context");
  if (doc) {
    if (!Number.isSafeInteger(doc.totalPages) || doc.totalPages < 0 || doc.totalPages > 400) throw new Error("Invalid disclosure page count");
    if (doc.finalUrl) { const source = new URL(doc.finalUrl); if (source.protocol !== "https:" || source.username || source.password) throw new Error("Invalid disclosure report URL"); }
  }
  const labels = { matching: "固定 OHLC 一致", different: "固定 OHLC 存在差异", incomparable: "行情不可比", unavailable: "行情核对不可用" };
  return `<section id="thesis-sources"><h3>行情与原始披露核对</h3><p>来源报告 <code>${esc(selection.artifactId)}</code> / <code>${selection.revision}</code> · 保存 ${esc(view.recordedAt)}。</p>
    <p>配置行情源 ${esc(view.price.source ?? "不可用")} · ${esc(view.price.origin ?? view.price.status)} · ${esc(view.price.start)} 至 ${esc(view.price.end)} · 核对 ${esc(view.price.checkedAt)}。</p>
    ${comparison ? `<p>${esc(labels[comparison.outcome])}：${esc(comparison.reason)}</p><p>已比较 ${comparison.comparedDates.length} 个日期；缺失日期 ${esc(comparison.missingDates.join("、") || "无")}。</p>${comparison.differences.length ? `<details><summary>固定 OHLC 差异</summary><ul>${comparison.differences.map(row => `<li>${esc(row.date)} · ${esc(row.field)}：参考 ${esc(String(row.reference))} / 核对 ${esc(String(row.checked))}</li>`).join("")}</ul></details>` : ""}` : "<p>没有提供可比较的固定价量图表；取得行情不等于已确认价格一致。</p>"}
    ${doc ? `<p>公告 ${esc(doc.status)} · ${doc.finalUrl ? link(doc.finalUrl, "原始 PDF 链接") : "没有可读原文"} · 取得 ${esc(doc.fetchedAt)} · 共 ${doc.totalPages} 页 · 代码线索 ${esc(doc.symbolMention)}。</p><p>原文件 SHA256 <code>${esc(doc.originalSha256 ?? "无")}</code> · 提取文本 SHA256 <code>${esc(doc.textSha256 ?? "无")}</code>。</p><p>${esc(doc.reason)}</p>` : "<p>未取得原始披露，不能由行情推断基本面事实。</p>"}
    ${selection.disclosure ? `<p>引用第 ${selection.disclosure.page} 页 · 用户声明披露时间 ${esc(selection.disclosure.publishedAt)} · ${selection.disclosure.confirmed ? "用户已确认发行人、日期和指标口径；不是自动财务认证" : "用户尚未确认发行人、日期和指标口径，仍待核实"}。</p><blockquote>${esc(selection.disclosure.quote)}</blockquote>` : "<p>未选择公告原文作为本次证据。</p>"}
    <p>重新打开使用本次固定版本，不补取最新来源。两个工具一致不证明上游独立；PDF 提取快照不等于原始文件下载。人工决定仍单独记录。</p></section>`;
}

export function renderThesisReviewArtifact(input: unknown, options: { reportId: string; generatedAt: string; price?: ThesisPriceContext | null; tsp?: ThesisTspReportContext; checks?: ThesisSourcesReportContext }) {
  const result = compareThesisReview(input), review = result.input, baseline = review.baseline;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(options.reportId) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(options.generatedAt)
    || !Number.isFinite(Date.parse(options.generatedAt)) || new Date(options.generatedAt).toISOString() !== options.generatedAt || options.generatedAt < review.cutoff) throw new Error("Invalid thesis report identity or generation time.");
  const title = `${review.symbol} · 事件与假设复核`;
  const sources = review.evidence.map(item => `<tr><td>${esc(item.id)}<br>${esc(item.symbol)}</td><td>${originLabels[item.origin]}</td><td>${link(item.sourceUrl, "原始来源")}<br>发布 ${esc(item.publishedAt)}<br>取得 ${esc(item.retrievedAt)}</td><td>${esc(item.metric.name)}: ${number(item.metric.value)} ${esc(item.metric.unit)}<br>${esc(item.metric.period)} · ${esc(item.metric.definition)} · ${item.metric.adjustment}</td><td>${item.dataRef ? `${esc(item.dataRef.id)}<br><code>${item.dataRef.sha256}</code>` : "未提供固定快照"}</td></tr>`).join("");
  const comparison = result.comparison;
  const body = `<section class="research-section" data-thesis-outcome="${result.outcome}"><h2>${outcomes[result.outcome]}</h2>
    <p>观察组 ${esc(review.groupId)} · 复核 ${esc(review.id)} · 观察截止 ${esc(review.cutoff)}</p>
    <h3>事件</h3><p>${esc(review.event.summary)}</p><p>${esc(review.event.occurredAt)} · ${esc(review.event.kind)} · ${link(review.event.sourceUrl, "事件来源")}</p>
    <h3>旧假设与本次观察</h3><p>${esc(baseline.statement)}</p><div class="research-table" role="region" tabindex="0" aria-label="假设与阈值对照"><table><thead><tr><th>指标 / 假设</th><th>基线值</th><th>可比新值</th><th>声明条件</th><th>条件前后</th></tr></thead><tbody><tr><td>${esc(baseline.metric.name)} / ${esc(baseline.assumptionId)}</td><td>${number(baseline.metric.value)} ${esc(baseline.metric.unit)}</td><td>${comparison ? number(comparison.after) + " " + esc(baseline.metric.unit) : "不作数值对照"}</td><td>${operators[baseline.threshold.operator]} ${baseline.threshold.value} ${esc(baseline.metric.unit)}</td><td>${comparison ? `${comparison.heldBefore ? "满足" : "不满足"} → ${comparison.holdsAfter ? "满足" : "不满足"}` : "未判断"}</td></tr></tbody></table></div>
    <p>基线口径：${esc(baseline.metric.period)} · ${esc(baseline.metric.definition)} · ${baseline.metric.adjustment} adjustment · 截止 ${esc(baseline.asOf)}。条件变化只请求人工复核，不构成交易动作。</p>
    <h3>核对结果与缺失项</h3><ul>${result.reasons.map(reason => `<li>${esc(reasonLabel(reason))}<details><summary>核对标识</summary><code>${esc(reason)}</code></details></li>`).join("")}</ul>
    <h3>证据与来源</h3>${sources ? `<div class="research-table" role="region" tabindex="0" aria-label="固定证据与来源"><table><thead><tr><th>证据 / 对象</th><th>性质</th><th>来源与时间</th><th>指标与口径</th><th>固定数据标识</th></tr></thead><tbody>${sources}</tbody></table></div>` : "<p>没有提供新证据。</p>"}
    <h3>用户决定</h3>${review.decision ? `<p>${decisions[review.decision.action]} · ${esc(review.decision.decidedAt)}</p><p>${esc(review.decision.rationale)}</p>` : "<p>尚未记录。证据分类不代替用户选择维持、修订或暂缓。</p>"}
    <h3>参数</h3><dl>${Object.entries(review.parameters).map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(String(value))}</dd>`).join("")}</dl>
    <h3 id="previous-version">版本关系</h3><p>上次报告 <code>${esc(baseline.artifactId)}</code> / <code>${baseline.revision}</code>；当前报告标识 <code>${esc(options.reportId)}</code>。当前不可变版本摘要由保存服务生成；应用按上述精确引用打开上次报告，不以最新文件代替。</p>
    <h3>限制</h3><p>这是给定输入的固定对照，不是独立披露认证。渲染不检查归档是否存在、不补造历史假设、不请求实时数据。来源事实、计算和解释分别标注；口径不可比或缺失时保留待核实状态。该私有报告未生成公开分享副本。</p></section>`;
  return { result, html: renderArtifactTemplate({ title, sessionId: options.reportId, model: "Manual review · no model run", description: "按明确给定的基线、事件与固定证据生成；未在渲染时运行模型或访问行情。", createdAt: review.cutoff, generatedAt: options.generatedAt,
    messageCount: 0, dashboardHtml: `<section class="research-bound thesis-review"><p>MANUAL REVIEW · FIXED INPUTS</p><h2>${outcomes[result.outcome]}</h2><p>${esc(review.event.summary)}</p><a href="#previous-version">查看精确基线版本</a></section>`,
    bodyHtml: `<div class="research-bound thesis-review">${body}${tspContext(options.tsp)}${sourceContext(options.checks)}</div>`, dockHtml: `<div class="research-bound thesis-review">${priceContext(options.price ?? null, result)}</div>`, trajectoryHtml: '<section class="research-bound thesis-review"><h2>手动复核</h2><p>本报告没有合成模型运行轨迹。基线、事件和证据由本次输入明确提供。</p></section>' }) };
}

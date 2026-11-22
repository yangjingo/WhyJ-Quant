import { useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import type { ObservationMarketRegimePreview, ObservationRegimePhase, ObservationRegimeState, WorkbenchClient } from "../client/contract";

const states: Record<ObservationRegimeState, string> = { strong: "强势", lean_strong: "偏强", range: "震荡", lean_weak: "偏弱", weak: "弱势" };
const phases: Record<ObservationRegimePhase, string> = { ice: "冰点", ignite: "启动", rally: "主升", climax: "高潮", ebb: "退潮", repair: "修复" };
const percentileLabels: Record<string, string> = {
  height: "连板高度", firstBoardCount: "首板家数", twoOrMoreCount: "2 板及以上", promotionFraction: "晋级率",
  ladderCompletenessFraction: "梯队完整度",
};
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const show = (value: number | null | undefined, unit = "") => value == null ? "暂无" : number.format(value) + unit;
const pct = (value: number | null | undefined) => show(value == null ? null : value * 100, "%");
const phaseLabel = (phase: ObservationRegimePhase | null | undefined) => phase ? phases[phase] : "暂无阶段";
const stateLabel = (state: ObservationRegimeState | null | undefined) => state ? states[state] : "暂无状态";

type Row = ObservationMarketRegimePreview["rows"][number];

function RegimeChart({ rows }: { rows: readonly Row[] }) {
  const region = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!region.current) return;
    const element = region.current;
    let active = true, observer: ResizeObserver | undefined, chart: EChartsType | undefined;
    void Promise.all([
      import("echarts/core").then(({ init, use }) => ({ init, use })),
      import("echarts/charts").then(({ LineChart }) => LineChart),
      import("echarts/components").then(({ GridComponent, LegendComponent, TooltipComponent }) => [
        GridComponent, LegendComponent, TooltipComponent,
      ]),
      import("echarts/renderers").then(({ CanvasRenderer }) => CanvasRenderer),
    ]).then(([engine, line, components, renderer]) => {
        if (!active) return;
        engine.use([line, ...components, renderer]);
        chart = engine.init(element);
        configureRegimeChart(chart, element, rows);
        observer = new ResizeObserver(() => chart?.resize());
        observer.observe(element);
      }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; observer?.disconnect(); chart?.dispose(); };
  }, [rows]);
  return failed ? <p role="status">图表加载失败，仍可查看逐日指标。</p> :
    <div ref={region} className="observation-regime-chart" role="img" aria-label="状态评分和上涨、下跌家数的交易日趋势图" />;
}

function configureRegimeChart(chart: EChartsType, element: HTMLElement, rows: readonly Row[]) {
  const style = getComputedStyle(element);
  const text = style.getPropertyValue("--muted").trim() || "#c0b8a4";
  const axis = style.getPropertyValue("--line").trim() || "#484137";
  const line = { type: "line" as const, connectNulls: false, symbolSize: 5 };
  chart.setOption({
    animation: false,
    color: ["#e2bb67", "#df7d78", "#79ba96"],
    grid: { top: 48, bottom: 30, left: 42, right: 45 },
    tooltip: { trigger: "axis", confine: true },
    legend: { textStyle: { color: text }, top: 4 },
    xAxis: { type: "category", data: rows.map(row => row.tradingDate),
      axisLabel: { color: text, hideOverlap: true, formatter: (date: string) => date.slice(5) } },
    yAxis: [
      { type: "value", min: 0, max: 100, axisLabel: { color: text }, splitLine: { lineStyle: { color: axis } } },
      { type: "value", min: 0, minInterval: 1, axisLabel: { color: text }, splitLine: { show: false } },
    ],
    series: [
      { ...line, name: "状态评分", data: rows.map(row => row.regime?.score ?? null) },
      { ...line, name: "上涨家数", yAxisIndex: 1, data: rows.map(row => row.daily?.breadth.advances ?? null) },
      { ...line, name: "下跌家数", yAxisIndex: 1, data: rows.map(row => row.daily?.breadth.declines ?? null) },
    ],
  });
}

function Values({ values }: { values: [string, string][] }) {
  return <dl className="observation-indicator-values">
    {values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function RegimeSession({ row }: { row: Row }) {
  const { regime, phase, phaseFutureFields, daily, ladder, market, benchmark, concepts } = row;
  const breadth = daily?.breadth, activity = daily?.activity, dimensions = regime?.dimensions;
  return <section aria-label="交易日指标">
    <h5>{stateLabel(regime?.state)} · {phaseLabel(phase)}</h5>
    {phaseFutureFields.length > 0 && <p className="supporting">阶段判定使用了后续观测。</p>}
    {!market && <p role="status">该交易日没有市场截面归档。</p>}
    <Values values={[
      ["状态评分", show(regime?.score)], ["赚钱", show(dimensions?.profit)], ["投机", show(dimensions?.speculation)],
      ["抗跌", show(dimensions?.resilience)], ["趋势", show(dimensions?.trend)], ["基准涨跌", show(benchmark?.returnPct, "%")],
      ["上涨家数", show(breadth?.advances)], ["下跌家数", show(breadth?.declines)], ["涨跌比", show(breadth?.advanceDeclineRatio)],
      ["强势上涨占比", pct(breadth?.strongAdvanceFraction)], ["强势下跌占比", pct(breadth?.strongDeclineFraction)],
      ["MA20 上方占比", pct(breadth?.aboveMa20Fraction)],
      ["成交总额（元）", show(activity?.totalAmountCny)], ["单股成交均额（元）", show(activity?.meanAmountCny)],
      ["连板高度", show(ladder?.height)], ["首板家数", show(ladder?.firstBoardCount)],
      ["2 板及以上", show(ladder?.twoOrMoreCount)], ["3 板及以上", show(ladder?.threeOrMoreCount)],
      ["5 板及以上", show(ladder?.fiveOrMoreCount)], ["梯队完整度", pct(ladder?.completeness)],
      ["晋级率", pct(ladder?.promotionFraction)], ["封板率", pct(ladder?.sealFraction)],
    ]} />
    {breadth && activity && <p className="supporting">收益样本 {breadth.observedReturns}/{breadth.matchedBars}
      {" · "}成交额样本 {activity.observedAmounts}/{activity.matchedBars} · MA20 样本 {breadth.observedMa20}</p>}
    {daily?.exchange && <ul className="observation-regime-list">
      {([["涨停", daily.exchange.limitUp], ["跌停", daily.exchange.limitDown], ["炸板", daily.exchange.brokenLimitUp]] as const)
        .map(([label, value]) => <li key={label}>{label} {show(value.count)} · 已观察到 {value.observed} 起 · 覆盖 {value.known}/{value.roster}</li>)}
    </ul>}
    {concepts && <div>
      <h5>当日概念主线</h5>
      <p className="supporting">板块归档覆盖 {concepts.archivedGroups}/{concepts.catalogGroups}</p>
      {concepts.ranks === null ? <p>暂无可计算排名。</p> : concepts.ranks.length === 0 ? <p>该日没有概念入榜。</p> :
        <ol className="observation-regime-list">{concepts.ranks.map(rank => <li key={rank.name}>
          {rank.name} · {show(rank.score)} 分 · 最高 {rank.maxBoards} 板 · {rank.leaderSymbol ?? "暂无领涨股"}
        </li>)}</ol>}
      <p className="supporting observation-ref">概念目录 <code>{concepts.catalogRef.revision}</code></p>
    </div>}
    {market && <p className="supporting observation-ref">{market.source} · 采集于 {market.observedAt} · 市场截面 <code>{market.ref.revision}</code></p>}
  </section>;
}

export function ObservationMarketRegimeResult({ result }: { result: ObservationMarketRegimePreview }) {
  const [date, setDate] = useState(result.rows.at(-1)?.tradingDate ?? "");
  const { summary, calendar, phase } = result;
  const selected = result.rows.find(row => row.tradingDate === date);
  const hasChart = result.rows.some(row => row.regime?.score != null || row.daily?.breadth.advances != null);
  return <section className="observation-indicators observation-regime-result" aria-label="市场状态回放结果">
    <h5>市场状态回放结果</h5>
    <p className="supporting">{summary.window.start ?? "暂无起始日"} 至 {summary.window.end ?? "暂无结束日"}
      {" · "}已判定 {summary.window.observedStates}/{summary.window.sessions} 日
      {" · "}{phase.mode === "causal" ? "因果模式" : "TSP 回溯模式"}</p>
    <p className="supporting">完整计算日历 {calendar.start ?? "暂无"} 至 {calendar.end ?? "暂无"} · {calendar.sessions} 个交易日
      {" · "}{result.universe === "captured-market-roster" ? "归档股票池" : "排除已归档风险警示股票"}</p>
    {hasChart ? <RegimeChart rows={result.rows} /> : <p role="status">当前窗口没有可绘制的状态或涨跌家数。</p>}
    <Values values={[
      ["连续同态", show(summary.momentum?.streak, " 日")], ["近五日评分斜率", show(summary.momentum?.scoreSlope, " 分/日")],
      ["距上次观测弱势", show(summary.momentum?.sessionsSinceLastObservedWeak, " 日")],
      ["状态切换", show(summary.stateSwitches.count, " 次")], ["切换频率", pct(summary.stateSwitches.fraction)],
      ["当前阶段", phaseLabel(summary.currentPhase?.phase)], ["阶段持续", show(summary.currentPhase?.streak, " 日")],
      ["该阶段平均持续", show(summary.currentPhase?.averageDays, " 日")], ["该阶段最长持续", show(summary.currentPhase?.maxDays, " 日")],
    ]} />
    <details>
      <summary>状态分布与阶段切换</summary>
      <ul className="observation-regime-list">{summary.distribution.map(item => <li key={item.state ?? "missing"}>
        {stateLabel(item.state)} · {item.days} 日 · {show(item.pct, "%")}
      </li>)}</ul>
      <p className="supporting">状态切换以 {summary.stateSwitches.observedPairs} 对可比较的相邻交易日为分母。</p>
      {summary.currentPhase?.successors.length ? <ul className="observation-regime-list">{summary.currentPhase.successors.map(item =>
        <li key={item.phase ?? "missing"}>后续 {phaseLabel(item.phase)} · {item.transitions} 次 · {show(item.pct, "%")}</li>)}</ul> : null}
    </details>
    <details>
      <summary>最新梯队分位</summary>
      <ul className="observation-regime-list">{summary.latestPercentiles.map(item => <li key={item.field}>
        {percentileLabels[item.field] ?? item.field} · 分位 {show(item.percentilePct, "%")} · {item.observed} 个样本
      </li>)}</ul>
    </details>
    <details>
      <summary>阶段区间与主导概念</summary>
      <div className="observation-regime-segments">{summary.segments.map(segment => <details key={segment.start}>
        <summary>{phaseLabel(segment.phase)} · {segment.start} 至 {segment.end} · {segment.days} 日</summary>
        <Values values={[
          ["平均高度", show(segment.means.height.value)], ["平均首板", show(segment.means.firstBoardCount.value)],
          ["平均 2 板及以上", show(segment.means.twoOrMoreCount.value)], ["平均晋级率", pct(segment.means.promotionFraction.value)],
          ["平均封板率", pct(segment.means.sealFraction.value)],
        ]} />
        <p className="supporting">晋级率有效 {segment.means.promotionFraction.observed} 日 · 封板率有效 {segment.means.sealFraction.observed} 日
          {" · "}概念归档覆盖 {segment.conceptDays}/{segment.days} 日</p>
        {segment.topConcepts.length > 0 && <ol className="observation-regime-list">{segment.topConcepts.map(concept =>
          <li key={concept.name}>{concept.name} · 前五 {concept.topFiveDays} 日 · 累计 {show(concept.scoreSum)} 分</li>)}</ol>}
      </details>)}</div>
    </details>
    {selected && <>
      <label className="field-row">查看交易日<select value={date} onChange={event => setDate(event.target.value)}>
        {result.rows.map(row => <option key={row.tradingDate}>{row.tradingDate}</option>)}
      </select></label>
      <RegimeSession row={selected} />
    </>}
    <p className="supporting observation-ref">WHYJ 摘要公式 v{summary.formula.version} · 清单修订 <code>{result.manifestRef.revision}</code></p>
  </section>;
}

export function ObservationMarketRegime({ read }: { read: WorkbenchClient["readObservationMarketRegime"] }) {
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ObservationMarketRegimePreview | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const valid = /^[a-f0-9]{64}$/.test(revision.trim());
  useEffect(() => {
    setBusy(false); setResult(null); setError("");
    return () => { generation.current++; };
  }, [read]);

  const load = async () => {
    if (!valid || !read || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setError(""); setResult(null);
    try {
      const preview = await read({ version: 1, kind: "market-regime-manifest", revision: revision.trim() });
      if (ticket === generation.current) setResult(preview);
    } catch (cause) {
      if (ticket !== generation.current) return;
      const code = cause instanceof Error && "code" in cause ? cause.code : null;
      setError(code === "METHOD_NOT_FOUND" ? "当前服务不支持市场状态回放，请更新并重新连接。" :
        cause instanceof Error ? cause.message : "无法读取指定清单。");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };

  return <div className="settings-group observation-regime" aria-busy={busy}>
    <h4>市场状态回放</h4>
    {!read ? <p role="status">当前服务不支持市场状态回放，请更新并重新连接。</p> : <>
      <label className="field-row">市场状态清单修订<input value={revision} disabled={busy} placeholder="64 位 SHA-256"
        onChange={event => { setRevision(event.currentTarget.value); setResult(null); setError(""); }} /></label>
      <p className="supporting">填入 CLI 导入市场状态清单返回的修订号。</p>
      <button type="button" className="action" disabled={!valid || busy} onClick={() => void load()}>{busy ? "正在回放…" : "读取市场状态"}</button>
      {error && <p role="alert" className="operation-feedback error-feedback">{error}</p>}
      {result && <ObservationMarketRegimeResult key={result.manifestRef.revision} result={result} />}
    </>}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import type { ObservationIntradayPreview, ObservationIntradayRequest, WorkbenchClient } from "../client/contract";

const indicatorGroups = [
  { title: "价格", fields: [
    ["price", "分时价格", "price"], ["vwap", "当日成交均价", "price"],
    ["pct_vs_prev_close", "较昨收", "percent"], ["pct_from_open", "较开盘", "percent"],
  ] },
  { title: "量比", fields: [
    ["vol_ratio_1m_today", "1 分钟量比", "ratio"], ["vol_ratio_3m_today", "3 分钟量比", "ratio"],
    ["vol_ratio_5m_today", "5 分钟量比", "ratio"],
  ] },
  { title: "价格区间", fields: [
    ["day_high_dist", "距日内最高", "percent"], ["day_low_dist", "距日内最低", "percent"],
    ["open_30m_high_dist", "距开盘 30 分钟最高", "percent"], ["open_30m_low_dist", "距开盘 30 分钟最低", "percent"],
  ] },
] as const;
const signals = {
  signal_intraday_avg_cross_up: "上穿成交均价",
  signal_intraday_avg_cross_down: "下穿成交均价",
  signal_intraday_zero_cross_up: "上穿昨收零轴",
  signal_intraday_zero_cross_down: "下穿昨收零轴",
} as const;
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 4 });
const revision = /^[a-f0-9]{64}$/;

function display(value: number | null | undefined, kind: "price" | "percent" | "ratio") {
  if (value == null) return "暂无";
  if (kind === "percent") return percent.format(value);
  return number.format(value) + (kind === "ratio" ? "×" : " 元");
}

export function IntradayIndicatorResult({ result, minute }: { result: ObservationIntradayPreview; minute: string }) {
  const row = result.rows.find(item => item.minute === minute);
  const { input, formula } = result;
  return <>
    <p className="supporting">数据源 {input.source} · {input.endpoint} · {input.timeZone} · {result.rows.length} 根分钟记录 · 覆盖与最终状态未知</p>
    <p className="supporting observation-ref">WhyJ 计算 · 公式 v{formula.version} · TSP 修订 <code>{formula.revision}</code></p>
    {input.previousClose && <p className="supporting observation-ref">昨收来源 {input.previousClose.source} · <code>{input.previousClose.archiveRef.revision}</code></p>}
    {row ? <>
      <p className="supporting">分钟起点 {row.minute} · 原始时间 {row.originalTradeTime}</p>
      <div className="observation-indicator-groups">
        {indicatorGroups.map(group => <details key={group.title} open>
          <summary>{group.title}</summary>
          <dl className="observation-indicator-values">
            {group.fields.map(([field, label, kind]) => <div key={field}><dt>{label}</dt><dd>{display(row.values[field], kind)}</dd></div>)}
          </dl>
        </details>)}
        <details open>
          <summary>穿越信号</summary>
          <dl className="observation-indicator-values">
            {Object.entries(signals).map(([field, label]) => {
              const crossed = row.signals[field];
              return <div key={field}><dt>{label}</dt><dd>{crossed == null ? "暂无" : crossed ? "命中" : "未命中"}</dd></div>;
            })}
          </dl>
        </details>
      </div>
    </> : <p role="status" className="supporting">归档中没有该日期的常规分钟记录。</p>}
    {result.openingBoundaries.map(item => <p key={item.tradeTime} className="supporting">
      开盘边界 {item.tradeTime} · 成交量 {number.format(item.volume)} 股 · 成交额 {display(item.amount, "price")}
    </p>)}
  </>;
}

type State =
  | { status: "idle" | "loading" | "failed" | "unsupported" }
  | { status: "ready"; result: ObservationIntradayPreview; minute: string };

export function ObservationIntraday({ read, archiveRef, startDate, endDate }: {
  read: WorkbenchClient["readObservationIntraday"];
  archiveRef: ObservationIntradayRequest["archiveRef"];
  startDate: string;
  endDate: string;
}) {
  const [tradeDate, setTradeDate] = useState(endDate);
  const [previousRevision, setPreviousRevision] = useState("");
  const [compatible, setCompatible] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, [read]);
  const invalidate = () => { attempt.current++; setState({ status: "idle" }); };
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(tradeDate) && tradeDate >= startDate && tradeDate <= endDate;
  const previousValid = !previousRevision || (revision.test(previousRevision) && compatible);
  const load = async () => {
    if (!read || !dateValid || !previousValid || state.status === "loading") return;
    const ticket = ++attempt.current;
    setState({ status: "loading" });
    try {
      const request: ObservationIntradayRequest = { archiveRef, tradeDate };
      if (previousRevision) request.previousClose = {
        ref: { version: 1, kind: "daily-trading-limits", revision: previousRevision }, priceBasis: "caller-confirmed-same-basis",
      };
      const result = await read(request);
      if (ticket !== attempt.current) return;
      const returned = result.archiveRef;
      if (returned.kind !== archiveRef.kind || returned.version !== archiveRef.version || returned.revision !== archiveRef.revision ||
        result.tradeDate !== tradeDate || result.producer !== "whyj" || result.formula.id !== "tsp_intraday" ||
        (result.input.previousClose?.archiveRef.revision ?? "") !== previousRevision ||
        result.rows.some(row => row.tradingDate !== tradeDate) ||
        result.openingBoundaries.some(row => !row.openingBoundary || row.tradeTime.slice(0, 10) !== tradeDate)) {
        throw new Error("Unexpected intraday preview identity");
      }
      setState({ status: "ready", result, minute: result.rows.at(-1)?.minute ?? "" });
    } catch (error) {
      if (ticket !== attempt.current) return;
      const code = (error as { code?: string } | null)?.code;
      setState({ status: code === "METHOD_NOT_FOUND" || code === "UNAVAILABLE" ? "unsupported" : "failed" });
    }
  };
  if (!read || state.status === "unsupported") return <p role="status" className="supporting">当前服务版本不支持分时指标预览。</p>;
  return <section className="observation-indicators" aria-label="历史分时指标">
    <h5>历史分时指标</h5>
    <div className="data-source-grid">
      <label className="field-row">预览交易日
        <input type="date" min={startDate} max={endDate} value={tradeDate} onChange={e => { setTradeDate(e.target.value); invalidate(); }} />
      </label>
      {state.status === "ready" && state.result.rows.length > 0 && <label className="field-row">分钟（上海）
        <select value={state.minute} onChange={e => setState({ ...state, minute: e.target.value })}>
          {state.result.rows.map(row => <option key={row.minute} value={row.minute}>{row.minute}</option>)}
        </select>
      </label>}
    </div>
    <details>
      <summary>补充昨收（可选）</summary>
      <label className="field-row">昨收归档引用
        <input value={previousRevision} maxLength={64} spellCheck={false} autoComplete="off" onChange={e => {
          setPreviousRevision(e.target.value.trim()); setCompatible(false); invalidate();
        }} />
      </label>
      {previousRevision && <label><input type="checkbox" checked={compatible} onChange={e => { setCompatible(e.target.checked); invalidate(); }} />
        确认昨收与分时价格口径相容
      </label>}
    </details>
    <button type="button" className="action" disabled={!dateValid || !previousValid || state.status === "loading"} onClick={() => void load()}>
      {state.status === "loading" ? "正在读取分时…" : "预览分时指标"}
    </button>
    {state.status === "failed" && <p role="alert" className="operation-feedback error-feedback">无法读取分时预览，请核对日期和归档引用后重试。</p>}
    {state.status === "ready" && <IntradayIndicatorResult result={state.result} minute={state.minute} />}
  </section>;
}

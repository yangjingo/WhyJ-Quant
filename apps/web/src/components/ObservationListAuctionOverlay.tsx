import { useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import type { ObservationListAuctionOverlayPreview, ObservationListAuctionOverlayRequest, WorkbenchClient } from "../client/contract";

const invalid = () => new Error("清单需要有效的扩展表、交易日期、标的、竞价字段和已确认的上海时间。");

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}

export function auctionOverlayManifest(value: unknown): ObservationListAuctionOverlayRequest {
  const { version, datasetId, date, symbols, fields: mapping, timeBasis } = fields(value, ["version", "datasetId", "date", "symbols", "fields", "timeBasis"]);
  if (version !== 1 || typeof datasetId !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(datasetId) ||
    typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || timeBasis !== "caller-confirmed-shanghai-wall-clock" ||
    !Array.isArray(symbols) || !symbols.length || symbols.length > 100 || new Set(symbols).size !== symbols.length ||
    symbols.some(symbol => typeof symbol !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(symbol))) throw invalid();
  const day = new Date(date);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw invalid();
  const raw = fields(mapping, ["price", "matchedQuantity", "unmatchedQuantity"]);
  const fieldName = (name: unknown) => {
    if (typeof name !== "string" || !name.length || name.length > 256 || name !== name.trim() || /[,\u0000-\u001f]/.test(name)) throw invalid();
    return name;
  };
  const price = fieldName(raw.price);
  const matchedQuantity = raw.matchedQuantity === undefined ? undefined : fieldName(raw.matchedQuantity);
  const unmatchedQuantity = raw.unmatchedQuantity === undefined ? undefined : fieldName(raw.unmatchedQuantity);
  const names = [price, matchedQuantity, unmatchedQuantity].filter(name => name !== undefined);
  if (new Set(names).size !== names.length) throw invalid();
  return { datasetId, date, symbols, fields: { price, matchedQuantity, unmatchedQuantity }, timeBasis };
}

type AuctionPoint = ObservationListAuctionOverlayPreview["overlay"]["rows"][number]["points"][number];
const label = { price: "竞价价格", matchedQuantity: "匹配量", unmatchedQuantity: "未匹配量" } as const;
const side = { buy: "买方剩余", sell: "卖方剩余", balanced: "平衡" } as const;
const availability = { observed: "已观测", missing: "未提供序列", empty: "空序列" } as const;
const show = (value: number | null) => value === null ? "暂无" : String(value);

function AuctionPriceChart({ points }: { points: AuctionPoint[] }) {
  const region = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    let active = true, chart: EChartsType | undefined, observer: ResizeObserver | undefined;
    void Promise.all([
      import("echarts/core"),
      import("echarts/charts").then(module => module.LineChart),
      import("echarts/components").then(module => module.GridComponent),
      import("echarts/renderers").then(module => module.CanvasRenderer),
    ]).then(([engine, line, grid, renderer]) => {
      if (!active) return;
      engine.use([line, grid, renderer]);
      const style = getComputedStyle(element);
      const muted = style.getPropertyValue("--muted").trim();
      chart = engine.init(element);
      chart.setOption({
        animation: false,
        color: [style.getPropertyValue("--gold").trim()],
        grid: { left: 12, right: 20, top: 12, bottom: 7, containLabel: true },
        xAxis: { type: "value", min: 0, max: 600, interval: 120,
          axisLabel: { color: muted, hideOverlap: true, formatter: (seconds: number) => "09:" + (15 + seconds / 60) } },
        yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { color: muted },
          splitLine: { lineStyle: { color: style.getPropertyValue("--line").trim() } } },
        series: [{ type: "line", symbolSize: 4, data: points.map(point => [
          (Number(point.time.slice(3, 5)) - 15) * 60 + Number(point.time.slice(6, 8)), point.price,
        ]) }],
      });
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(element);
    }).catch(() => {
      if (!active) return;
      chart?.dispose();
      chart = undefined;
      setFailed(true);
    });
    return () => { active = false; observer?.disconnect(); chart?.dispose(); };
  }, [points]);
  return failed ? <p role="status">价格曲线暂不可用，仍可查看逐秒数值。</p> :
    <div ref={region} className="observation-list-intraday-chart" role="img" aria-label="集合竞价价格曲线" />;
}

export function AuctionOverlayResult({ result }: { result: ObservationListAuctionOverlayPreview }) {
  const { input, overlay } = result;
  const [symbol, select] = useState(overlay.rows.find(row => row.status === "observed")?.symbol ?? overlay.rows[0]?.symbol);
  const [time, selectTime] = useState<string>();
  const row = overlay.rows.find(item => item.symbol === symbol);
  const selected = row?.points.find(point => point.time === time) ?? row?.points.at(-1);
  const display = (role: keyof typeof label) => selected && row?.ambiguous.some(item => item.role === role && item.time === selected.time)
    ? "重复时刻" : show(selected?.[role] ?? null);
  return <div className="observation-list-result">
    <p className="supporting">TSP · {input.datasetId} · {overlay.tradeDate} · 上海时间</p>
    <label className="field-row">竞价标的<select value={symbol} onChange={event => { select(event.currentTarget.value); selectTime(undefined); }}>
      {overlay.rows.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
    </select></label>
    {row?.status === "observed" ? <AuctionPriceChart key={row.symbol} points={row.points} /> :
      <p role="status">该标的暂无可用竞价价格。</p>}
    {selected && <>
      <label className="field-row">查看竞价时刻<select value={selected.time} onChange={event => selectTime(event.currentTarget.value)}>
        {row?.points.map(point => <option key={point.time} value={point.time}>{point.time}</option>)}
      </select></label>
      <p>价格 {display("price")} · 匹配量 {display("matchedQuantity")} · 未匹配量 {display("unmatchedQuantity")}
        {selected.unmatchedSide && " · " + side[selected.unmatchedSide]}</p>
      {!!row?.ambiguous.length && <p className="supporting">重复时刻导致 {row.ambiguous.length} 个字段值无法确认。</p>}
    </>}
    <details className="observation-list-stock">
      <summary>TSP 字段来源</summary>
      {(["price", "matchedQuantity", "unmatchedQuantity"] as const).map(role => {
        const receipt = input[role];
        if (!receipt) return null;
        const item = receipt.series.find(series => series.symbol === symbol);
        return <p key={role} className="supporting observation-ref">{label[role]} · {receipt.field} · {item ? availability[item.status] : "暂无"}
          {" · "}单位未知 · <time dateTime={receipt.observedAt}>{receipt.observedAt}</time> · <code>{receipt.revision}</code></p>;
      })}
    </details>
  </div>;
}

export function ObservationListAuctionOverlay({ read }: { read: WorkbenchClient["readObservationListAuctionOverlay"] }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ObservationListAuctionOverlayPreview | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    setBusy(false); setResult(null); setError("");
    return () => { generation.current++; };
  }, [read]);
  const unsupported = "当前服务不支持集合竞价读取，请更新并重新连接。";
  const load = async () => {
    if (!file || !read || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setResult(null); setError("");
    try {
      if (file.size > 32 * 1024) throw new Error("清单文件不能超过 32 KB。");
      let value: unknown;
      try { value = JSON.parse(await file.text()); } catch { throw new Error("无法读取 JSON 清单。"); }
      const request = auctionOverlayManifest(value);
      if (ticket !== generation.current) return;
      const preview = await read(request);
      if (ticket === generation.current) setResult(preview);
    } catch (cause) {
      if (ticket !== generation.current) return;
      setError(cause instanceof Error && "code" in cause && cause.code === "METHOD_NOT_FOUND" ? unsupported
        : cause instanceof Error ? cause.message : "无法读取指定的集合竞价数据。");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };

  return <div className="settings-group observation-list" aria-busy={busy}>
    <h4>集合竞价</h4>
    {!read ? <p role="status">{unsupported}</p> : <>
      <p className="supporting">上传 CLI 竞价清单，查看价格曲线及各时刻的原始匹配量和未匹配量。</p>
      <label className="field-row">竞价清单<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        setFile(event.currentTarget.files?.[0] ?? null); setResult(null); setError("");
      }} /></label>
      <button type="button" className="action" disabled={!file || busy} onClick={() => void load()}>
        {busy ? "正在读取竞价…" : "读取集合竞价"}
      </button>
      {error && <p role="alert" className="operation-feedback error-feedback">{error}</p>}
      {result && <AuctionOverlayResult result={result} />}
    </>}
  </div>;
}

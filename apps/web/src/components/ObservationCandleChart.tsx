import { useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import type { ObservationListRowsPreview } from "../client/contract";

type Candles = NonNullable<ObservationListRowsPreview["rows"][number]["observations"]["dailyCandles"]>;

export function ObservationCandleChart({ rows }: { rows: Candles["rows"] }) {
  const region = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = region.current;
    if (!element) return;
    let active = true, observer: ResizeObserver | undefined, chart: EChartsType | undefined;
    void Promise.all([
      import("echarts/core").then(({ init, use }) => ({ init, use })),
      import("echarts/charts").then(({ CandlestickChart }) => CandlestickChart),
      import("echarts/components").then(({ GridComponent, TooltipComponent }) => [GridComponent, TooltipComponent]),
      import("echarts/renderers").then(({ CanvasRenderer }) => CanvasRenderer),
    ]).then(([engine, candles, components, renderer]) => {
      if (!active) return;
      engine.use([candles, ...components, renderer]);
      const style = getComputedStyle(element);
      const muted = style.getPropertyValue("--muted").trim();
      const line = style.getPropertyValue("--line").trim();
      const rise = style.getPropertyValue("--red").trim();
      const fall = style.getPropertyValue("--green").trim();
      chart = engine.init(element);
      chart.setOption({
        animation: false,
        grid: { left: 12, right: 12, top: 12, bottom: 14, containLabel: true },
        tooltip: { trigger: "axis", axisPointer: { type: "line" }, renderMode: "richText", confine: true },
        xAxis: { type: "category", data: rows.map(row => row.tradeDate),
          axisLabel: { color: muted, hideOverlap: true, formatter: (date: string) => date.slice(5) },
          axisLine: { lineStyle: { color: line } } },
        yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { color: muted },
          splitLine: { lineStyle: { color: line } } },
        series: [{ type: "candlestick", name: "日 K",
          data: rows.map(row => [row.open, row.close, row.low, row.high]),
          itemStyle: { color: rise, color0: fall, borderColor: rise, borderColor0: fall } }],
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
  }, [rows]);

  return failed ? <p role="status">图表暂不可用，仍可查看逐日行情。</p> :
    <div ref={region} className="observation-list-candle-chart" role="img" aria-label="供应商日 K 蜡烛图" />;
}

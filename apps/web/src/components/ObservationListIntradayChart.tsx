import { useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import type { ObservationListRowsPreview } from "../client/contract";

type IntradayPoints = NonNullable<ObservationListRowsPreview["rows"][number]["metrics"]["intraday"]>["points"];

const minutes = [9 * 60 + 30, 13 * 60].flatMap(start => Array.from({ length: 120 }, (_, offset) => {
  const minute = start + offset;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}));

export function ObservationListIntradayChart({ points, baseline }: { points: IntradayPoints; baseline?: number }) {
  const region = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = region.current;
    if (!element) return;
    let active = true, observer: ResizeObserver | undefined, chart: EChartsType | undefined;
    void Promise.all([
      import("echarts/core").then(({ init, use }) => ({ init, use })),
      import("echarts/charts").then(({ LineChart }) => LineChart),
      import("echarts/components").then(({ GridComponent, TooltipComponent, LegendComponent }) => [GridComponent, TooltipComponent, LegendComponent]),
      import("echarts/renderers").then(({ CanvasRenderer }) => CanvasRenderer),
    ]).then(([engine, lineChart, components, renderer]) => {
      if (!active) return;
      engine.use([lineChart, ...components, renderer]);
      const style = getComputedStyle(element);
      const muted = style.getPropertyValue("--muted").trim();
      const line = style.getPropertyValue("--line").trim();
      const prices = new Map(points.map(point => [point.minute, point]));
      chart = engine.init(element);
      chart.setOption({
        animation: false,
        color: [style.getPropertyValue("--text").trim(), style.getPropertyValue("--gold").trim(), muted],
        legend: { top: 2, textStyle: { color: muted } },
        grid: { left: 9, right: 20, top: 32, bottom: 8, containLabel: true },
        tooltip: { trigger: "axis", renderMode: "richText", confine: true },
        xAxis: { type: "category", data: minutes, boundaryGap: false,
          axisLabel: { color: muted, hideOverlap: true, interval: (index: number) => [0, 60, 120, 180, 239].includes(index) },
          axisLine: { lineStyle: { color: line } } },
        yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { color: muted }, splitLine: { lineStyle: { color: line } } },
        series: [
          { type: "line", name: "收盘", data: minutes.map(minute => prices.get(minute)?.close ?? null), showSymbol: points.length === 1 },
          { type: "line", name: "累计均价", data: minutes.map(minute => prices.get(minute)?.averageClose ?? null), showSymbol: points.length === 1 },
          ...(baseline === undefined ? [] : [{
            type: "line", name: "图表基准", data: minutes.map(() => baseline), showSymbol: false, lineStyle: { type: "dashed" },
          }]),
        ],
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
  }, [points, baseline]);

  return failed ? <p role="status">图表暂不可用，仍可查看逐分钟数值。</p> :
    <div ref={region} className="observation-list-intraday-chart" role="img" aria-label="WHYJ 分时收盘和累计均价" />;
}

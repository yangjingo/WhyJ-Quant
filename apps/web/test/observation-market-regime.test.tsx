import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ObservationMarketRegimePreview } from "../src/client/contract";
import { ObservationMarketRegime, ObservationMarketRegimeResult } from "../src/components/ObservationMarketRegime";

const revision = "a".repeat(64);
const date = "2025-03-04";
const formula = { version: 1, revision };
const mean = { value: 0, observed: 1, denominator: 1 };
const result: ObservationMarketRegimePreview = {
  manifestRef: { version: 1, kind: "market-regime-manifest", revision },
  calendar: { zone: "Asia/Shanghai", start: "2025-03-03", end: date, sessions: 2 },
  universe: "captured-market-roster",
  phase: { mode: "retrospective-tsp", formula: { ...formula, id: "tsp_market_phase" } },
  summary: {
    producer: "whyj", formula: { ...formula, id: "tsp_market_regime_summary" },
    window: { start: date, end: date, sessions: 1, observedStates: 1 },
    distribution: [{ state: "range", days: 1, pct: 100 }],
    stateSwitches: { count: 0, observedPairs: 0, fraction: null },
    momentum: { state: "range", streak: 1, scoreSlope: null, sessionsSinceLastObservedWeak: null },
    latestPercentiles: [{ field: "height", value: 1, observed: 1, percentilePct: null }],
    segments: [{ phase: "ice", start: date, end: date, days: 1, conceptDays: 1,
      means: { height: mean, firstBoardCount: mean, twoOrMoreCount: mean, promotionFraction: mean, sealFraction: mean },
      topConcepts: [{ name: "示例概念", topFiveDays: 1, scoreSum: 10, maxBoards: 1, leaderSymbol: "600000.SH" }] }],
    currentPhase: { phase: "ice", streak: 1, segments: 1, averageDays: 1, maxDays: 1, successors: [] },
  },
  rows: [{
    tradingDate: date, regime: { formula: { ...formula, id: "tsp_market_regime" }, state: "range", score: 50,
      label: "震荡", dimensions: { profit: 55, speculation: 50, resilience: 50, trend: 50 } },
    phase: "ice", phaseFutureFields: ["height"], ladder: null, benchmark: null,
    daily: {
      breadth: { observedReturns: 2, matchedBars: 2, advances: 0, declines: 1, flat: 1, strongAdvances: 0, strongDeclines: 1,
        advanceDeclineRatio: 0, advanceFraction: 0, declineFraction: 0.5, strongAdvanceFraction: 0, strongDeclineFraction: 0.5,
        aboveMa20Fraction: null, observedMa20: 0 },
      activity: { unit: "CNY", sourceUnit: "CNY-thousand", matchedBars: 2, observedAmounts: 1, totalAmountCny: 0, meanAmountCny: 0 },
      exchange: null,
    },
    market: { ref: { version: 1, kind: "market-cross-section", revision }, source: "tushare", observedAt: "2025-03-05T00:00:00Z" },
    concepts: { catalogRef: { version: 1, kind: "dated-sector-catalog", revision }, archivedGroups: 1, catalogGroups: 2,
      ranks: [{ name: "示例概念", rank: 1, score: 10, maxBoards: 1, leaderSymbol: "600000.SH" }] },
  }],
};

test("shows both windows, selectable dates, daily missingness and phase evidence", () => {
  const html = renderToStaticMarkup(<ObservationMarketRegimeResult result={result} />);
  expect(html).toContain("完整计算日历 2025-03-03 至 2025-03-04");
  expect(html).toContain("TSP 回溯模式");
  expect(html).toContain("状态评分和上涨、下跌家数的交易日趋势图");
  expect(html).toContain("阶段判定使用了后续观测");
  expect(html).toContain("<dt>成交总额（元）</dt><dd>0</dd>");
  expect(html).toContain("<dt>MA20 上方占比</dt><dd>暂无</dd>");
  expect(html).toContain("成交额样本 1/2");
  expect(html).toContain("板块归档覆盖 1/2");
  expect(html).toContain("阶段区间与主导概念");
  expect(html).toContain('<option selected="">2025-03-04</option>');
  expect(renderToStaticMarkup(<ObservationMarketRegimeResult result={{ ...result, rows: [] }} />)).toContain("当前窗口没有可绘制");
});

test("retains optional Host compatibility and only submits a digest", () => {
  expect(renderToStaticMarkup(<ObservationMarketRegime read={undefined} />)).toContain("当前服务不支持市场状态回放");
  const html = renderToStaticMarkup(<ObservationMarketRegime read={async () => result} />);
  expect(html).toContain("市场状态清单修订");
  expect(html).toContain('disabled="">读取市场状态');
});

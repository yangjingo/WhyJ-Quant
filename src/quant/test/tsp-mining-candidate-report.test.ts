import { describe, expect, test } from "bun:test";
import { computeTspMiningCandidateReport, type TspMiningCandidateFoldEvidence,
  type TspMiningCandidateReportInput } from "../index.ts";

const evidence: TspMiningCandidateReportInput = {
  candidateId: "momentum-volume",
  profile: "strict",
  folds: [
    {
      window: { index: 0, trainStart: "2025-12-01", trainEnd: "2026-01-02", testStart: "2026-01-05", testEnd: "2026-01-09" },
      evaluationKind: "selected", testSessionCount: 5,
      outcome: { status: "valid", metrics: { totalReturnFraction: 0.12, sharpe: 2, maxDrawdownFraction: -0.08, tradeCount: 40 } },
    },
    {
      window: { index: 1, trainStart: "2025-12-08", trainEnd: "2026-01-09", testStart: "2026-01-12", testEnd: "2026-01-16" },
      evaluationKind: "cross", testSessionCount: 5,
      outcome: { status: "valid", metrics: { totalReturnFraction: 0, sharpe: null, maxDrawdownFraction: 0, tradeCount: 0 } },
    },
    {
      window: { index: 2, trainStart: "2025-12-15", trainEnd: "2026-01-16", testStart: "2026-01-19", testEnd: "2026-01-23" },
      evaluationKind: "cross", testSessionCount: 5,
      outcome: { status: "valid", metrics: { totalReturnFraction: -0.06, sharpe: -0.5, maxDrawdownFraction: -0.20, tradeCount: 22 } },
    },
    {
      window: { index: 3, trainStart: "2025-12-22", trainEnd: "2026-01-23", testStart: "2026-01-26", testEnd: "2026-01-30" },
      evaluationKind: "cross", testSessionCount: 5,
      outcome: { status: "skipped", reason: "trial budget exhausted" },
    },
    {
      window: { index: 4, trainStart: "2025-12-29", trainEnd: "2026-01-30", testStart: "2026-02-02", testEnd: "2026-02-06" },
      evaluationKind: "cross", testSessionCount: 5,
      outcome: { status: "valid", metrics: { totalReturnFraction: null, sharpe: 1, maxDrawdownFraction: null, tradeCount: null } },
    },
  ],
};

describe("TSP held-out mining candidate report", () => {
  test("matches the pinned overall aggregation and retains precisely which fields and folds contributed", () => {
    const report = computeTspMiningCandidateReport({ ...evidence, folds: evidence.folds.toReversed() });
    expect(report).toMatchObject({
      producer: "whyj", formulaVersion: "tsp-mining-candidate-report-v1", candidateId: "momentum-volume",
      profile: "strict", confidence: "high", folds: evidence.folds,
      summary: {
        worstSharpe: -0.5, worstDrawdownFraction: -0.20, positiveReturnFoldRatio: 1 / 3,
        tradeCount: 62, validFoldCount: 4, skippedFoldCount: 1,
        coverage: { returnFolds: 3, sharpeFolds: 3, drawdownFolds: 3, tradeCountFolds: 3 },
      },
    });
    expect(report.summary.robustScore).toBeCloseTo(0.4, 14);
    expect(report.summary.meanSharpe).toBeCloseTo(0.8333333333333334, 14);
    expect(report.summary.meanReturnFraction).toBeCloseTo(0.02, 14);
  });

  test("distinguishes a valid zero from a skipped or unavailable result", () => {
    const empty = computeTspMiningCandidateReport({ ...evidence, profile: "exploratory", folds: [evidence.folds[3]!] });
    expect(empty).toMatchObject({ confidence: "low", summary: {
      robustScore: null, meanReturnFraction: null, meanSharpe: null, worstSharpe: null,
      worstDrawdownFraction: null, positiveReturnFoldRatio: null, tradeCount: null, validFoldCount: 0, skippedFoldCount: 1,
    } });
    const zero = computeTspMiningCandidateReport({ ...evidence, profile: "balanced", folds: [
      { ...evidence.folds[1]!, evaluationKind: "benchmark" },
    ] });
    expect(zero).toMatchObject({ confidence: "standard", summary: {
      meanReturnFraction: 0, worstDrawdownFraction: 0, positiveReturnFoldRatio: 0, tradeCount: 0, validFoldCount: 1,
    }, folds: [{ evaluationKind: "benchmark" }] });
    expect(empty.gate).toMatchObject({ qualified: false, reasons: [
      "exploratory-profile", "insufficient-valid-folds", "insufficient-positive-fold-ratio",
      "insufficient-mean-sharpe", "excessive-drawdown", "insufficient-trades",
    ] });
  });

  test("uses inclusive published thresholds and strictly positive worst-fold Sharpe for strict profiles", () => {
    const sample: TspMiningCandidateReportInput = {
      ...evidence,
      folds: evidence.folds.slice(0, 3).map((fold, index) => ({
        ...fold,
        outcome: { status: "valid", metrics: {
          totalReturnFraction: index < 2 ? 0.1 : 0, sharpe: 0.5, maxDrawdownFraction: -0.25, tradeCount: 20,
        } },
      })),
    };
    expect(computeTspMiningCandidateReport(sample).gate).toEqual({
      formulaVersion: "tsp-mining-candidate-gate-v1", qualified: true, reasons: [],
      thresholds: {
        minValidFolds: 2, minPositiveReturnFoldRatio: 2 / 3, minMeanSharpe: 0.5, minDrawdownFraction: -0.25, minTrades: 60,
        minWorstSharpeExclusive: 0,
      },
    });
    expect(computeTspMiningCandidateReport({ ...sample, profile: "exploratory" }).gate)
      .toMatchObject({ qualified: false, reasons: ["exploratory-profile"] });

    const zeroWorst: TspMiningCandidateReportInput = { ...sample, folds: sample.folds.map((fold, index) => {
      if (fold.outcome.status === "skipped") return fold;
      return { ...fold, outcome: { status: "valid", metrics: { ...fold.outcome.metrics, sharpe: index ? 0.75 : 0 } } };
    }) };
    expect(computeTspMiningCandidateReport(zeroWorst).gate).toMatchObject({ qualified: false, reasons: ["nonpositive-worst-sharpe"] });
    expect(computeTspMiningCandidateReport({ ...zeroWorst, profile: "balanced" }).gate)
      .toMatchObject({ qualified: true, reasons: [], thresholds: { minWorstSharpeExclusive: null } });
  });

  test("rejects duplicate folds, leakage windows and malformed statuses or metrics", () => {
    const first = evidence.folds[0]!;
    expect(() => computeTspMiningCandidateReport({ ...evidence, folds: [first, first] })).toThrow("unique IDs");
    expect(() => computeTspMiningCandidateReport({ ...evidence, folds: [
      { ...first, window: { ...first.window, trainEnd: first.window.testStart } },
    ] })).toThrow("ordered");
    for (const outcome of [
      { status: "skipped", reason: "" },
      { status: "skipped", reason: "failed", metrics: first.outcome },
      { status: "valid", metrics: { totalReturnFraction: 0, sharpe: Infinity, maxDrawdownFraction: 0, tradeCount: 1 } },
      { status: "valid", metrics: { totalReturnFraction: 0, sharpe: 1, maxDrawdownFraction: 0.25, tradeCount: 1 } },
    ]) {
      expect(() => computeTspMiningCandidateReport({ ...evidence, folds: [
        { ...first, outcome: outcome as TspMiningCandidateFoldEvidence["outcome"] },
      ] })).toThrow("Invalid");
    }
  });
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computeTspResearchFactors, TSP_INDICATOR_REVISION, TSP_RESEARCH_FACTOR_FORMULA_VERSION,
  type TspResearchFactorBar, type TspResearchFactorId, type TspResearchFinancialReport } from "../index.ts";

const reference = JSON.parse(readFileSync(new URL("./fixtures/tsp-research-factors.json", import.meta.url), "utf8")) as {
  revision: string; polars: string;
  bars: TspResearchFactorBar[]; reports: TspResearchFinancialReport[];
  fields: TspResearchFactorId[]; expected: (number | null)[][];
};
const { bars, reports, fields, expected } = reference;

test("matches all pinned research factor keys and results across the daily history", () => {
  expect(TSP_INDICATOR_REVISION).toBe(reference.revision);
  expect(TSP_RESEARCH_FACTOR_FORMULA_VERSION).toBe(1);
  expect(fields).toHaveLength(77);
  const result = computeTspResearchFactors(bars, { volumeUnit: "hand", financialReports: reports });
  expect(result).toHaveLength(expected.length);
  expect(Object.keys(result[0]!.values)).toEqual(fields);
  result.forEach(({ date, values }, row) => {
    expect(date).toBe(bars[row]!.date);
    for (const [column, field] of fields.entries()) {
      const value = expected[row]![column];
      if (value === null) expect(values[field], `${date}: ${field}`).toBeNull();
      else expect(values[field], `${date}: ${field}`).toBeCloseTo(value!, 9);
    }
  });
});

test("requires known units and input observations, preserving zero and announcement-day eligibility", () => {
  const basic = bars.map(({ date, open, high, low, close, volume }) => ({ date, open, high, low, close, volume }));
  const missing = computeTspResearchFactors(basic).at(-1)!.values;
  expect(missing).toMatchObject({ vwap_bias: null, log_float_mv: null, amihud_20d: null, turnover_rate: null,
    limit_up_count_20d: null, pb_latest: null, roe_latest: null });
  expect(missing.momentum_120d).not.toBeNull();

  const full = computeTspResearchFactors(bars, { volumeUnit: "hand", financialReports: reports });
  const shares = computeTspResearchFactors(bars.map(bar => ({ ...bar, volume: bar.volume * 100 })), { volumeUnit: "share" });
  expect(full[0]!.values.roe_latest).toBeNull();
  expect(full[150]!.values.roe_latest).toBe(10);
  expect(full[151]!.values).toMatchObject({ roe_latest: 0, pb_latest: null });
  expect(shares.at(-1)!.values.vwap_bias).toBeCloseTo(full.at(-1)!.values.vwap_bias!, 12);
  expect(shares.at(-1)!.values.log_float_mv).toBeCloseTo(full.at(-1)!.values.log_float_mv!, 12);
  expect(() => computeTspResearchFactors(bars, { financialReports: [reports[0]!, reports[0]!] })).toThrow("announcement history");
});

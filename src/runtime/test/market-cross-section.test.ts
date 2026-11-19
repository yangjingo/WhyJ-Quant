import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarketCrossSectionArchive, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectMarketCrossSection, deriveTspMarketBreadthArchive } from "../data/market-cross-section.ts";

const date = "2024-01-05", day = "20240105";
const universeFields = "trade_date,ts_code,name,industry,list_date".split(",");
const barFields = "ts_code,trade_date,open,high,low,close,vol,amount,pre_close,change,pct_chg".split(",");
const basicFields = "ts_code,trade_date,close,pe,pe_ttm,pb,total_mv,circ_mv,turnover_rate,turnover_rate_f,volume_ratio,total_share,float_share,free_share".split(",");
const roster = [[day, "600000.SH", "Up", "Industry", null], [day, "000001.SZ", "Down", null, null],
  [day, "000002.SZ", "Suspended", null, null], [day, "000003.SZ", "Missing", null, null]];
const bars = [
  ["600000.SH", day, 10, 11, 10, 10.3, 10, 1, 10, 0.3, 3],
  ["000001.SZ", day, 10, 10, 9.6, 9.7, 1, 0, 10, -0.3, -3],
  ["000002.SZ", day, 10, 10, 10, 10, 0, null, 10, 0, 0],
  ["300001.SZ", day, 10, 11, 10, 11, 500, 999, 10, 1, 10],
];
const basics = [
  ["600000.SH", day, 10.3, 2, null, 0.4, 120, 95, 7, null, 99, 12, 9.5, null],
  ["300001.SZ", day, 11, 2, null, 0.4, 120, 95, 50, null, 99, 12, 9.5, null],
];
const response = (fields: string[], items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-market-replay-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "fixture-secret" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("collects the observed roster and replays one dated cross-section with coverage and native units", async () => {
  const http = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response(universeFields, roster))
    .mockResolvedValueOnce(response(barFields, bars))
    .mockResolvedValueOnce(response(basicFields, basics));
  try {
    const receipt = await collectMarketCrossSection(date);
    if (receipt.status !== "archived") throw new Error("Missing cross-section");
    expect(receipt.counts).toEqual({ universe: 4, bars: 4, basics: 2 });
    expect(JSON.stringify(receipt)).not.toContain("fixture-secret");
    expect(http.mock.calls.map(call => JSON.parse(String(call[1]?.body))).map(body =>
      [body.api_name, body.params.trade_date])).toEqual([["bak_basic", day], ["daily", day], ["daily_basic", day]]);
    const source = await loadMarketCrossSectionArchive(receipt.ref);
    expect(source.bars.rows.find(row => row.symbol === "300001.SZ")?.amount).toBe(999);
    expect(source.basics.rows.find(row => row.symbol === "600000.SH")?.providerVolumeRatio).toBe(99);

    const result = await deriveTspMarketBreadthArchive(receipt.ref);
    expect(result.archiveRef).toEqual(receipt.ref);
    expect(result.producer).toBe("whyj");
    expect(result.formula.id).toBe("tsp_market_breadth");
    const { members: _members, ...universe } = source.universe;
    expect(result.input.universe).toEqual({ ...universe, rowCount: 4 });
    expect(result.input.bars).toMatchObject({ endpoint: "daily", rowCount: 4, matched: 3, outOfRoster: 1, amountUnit: "CNY-thousand" });
    expect(result.input.basics).toMatchObject({ endpoint: "daily_basic", rowCount: 2, matched: 1, outOfRoster: 1 });
    const { metrics } = result;
    expect(metrics.coverage).toEqual({ members: 4, observed: 3, missing: 1, eligible: 2, excludedBySuspensionRule: 1, unknownEligibility: 0 });
    expect(metrics.breadth.strongUp).toMatchObject({ count: 1, denominator: 2, fraction: 0.5 });
    expect(metrics.breadth.strongDown).toMatchObject({ count: 1, denominator: 2, fraction: 0.5 });
    expect(metrics.amount).toEqual({ total: 1000, average: 500, denominator: 2 });
    expect(metrics.leaders.amount.map(row => [row.symbol, row.value])).toEqual([["600000.SH", 1000], ["000001.SZ", 0]]);
    expect(metrics.activity.turnover).toEqual({ total: 7, average: 7, denominator: 1 });
    expect(metrics.activity.volumeRatio.average).toBeNull();
    expect(metrics.trend.aboveMa5.fraction).toBeNull();
    expect(await deriveTspMarketBreadthArchive(receipt.ref)).toEqual(result);
    expect(http).toHaveBeenCalledTimes(3);
  } finally { http.mockRestore(); }
});

test("an empty roster, denied snapshot, or cancellation cannot commit a cross-section", async () => {
  const http = spyOn(globalThis, "fetch");
  const controller = new AbortController();
  try {
    http.mockResolvedValueOnce(response(universeFields, []));
    expect(await collectMarketCrossSection(date)).toMatchObject({ status: "empty", ref: null });
    expect(http).toHaveBeenCalledTimes(1);
    http.mockResolvedValueOnce(response(universeFields, roster))
      .mockResolvedValueOnce(response(barFields, bars))
      .mockResolvedValueOnce(new Response("private message", { status: 403 }));
    await expect(collectMarketCrossSection(date)).rejects.toMatchObject({ code: "provider-failure" });

    http.mockResolvedValueOnce(response(universeFields, roster))
      .mockImplementationOnce((async () => {
        controller.abort();
        return response(barFields, bars);
      }) as unknown as typeof fetch);
    await expect(collectMarketCrossSection(date, { signal: controller.signal })).rejects.toThrow();
    await expect(collectMarketCrossSection("2024-02-31")).rejects.toThrow("Invalid market cross-section date");
    expect(http).toHaveBeenCalledTimes(6);
    expect(existsSync(join(root, "data", "market-cross-section-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

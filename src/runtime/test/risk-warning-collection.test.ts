import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRiskWarningArchive, readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectRiskWarningObservations } from "../data/risk-warning-collection.ts";

const date = "2024-09-03";
const fields = ["ts_code", "name", "trade_date", "type", "type_name"];
const row = ["600001.SH", "风险名单样本", "20240903", "ST", "风险警示板"];
const response = (items: string[][]) => Response.json({ code: 0, data: { fields, items } });
let root: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-risk-warning-collection-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "risk-warning-fixture" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("collects risk-warning data by trade date and reopens exact and empty captures", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response([]));
  try {
    const receipt = await collectRiskWarningObservations(date);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "stock_st", token: "risk-warning-fixture", params: { trade_date: "20240903" }, fields: fields.join(","),
    });
    expect(receipt).toMatchObject({ source: "tushare", endpoint: "stock_st", market: "A", tradeDate: date,
      coverage: "unknown", status: "archived", rowCount: 1 });
    expect(JSON.stringify(receipt)).not.toContain("risk-warning-fixture");
    const batch = await loadRiskWarningArchive(receipt.ref);
    expect(batch.observedAt).toBe(receipt.observedAt);
    expect(batch.rows).toEqual([{ symbol: row[0], name: row[1], type: row[3], typeName: row[4] }]);
    const empty = await collectRiskWarningObservations(date);
    expect(empty).toMatchObject({ status: "empty", rowCount: 0 });
    expect((await loadRiskWarningArchive(empty.ref)).rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("denied, mismatched and cancelled reads do not commit risk-warning archives", async () => {
  const controller = new AbortController();
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("private details", { status: 403 }))
    .mockResolvedValueOnce(response([[row[0]!, row[1]!, "20240904", row[3]!, row[4]!]]))
    .mockImplementationOnce((async () => {
      controller.abort();
      return response([]);
    }) as unknown as typeof fetch);
  try {
    await expect(collectRiskWarningObservations(date)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectRiskWarningObservations(date)).rejects.toThrow("Provider risk-warning observation invalid");
    await expect(collectRiskWarningObservations(date, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const settings = readSettings();
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tickflow" } });
    await expect(collectRiskWarningObservations(date)).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "risk-warning-archives-v1"))).toBe(false);
  } finally { fetcher.mockRestore(); }
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectDatedMoneyFlow, replayDatedMoneyFlow } from "../data/money-flow.ts";

const date = "2024-09-03";
const fields = [
  "ts_code", "trade_date",
  "buy_sm_vol", "buy_sm_amount", "sell_sm_vol", "sell_sm_amount",
  "buy_md_vol", "buy_md_amount", "sell_md_vol", "sell_md_amount",
  "buy_lg_vol", "buy_lg_amount", "sell_lg_vol", "sell_lg_amount",
  "buy_elg_vol", "buy_elg_amount", "sell_elg_vol", "sell_elg_amount",
  "net_mf_vol", "net_mf_amount",
];
const row = ["600001.SH", "20240903", 0, 0, 20, 2.25, 31, 3.15, 38, 3.88, 41, 4.18, 46, 4.68, null, null, 58, 5.78, -12, -0.21];
const response = (items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });
let root: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-money-flow-runtime-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: "money-flow-runtime-fixture", TUSHARE_BASE_URL: "https://tushare.test" } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("captures configured Tushare results and reopens populated and empty revisions offline", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response([]));
  try {
    const received = await collectDatedMoneyFlow(date);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://tushare.test/");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "moneyflow", token: "money-flow-runtime-fixture", params: { trade_date: "20240903" }, fields: fields.join(","),
    });
    expect(received).toMatchObject({ source: "tushare", endpoint: "moneyflow", market: "A", tradeDate: date,
      coverage: "unknown", status: "archived", rowCount: 1, volumeUnit: "hand", amountUnit: "CNY-ten-thousand" });
    expect(JSON.stringify(received)).not.toContain("money-flow-runtime-fixture");
    const empty = await collectDatedMoneyFlow(date);
    expect(empty).toMatchObject({ status: "empty", rowCount: 0 });

    const settings = readSettings();
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tickflow" }, env: {} });
    const replay = await replayDatedMoneyFlow(received.ref);
    expect(replay.ref).toEqual(received.ref);
    expect(replay.observation.observedAt).toBe(received.observedAt);
    expect(replay.observation.rows).toEqual([{
      symbol: "600001.SH",
      small: { buyVolumeHand: 0, buyAmount: 0, sellVolumeHand: 20, sellAmount: 2.25 },
      medium: { buyVolumeHand: 31, buyAmount: 3.15, sellVolumeHand: 38, sellAmount: 3.88 },
      large: { buyVolumeHand: 41, buyAmount: 4.18, sellVolumeHand: 46, sellAmount: 4.68 },
      extraLarge: { buyVolumeHand: null, buyAmount: null, sellVolumeHand: 58, sellAmount: 5.78 },
      netVolumeHand: -12, netAmount: -0.21,
    }]);
    expect((await replayDatedMoneyFlow(empty.ref)).observation.rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("rejects forbidden, date-mismatched, cancelled and unsupported captures before archival", async () => {
  const controller = new AbortController();
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("private provider failure", { status: 403 }))
    .mockResolvedValueOnce(response([row.with(1, "20240904")]))
    .mockImplementationOnce((async () => {
      controller.abort();
      return response([]);
    }) as unknown as typeof fetch);
  try {
    await expect(collectDatedMoneyFlow(date)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectDatedMoneyFlow(date)).rejects.toThrow("Provider money-flow identity invalid");
    await expect(collectDatedMoneyFlow(date, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const settings = readSettings();
    saveSettings({ ...settings, preferences: { ...settings.preferences, source: "tickflow" } });
    await expect(collectDatedMoneyFlow(date)).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "money-flow-archives-v1"))).toBe(false);
  } finally { fetcher.mockRestore(); }
});

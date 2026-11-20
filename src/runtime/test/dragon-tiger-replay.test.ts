import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDragonTigerBoard, replayTspDragonTiger } from "../data/dragon-tiger.ts";

const tradeDate = "2026-07-01";
const stock = { thscode: "002407.SZ", ticker: "002407", name: "Fixture", range_days: 1 };
const stockItems = [{ ...stock, net_value: 20 }, { ...stock, range_days: 3, net_value: 80 }, { ...stock, net_value: -30 }];
const response = (kind: string, stocks: unknown[] = [], seats: unknown[] = [], date = tradeDate) => Response.json({
  code: 0, data: { board_type: kind, timestamp: 1_782_921_600_000, trade_date: date, count: 4, stock_count: 1,
    stock_items: stocks, hot_money_items: seats },
});

let root: string;
let previousRoot: string | undefined;
let previousKey: string | undefined;
let previousBase: string | undefined;
beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  previousKey = process.env.WHYJ_QUANT_FUYAO_API_KEY;
  previousBase = process.env.FUYAO_BASE_URL;
  root = mkdtempSync(join(tmpdir(), "whyj-dragon-tiger-replay-"));
  process.env.OHQUANT_DIR = root;
  process.env.WHYJ_QUANT_FUYAO_API_KEY = "fixture";
  process.env.FUYAO_BASE_URL = "http://127.0.0.1";
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  if (previousKey === undefined) delete process.env.WHYJ_QUANT_FUYAO_API_KEY;
  else process.env.WHYJ_QUANT_FUYAO_API_KEY = previousKey;
  if (previousBase === undefined) delete process.env.FUYAO_BASE_URL;
  else process.env.FUYAO_BASE_URL = previousBase;
  rmSync(root, { recursive: true, force: true });
});

test("replays captured boards and separates original disclosures from WhyJ rankings", async () => {
  const provider = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response("all", stockItems))
    .mockResolvedValueOnce(response("org"))
    .mockResolvedValueOnce(response("hot_money", [], [{ name: "Seat", buying: 25, rows: [{ ...stock, hot_money_item_net_value: 25 }] }]))
    .mockRejectedValue(new Error("Fixture provider is offline"));
  try {
    const [all, org, hot] = [
      await collectDragonTigerBoard(tradeDate, "all"),
      await collectDragonTigerBoard(tradeDate, "org"),
      await collectDragonTigerBoard(tradeDate, "hot_money"),
    ];
    expect(all).toMatchObject({ source: "fuyao", tradeDate, boardKind: "all", stockRows: 3, providerRecordCount: 4 });
    expect(org).toMatchObject({ status: "empty", boardKind: "org", ref: { kind: "dragon-tiger-board" } });
    expect(hot).toMatchObject({ status: "archived", boardKind: "hot_money", stockRows: 0, seatRows: 1 });
    expect(provider.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("board_type"))).toEqual(["all", "org", "hot_money"]);
    delete process.env.WHYJ_QUANT_FUYAO_API_KEY;
    const replay = await replayTspDragonTiger({ tradeDate, refs: [org.ref, hot.ref, all.ref] });
    expect(replay.input.all).toMatchObject({ source: "fuyao", ref: all.ref, stocks: [
      { rangeDays: 1, netValueCny: 20 }, { rangeDays: 3, netValueCny: 80 }, { rangeDays: 1, netValueCny: -30 },
    ] });
    expect(replay.input.hot_money?.seats).toMatchObject([{ name: "Seat", stocks: [{ seatNetValueCny: 25 }] }]);
    expect(replay.metrics).toMatchObject({ producer: "whyj", tradeDate,
      all: { leadingNetBuys: [{ sourceRow: 1, netValueCny: 80 }, { sourceRow: 0, netValueCny: 20 }],
        leadingNetSells: [{ sourceRow: 2, netValueCny: -30 }] },
      institutions: { comparableCount: 0, leaders: [] }, hotMoney: { leaders: [{ name: "Seat", netValueCny: 25 }] },
    });
    const partial = await replayTspDragonTiger({ tradeDate, refs: [all.ref] });
    expect(partial.input.org).toBeNull();
    expect(partial.metrics.hotMoney).toBeNull();
    await expect(replayTspDragonTiger({ tradeDate, refs: [all.ref, all.ref] })).rejects.toThrow("Unexpected or duplicate dragon-tiger board");
    await expect(replayTspDragonTiger({ tradeDate: "2026-06-30", refs: [all.ref] })).rejects.toThrow("Unexpected or duplicate dragon-tiger board");
    writeFileSync(join(root, "data", "dragon-tiger-archives-v1", `${all.ref.revision}.json`), "{}");
    await expect(replayTspDragonTiger({ tradeDate, refs: [all.ref] })).rejects.toThrow("Observation archive is damaged");
    expect(provider).toHaveBeenCalledTimes(3);
  } finally { provider.mockRestore(); }
});

test("denied, canceled and mismatched captures do not leave a receipt", async () => {
  const provider = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(response("all", [], [], "2026-06-30"));
  try {
    await expect(collectDragonTigerBoard(tradeDate, "all", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    await expect(collectDragonTigerBoard(tradeDate, "all")).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectDragonTigerBoard(tradeDate, "all")).rejects.toMatchObject({ code: "provider-failure" });
    expect(existsSync(join(root, "data", "dragon-tiger-archives-v1"))).toBe(false);
    expect(provider).toHaveBeenCalledTimes(2);
  } finally { provider.mockRestore(); }
});

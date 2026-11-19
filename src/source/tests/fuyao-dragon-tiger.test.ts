import { expect, spyOn, test } from "bun:test";
import { fetchDatedDragonTigerBoard } from "../index.ts";

const tradeDate = "2026-07-01";
const endpoint = "/api/a-share/special-data/dragon-tiger-list";
const connection = { env: { WHYJ_QUANT_FUYAO_API_KEY: "fixture" } };
const providerTimestamp = 1_782_921_600_000;
const stock = { thscode: "002407.SZ", ticker: "002407", name: "Example", range_days: 1, change: 0.02, net_value: 435.5 };
const empty = { timestamp: providerTimestamp, trade_date: tradeDate, board_type: "all", count: 0, stock_count: 0,
  stock_items: [], hot_money_items: [] };
const response = (data: Record<string, unknown>) => Response.json({ code: 0, data });

test("retains provider counts, native fields, timestamps and both stock windows", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValueOnce(response({
    ...empty, count: 12, stock_count: 11,
    stock_items: [
      { ...stock, concept_list: [{ name: "示例" }, { name: null }], net_rate: 0.01, hot_rank: 0,
        buy_value: 800.5, sell_value: 365, limit_reason: "Example disclosure", amount: 10_000,
        org_net_value: -10, org_net_rate: -0.003, org_buy_num: 0, org_sell_num: 2,
        hot_money_net_value: 99.2, hot_money_net_rate: 0, hot_money_item_net_value: 85.3, hot_money_item_net_rate: 0.006 },
      { ...stock, range_days: 3, net_value: 0 },
      { thscode: null, ticker: "900001", name: "Unqualified", net_value: null },
    ],
  }));
  try {
    const board = await fetchDatedDragonTigerBoard(tradeDate, "all", connection);
    expect(request.mock.calls[0]?.[0]).toBe(`https://fuyao.aicubes.cn${endpoint}?date=${tradeDate}&board_type=all`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-api-key": "fixture" }, redirect: "error" });
    expect(board).toMatchObject({ tradeDate, boardKind: "all", endpoint, source: "fuyao", providerTimestamp, coverage: "unknown",
      providerRecordCount: 12, providerStockCount: 11, amountUnit: "CNY", ratioUnit: "fraction", calendarTimeZone: "Asia/Shanghai", seats: [] });
    expect(board.stocks[0]).toEqual({
      symbol: "002407.SZ", ticker: "002407", name: "Example", rangeDays: 1, changeFraction: 0.02, netValueCny: 435.5,
      conceptNames: ["示例", null], netRate: 0.01, hotRank: 0, buyValueCny: 800.5, sellValueCny: 365,
      limitReason: "Example disclosure", amountCny: 10_000, institutionalNetValueCny: -10, institutionalNetRate: -0.003,
      institutionalBuyCount: 0, institutionalSellCount: 2, hotMoneyNetValueCny: 99.2, hotMoneyNetRate: 0,
      seatNetValueCny: 85.3, seatNetRate: 0.006,
    });
    expect(board.stocks[1]).toMatchObject({ symbol: "002407.SZ", rangeDays: 3, netValueCny: 0 });
    expect(board.stocks[2]).toMatchObject({ symbol: null, ticker: "900001", rangeDays: null, netValueCny: null });
    expect(request).toHaveBeenCalledTimes(1);
  } finally { request.mockRestore(); }
});

test("retains institution rows, nested hot-money records and empty boards", async () => {
  const request = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ ...empty, board_type: "org", stock_items: [{ ...stock, org_buy_num: 1 }] }))
    .mockResolvedValueOnce(response({ ...empty, board_type: "hot_money", hot_money_items: [
      { name: "Active seat", buying: 0, rows: [{ ...stock, hot_money_item_net_value: -31.4 }, { ...stock, range_days: 3 }] },
      { name: "No stocks disclosed", buying: null },
    ] }))
    .mockResolvedValueOnce(response(empty));
  try {
    expect(await fetchDatedDragonTigerBoard(tradeDate, "org", connection)).toMatchObject({
      tradeDate, boardKind: "org", stocks: [{ symbol: "002407.SZ", institutionalBuyCount: 1 }], seats: [],
    });
    expect(await fetchDatedDragonTigerBoard(tradeDate, "hot_money", connection)).toMatchObject({
      tradeDate, boardKind: "hot_money", stocks: [], seats: [
        { name: "Active seat", netValueCny: 0, stocks: [
          { symbol: "002407.SZ", seatNetValueCny: -31.4, rangeDays: 1 }, { symbol: "002407.SZ", rangeDays: 3 },
        ] },
        { name: "No stocks disclosed", netValueCny: null, stocks: null },
      ],
    });
    expect(await fetchDatedDragonTigerBoard(tradeDate, "all", connection)).toMatchObject({ stocks: [], seats: [], providerStockCount: 0 });
    expect(request).toHaveBeenCalledTimes(3);
  } finally { request.mockRestore(); }
});

test("fails closed on wrong board scope, malformed fields and provider denial", async () => {
  const request = spyOn(globalThis, "fetch");
  try {
    const invalid = [
      { ...empty, trade_date: "2026-06-30" },
      { ...empty, board_type: "org" },
      { ...empty, timestamp: 0 },
      { ...empty, count: -1 },
      { ...empty, hot_money_items: [{ name: "Foreign seat" }] },
      { ...empty, stock_items: [{ ...stock, ticker: "300001" }] },
      { ...empty, stock_items: [{ ...stock, range_days: 2 }] },
      { ...empty, stock_items: [{ ...stock, net_value: "1.0" }] },
      { ...empty, stock_items: [{ ...stock, org_buy_num: 1.5 }] },
    ];
    for (const data of invalid) {
      request.mockResolvedValueOnce(response(data));
      await expect(fetchDatedDragonTigerBoard(tradeDate, "all", connection)).rejects.toMatchObject({
        code: "provider-failure", message: "Invalid Fuyao dragon-tiger board response",
      });
    }
    request.mockResolvedValueOnce(Response.json({ code: 2001, message: "private provider detail" }));
    await expect(fetchDatedDragonTigerBoard(tradeDate, "all", connection)).rejects.toMatchObject({
      code: "provider-failure", message: "Invalid Fuyao dragon-tiger board response",
    });
    await expect(fetchDatedDragonTigerBoard("2026-02-30", "all", connection)).rejects.toThrow("Invalid Fuyao dragon-tiger board request");
    await expect(fetchDatedDragonTigerBoard(tradeDate, "all", connection, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(invalid.length + 1);
  } finally { request.mockRestore(); }
});

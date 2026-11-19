import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const query = { market: "A", tradeDate: "2021-10-12" } as const;
const fields = ["ts_code", "name", "trade_date", "list_date", "industry"];
const sh = ["600000.SH", "浦发银行", "20211012", "19991110", "银行"];
const sz = ["300605.SZ", "恒锋信息", "20211012", "20170208", "软件服务"];
const bj = ["830799.BJ", "历史样例", "20211012", null, ""];
const response = (items: (string | null)[][]) => Response.json({ code: 0, data: { fields, items } });

test("reads one dated provider universe with stock metadata, explicit coverage and no current-list lookup", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    fetcher.mockResolvedValueOnce(response([bj, sh, sz]));
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const snapshot = await source.fetchHistoricalStockUniverse(query);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "bak_basic", token: "fixture", params: { trade_date: "20211012" }, fields: "trade_date,ts_code,name,industry,list_date",
    });
    expect(snapshot).toEqual({
      source: "tushare", endpoint: "bak_basic", market: "A", coverage: "unknown", observedAt: expect.any(String),
      data: { universe: "provider-dated-stocks", tradeDate: query.tradeDate, members: [
        { symbol: "300605.SZ", name: "恒锋信息", industry: "软件服务", listedOn: "2017-02-08" },
        { symbol: "600000.SH", name: "浦发银行", industry: "银行", listedOn: "1999-11-10" },
        { symbol: "830799.BJ", name: "历史样例", industry: null, listedOn: null },
      ] },
    });
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(getMarketDataCapabilities("tushare").observations.fetchHistoricalStockUniverse).toEqual({ status: "implemented", markets: ["A"] });
    fetcher.mockResolvedValueOnce(response([]));
    expect((await source.fetchHistoricalStockUniverse(query)).data.members).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("rejects saturated, duplicate, foreign-date and malformed universes without fallback", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const malformed = [
      [sh, sh], [["000001.SH", ...sh.slice(1)]], [[sh[0]!, sh[1]!, "20211013", ...sh.slice(3)]],
      [[...sh.slice(0, 3), "20210230", sh[4]!]], [[...sh.slice(0, 3), "20220101", sh[4]!]], [sh.slice(0, -1)],
      Array.from({ length: 7000 }, (_, i) => [`${600000 + i}.SH`, "fixture", "20211012", "19991110", null]),
    ];
    for (const items of malformed) {
      fetcher.mockResolvedValueOnce(response(items));
      await expect(source.fetchHistoricalStockUniverse(query)).rejects.toThrow();
    }
    await expect(source.fetchHistoricalStockUniverse({ ...query, tradeDate: "2015-12-31" })).rejects.toThrow("Invalid");
    await expect(source.fetchHistoricalStockUniverse({ ...query, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "akshare" }).fetchHistoricalStockUniverse(query)).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(malformed.length);
  } finally { fetcher.mockRestore(); }
});

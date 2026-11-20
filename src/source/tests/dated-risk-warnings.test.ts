import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const request = { market: "A", tradeDate: "2024-09-03" } as const;
const fields = ["type_name", "trade_date", "type", "ts_code", "name"];
const primary = ["风险警示板", "20240903", "ST", "600001.SH", "样本甲"];
const other = ["其他分类", "20240903", "OTHER", "600001.SH", "样本甲"];
const secondary = ["风险警示板", "20240903", "ST", "000001.SZ", "*ST 样本乙"];
const response = (items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });

test("reads the selected trade date and keeps provider-defined classifications separate", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(response([primary, secondary, other]))
    .mockResolvedValueOnce(response([]));
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const observation = await source.fetchDatedRiskWarnings(request);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "stock_st", token: "fixture", params: { trade_date: "20240903" }, fields: "ts_code,name,trade_date,type,type_name",
    });
    expect(observation).toEqual({
      source: "tushare", endpoint: "stock_st", market: "A", observedAt: expect.any(String), coverage: "unknown",
      data: { tradeDate: request.tradeDate, rows: [
        { symbol: "000001.SZ", name: "*ST 样本乙", type: "ST", typeName: "风险警示板" },
        { symbol: "600001.SH", name: "样本甲", type: "OTHER", typeName: "其他分类" },
        { symbol: "600001.SH", name: "样本甲", type: "ST", typeName: "风险警示板" },
      ] },
    });
    const empty = await source.fetchDatedRiskWarnings({ ...request, tradeDate: "2024-09-02" });
    expect(empty.data).toEqual({ tradeDate: "2024-09-02", rows: [] });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).params).toEqual({ trade_date: "20240902" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getMarketDataCapabilities("tushare").observations.fetchDatedRiskWarnings).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tickflow").observations.fetchDatedRiskWarnings).toEqual({ status: "not-implemented" });
  } finally { fetcher.mockRestore(); }
});

test("rejects foreign, duplicated, missing and saturated rows without falling back", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const malformed = [
      [primary, primary],
      [primary.slice(1)],
      [["风险警示板", "20240902", "ST", "600001.SH", "样本甲"]],
      [["风险警示板", "20240903", "ST", "000001.SH", "指数"]],
      [["风险警示板", "20240903", "ST", "899050.BJ", "指数"]],
      [["  ", "20240903", "ST", "600001.SH", "样本甲"]],
      Array.from({ length: 1000 }, (_, index) => ["风险警示板", "20240903", "ST", `${600100 + index}.SH`, "样本"]),
    ];
    for (const items of malformed) {
      fetcher.mockResolvedValueOnce(response(items));
      await expect(source.fetchDatedRiskWarnings(request)).rejects.toThrow();
    }
    fetcher.mockResolvedValueOnce(new Response("permission required", { status: 403 }));
    await expect(source.fetchDatedRiskWarnings(request)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(source.fetchDatedRiskWarnings({ ...request, tradeDate: "1999-12-31" })).rejects.toThrow("Invalid");
    await expect(source.fetchDatedRiskWarnings({ ...request, tradeDate: "2024-02-30" })).rejects.toThrow("Invalid");
    await expect(source.fetchDatedRiskWarnings({ ...request, market: "HK" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tickflow" }).fetchDatedRiskWarnings(request))
      .rejects.toMatchObject({ code: "unsupported" });
    await expect(source.fetchDatedRiskWarnings(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(malformed.length + 1);
  } finally { fetcher.mockRestore(); }
});

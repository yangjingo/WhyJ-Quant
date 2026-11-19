import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const day = "2025-01-02", compact = "20250102", code = "BK1184.DC";
const date = { tradeDate: day, market: "A" } as const;
const requested = { ...date, sectorCode: code };
const catalogFields = ["ts_code", "trade_date", "name", "idx_type", "level"];
const memberFields = ["trade_date", "ts_code", "con_code", "name"];
const names = [code, compact, "人形机器人", "概念板块", null];
const one = [compact, code, "873593.BJ", " 鼎智科技 "];
const table = (fields: string[], items: unknown[][]) => Response.json({ code: 0, data: { fields, items } });
const source = () => createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });

test("dated catalog and membership keep their provider identities, types and independent capture evidence", async () => {
  const http = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(table(catalogFields, [names, ["BK0493.DC", compact, "新能源", "概念板块", null]]))
    .mockResolvedValueOnce(table(catalogFields, [["BK0001.DC", compact, "银行", "行业板块", "一级"]]))
    .mockResolvedValueOnce(table(memberFields, [one, [compact, code, "600000.SH", null]]));
  try {
    const provider = source();
    const concept = await provider.fetchDatedSectorCatalog({ ...date, kind: "concept" });
    const industry = await provider.fetchDatedSectorCatalog({ ...date, kind: "industry" });
    const membership = await provider.fetchDatedSectorMembers({ ...requested, sectorCode: " bk1184.dc " });
    expect(concept).toMatchObject({ source: "tushare", endpoint: "dc_index", market: "A", coverage: "unknown", observedAt: expect.any(String),
      data: { tradeDate: day, taxonomy: "eastmoney", kind: "concept", providerType: "概念板块", groups: [
        { code: "BK0493.DC", name: "新能源", level: null }, { code, name: "人形机器人", level: null },
      ] } });
    expect(industry.data).toMatchObject({ kind: "industry", providerType: "行业板块", groups: [{ code: "BK0001.DC", name: "银行", level: "一级" }] });
    expect(membership).toMatchObject({ source: "tushare", endpoint: "dc_member", market: "A", coverage: "unknown", observedAt: expect.any(String),
      data: { tradeDate: day, taxonomy: "eastmoney", sectorCode: code, members: [
        { symbol: "600000.SH", name: null }, { symbol: "873593.BJ", name: "鼎智科技" },
      ] } });
    expect(http.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toMatchObject([
      { api_name: "dc_index", params: { trade_date: compact, idx_type: "概念板块" }, fields: catalogFields.join(",") },
      { api_name: "dc_index", params: { trade_date: compact, idx_type: "行业板块" }, fields: catalogFields.join(",") },
      { api_name: "dc_member", params: { trade_date: compact, ts_code: code }, fields: memberFields.join(",") },
    ]);
    expect(getMarketDataCapabilities("tushare").observations).toMatchObject({
      fetchDatedSectorCatalog: { status: "implemented", markets: ["A"] }, fetchDatedSectorMembers: { status: "implemented", markets: ["A"] },
    });
  } finally { http.mockRestore(); }
});

test("dated sector reads fail closed for provider, coverage date and malformed records", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    const provider = source();
    const unsupported = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
    await expect(unsupported.fetchDatedSectorMembers(requested)).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.fetchDatedSectorCatalog({ ...date, market: "US", kind: "concept" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.fetchDatedSectorCatalog({ ...date, tradeDate: "2025-02-30", kind: "concept" })).rejects.toThrow("Invalid");
    await expect(provider.fetchDatedSectorMembers({ ...requested, tradeDate: "2024-12-19" })).rejects.toThrow("Invalid");
    await expect(provider.fetchDatedSectorMembers({ ...requested, sectorCode: "885800.TI" })).rejects.toThrow("Invalid");
    expect(http).not.toHaveBeenCalled();

    for (const rows of [[names, names], [[code, compact, "错误类型", "地域板块", null]], [[code, "20250103", "错日", "概念板块", null]]]) {
      http.mockResolvedValueOnce(table(catalogFields, rows));
      await expect(provider.fetchDatedSectorCatalog({ ...date, kind: "concept" })).rejects.toThrow();
    }
    for (const rows of [[one, one], [[compact, "BK0493.DC", "600000.SH", "错板块"]], [["20250103", code, "600000.SH", "错日"]],
      [[compact, code, "000001.SH", "指数"]], Array.from({ length: 5000 }, () => one)]) {
      http.mockResolvedValueOnce(table(memberFields, rows));
      await expect(provider.fetchDatedSectorMembers(requested)).rejects.toThrow();
    }
    expect(http).toHaveBeenCalledTimes(8);
  } finally { http.mockRestore(); }
});

test("an empty dated member list is explicit and cancellation does not try a current provider", async () => {
  const preconnect = fetch.preconnect;
  const http = spyOn(globalThis, "fetch").mockResolvedValueOnce(table(memberFields, []));
  try {
    const provider = source();
    expect((await provider.fetchDatedSectorMembers(requested)).data.members).toEqual([]);
    const controller = new AbortController();
    http.mockImplementationOnce(Object.assign(async () => {
      controller.abort(new Error("Cancelled dated sector lookup"));
      return table(memberFields, [one]);
    }, { preconnect }));
    await expect(provider.fetchDatedSectorMembers(requested, { signal: controller.signal })).rejects.toThrow("Cancelled dated sector lookup");
    expect(http).toHaveBeenCalledTimes(2);
  } finally { http.mockRestore(); }
});

import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const query = { market: "A", symbol: " 000001.sh ", start: "2024-02-01", end: "2024-02-06" } as const;
const fields = ["ts_code", "trade_date", "close", "pre_close", "change", "pct_chg"];
const first = ["000001.SH", "20240201", 3010, 3000, 10, 0.3333];
const response = (items: (string | number | null)[][]) => Response.json({ code: 0, data: { fields, items } });

test("preserves native dated index returns and points from the selected Tushare endpoint", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    fetcher.mockResolvedValueOnce(response([
      ["000001.SH", "20240206", 3000, 3010, -10, -0.3322],
      ["000001.SH", "20240205", 3010, 3010, 0, 0],
      first,
      ["000001.SH", "20240202", 3010, null, null, null],
    ]));
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const result = await source.fetchDatedBenchmarkObservations(query);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "index_daily", token: "fixture",
      params: { ts_code: "000001.SH", start_date: "20240201", end_date: "20240206" },
      fields: fields.join(","),
    });
    expect(result).toEqual({
      source: "tushare", endpoint: "index_daily", market: "A", coverage: "unknown", observedAt: expect.any(String),
      data: {
        symbol: "000001.SH", requested: { start: query.start, end: query.end },
        priceUnit: "index-points", returnUnit: "percentage-points",
        rows: [
          { tradeDate: "2024-02-01", closePoints: 3010, previousClosePoints: 3000, changePoints: 10, returnPct: 0.3333 },
          { tradeDate: "2024-02-02", closePoints: 3010, previousClosePoints: null, changePoints: null, returnPct: null },
          { tradeDate: "2024-02-05", closePoints: 3010, previousClosePoints: 3010, changePoints: 0, returnPct: 0 },
          { tradeDate: "2024-02-06", closePoints: 3000, previousClosePoints: 3010, changePoints: -10, returnPct: -0.3322 },
        ],
      },
    });
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
    expect(getMarketDataCapabilities("tushare").observations.fetchDatedBenchmarkObservations)
      .toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tickflow").observations.fetchDatedBenchmarkObservations)
      .toEqual({ status: "not-implemented" });
    fetcher.mockResolvedValueOnce(response([]));
    expect((await source.fetchDatedBenchmarkObservations(query)).data.rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("rejects invalid, duplicate, wrong-index and denied observations without fallback", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const malformed = [
      [first, first],
      [["399001.SZ", ...first.slice(1)]],
      [[first[0]!, "20240207", ...first.slice(2)]],
      [[first[0]!, "20240230", ...first.slice(2)]],
      [[...first.slice(0, -1), "0.3333"]],
      [[...first.slice(0, -1), -101]],
      [first.slice(0, -1)],
    ];
    for (const items of malformed) {
      fetcher.mockResolvedValueOnce(response(items));
      await expect(source.fetchDatedBenchmarkObservations(query)).rejects.toThrow();
    }
    fetcher.mockResolvedValueOnce(Response.json({ code: -2001, msg: "not entitled" }));
    await expect(source.fetchDatedBenchmarkObservations(query)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(source.fetchDatedBenchmarkObservations({ ...query, symbol: "000001.SZ" })).rejects.toThrow("Invalid");
    await expect(source.fetchDatedBenchmarkObservations({ ...query, end: "2025-02-02" })).rejects.toThrow("366");
    await expect(source.fetchDatedBenchmarkObservations({ ...query, market: "US" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tickflow" }).fetchDatedBenchmarkObservations(query))
      .rejects.toMatchObject({ code: "unsupported" });
    const abort = new AbortController();
    abort.abort();
    await expect(source.fetchDatedBenchmarkObservations(query, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(malformed.length + 1);
  } finally { fetcher.mockRestore(); }
});

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
      .toEqual({ status: "implemented", markets: ["A"] });
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
    await expect(createMarketDataSource({ source: "llmquant-data" }).fetchDatedBenchmarkObservations(query))
      .rejects.toMatchObject({ code: "unsupported" });
    const abort = new AbortController();
    abort.abort();
    await expect(source.fetchDatedBenchmarkObservations(query, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(malformed.length + 1);
  } finally { fetcher.mockRestore(); }
});

test("preserves TickFlow BSE 50 closing points and timestamps from the exact Shanghai date range", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  const times = ["2024-02-01", "2024-02-02"].map(date => Date.parse(date + "T00:00:00+08:00"));
  const request = { ...query, symbol: " 899050.bj " };
  const data = { symbol: "899050.BJ", timestamp: times, open: [825, 831], high: [850, 850], low: [800, 820],
    close: [830, 840], volume: [1, 2] };
  try {
    fetcher.mockResolvedValueOnce(Response.json({ data }));
    const selected = createMarketDataSource({ source: "tickflow", apiKey: "fixture", env: {} });
    const result = await selected.fetchDatedBenchmarkObservations(request);
    const [rawUrl, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin + url.pathname).toBe("https://api.tickflow.org/v1/klines");
    expect(url.searchParams.get("symbol")).toBe("899050.BJ");
    expect(url.searchParams.get("period")).toBe("1d");
    expect(url.searchParams.get("adjust")).toBe("none");
    expect(Number(url.searchParams.get("start_time"))).toBe(times[0]!);
    expect(Number(url.searchParams.get("end_time"))).toBe(Date.parse("2024-02-07T00:00:00+08:00") - 1);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture");
    expect(result).toMatchObject({
      source: "tickflow", endpoint: "/v1/klines", market: "A", coverage: "unknown",
      data: { symbol: "899050.BJ", requested: { start: request.start, end: request.end },
        priceUnit: "index-points", returnUnit: "percentage-points",
        rows: ["2024-02-01", "2024-02-02"].map((tradeDate, index) => ({
          tradeDate, sourceTimestamp: times[index], closePoints: data.close[index],
          previousClosePoints: null, returnPct: null, changePoints: null,
        })) },
    });

    for (const invalid of [
      { ...data, symbol: "000001.SH" },
      { ...data, timestamp: [times[0], times[0]! + 1000] },
      { ...data, timestamp: [times[0], Date.parse("2024-02-07T00:00:00+08:00")] },
      { ...data, close: [0, 840] },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json({ data: invalid }));
      await expect(selected.fetchDatedBenchmarkObservations(request)).rejects.toMatchObject({ code: "provider-failure" });
    }
    fetcher.mockResolvedValueOnce(Response.json({ data: { symbol: "899050.BJ", timestamp: [],
      open: [], high: [], low: [], close: [], volume: [] } }));
    expect((await selected.fetchDatedBenchmarkObservations(request)).data.rows).toEqual([]);
    await expect(selected.fetchDatedBenchmarkObservations({ ...request, symbol: "920001.BJ" })).rejects.toThrow("benchmark index");
    await expect(selected.fetchDatedBenchmarkObservations(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(6);
  } finally { fetcher.mockRestore(); }
});

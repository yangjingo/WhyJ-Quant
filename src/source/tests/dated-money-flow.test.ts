import { expect, spyOn, test } from "bun:test";
import { createMarketDataSource, getMarketDataCapabilities } from "../index.ts";

const request = { market: "A", tradeDate: "2024-09-03" } as const;
const fields = [
  "ts_code", "trade_date",
  "buy_sm_vol", "buy_sm_amount", "sell_sm_vol", "sell_sm_amount",
  "buy_md_vol", "buy_md_amount", "sell_md_vol", "sell_md_amount",
  "buy_lg_vol", "buy_lg_amount", "sell_lg_vol", "sell_lg_amount",
  "buy_elg_vol", "buy_elg_amount", "sell_elg_vol", "sell_elg_amount",
  "net_mf_vol", "net_mf_amount",
];
const primary = ["600001.SH", "20240903", 0, 0, 20, 2.23, 45, 4.56, 46, 4.67, 58, 5.89, 61, 6.12, 75, 7.51, 78, 7.88, -17, -11.93];
const secondary = ["000001.SZ", "20240903", ...Array(18).fill(null)];
const response = (items: (string | number | null)[][]) => Response.json({
  code: 0, data: { fields: fields.toReversed(), items: items.map(row => row.toReversed()) },
});

test("preserves the exact date, order-size buckets, provider units and independent signed net flows", async () => {
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response([primary, secondary]))
    .mockResolvedValueOnce(response([]));
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const observation = await source.fetchDatedMoneyFlow(request);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      api_name: "moneyflow", token: "fixture", params: { trade_date: "20240903" }, fields: fields.join(","),
    });
    const missing = { buyVolumeHand: null, buyAmount: null, sellVolumeHand: null, sellAmount: null };
    expect(observation).toEqual({
      source: "tushare", endpoint: "moneyflow", market: "A", observedAt: expect.any(String), coverage: "unknown",
      data: {
        tradeDate: request.tradeDate, volumeUnit: "hand", amountUnit: "CNY-ten-thousand",
        rows: [
          {
            symbol: "600001.SH",
            small: { buyVolumeHand: 0, buyAmount: 0, sellVolumeHand: 20, sellAmount: 2.23 },
            medium: { buyVolumeHand: 45, buyAmount: 4.56, sellVolumeHand: 46, sellAmount: 4.67 },
            large: { buyVolumeHand: 58, buyAmount: 5.89, sellVolumeHand: 61, sellAmount: 6.12 },
            extraLarge: { buyVolumeHand: 75, buyAmount: 7.51, sellVolumeHand: 78, sellAmount: 7.88 },
            netVolumeHand: -17, netAmount: -11.93,
          },
          {
            symbol: "000001.SZ", small: missing, medium: missing, large: missing, extraLarge: missing,
            netVolumeHand: null, netAmount: null,
          },
        ],
      },
    });
    const empty = await source.fetchDatedMoneyFlow({ ...request, tradeDate: "2024-09-02" });
    expect(empty.data).toEqual({ tradeDate: "2024-09-02", volumeUnit: "hand", amountUnit: "CNY-ten-thousand", rows: [] });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).params).toEqual({ trade_date: "20240902" });
    expect(getMarketDataCapabilities("tushare").observations.fetchDatedMoneyFlow).toEqual({ status: "implemented", markets: ["A"] });
    expect(getMarketDataCapabilities("tickflow").observations.fetchDatedMoneyFlow).toEqual({ status: "not-implemented" });
  } finally { fetcher.mockRestore(); }
});

test("rejects foreign, duplicate, malformed or saturated responses and never falls back", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    const source = createMarketDataSource({ source: "tushare", apiKey: "fixture", env: {} });
    const malformed = [
      [primary.with(0, "000001.SH")],
      [primary.with(0, "920001.BJ")],
      [primary.with(1, "20240902")],
      [primary, primary],
      [primary.slice(0, -1)],
      [primary.with(2, 1.25)],
      [primary.with(2, -1)],
      [primary.with(3, -0.01)],
      [primary.with(3, "9.12")],
      [primary.with(18, Number.MAX_SAFE_INTEGER + 1)],
      Array.from({ length: 6000 }, (_, index) => primary.with(0, (601000 + index) + ".SH")),
    ];
    for (const items of malformed) {
      fetcher.mockResolvedValueOnce(response(items));
      await expect(source.fetchDatedMoneyFlow(request)).rejects.toThrow();
    }
    fetcher.mockResolvedValueOnce(new Response("permission required", { status: 403 }));
    await expect(source.fetchDatedMoneyFlow(request)).rejects.toMatchObject({ code: "provider-failure" });
    for (const tradeDate of ["2009-12-31", "2024-02-30", "9999-01-01"]) {
      await expect(source.fetchDatedMoneyFlow({ ...request, tradeDate })).rejects.toThrow("Invalid money-flow trade date");
    }
    await expect(source.fetchDatedMoneyFlow({ ...request, market: "HK" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createMarketDataSource({ source: "tickflow" }).fetchDatedMoneyFlow(request))
      .rejects.toMatchObject({ code: "unsupported" });
    await expect(source.fetchDatedMoneyFlow(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(malformed.length + 1);
  } finally { fetcher.mockRestore(); }
});

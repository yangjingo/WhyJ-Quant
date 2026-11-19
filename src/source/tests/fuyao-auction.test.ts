import { expect, spyOn, test } from "bun:test";
import { fetchDatedAuctionBenchmark } from "../index.ts";

const date = "2026-08-14";
const connection = { env: { WHYJ_QUANT_FUYAO_API_KEY: "fixture" } };
const timestamp = Date.parse("2026-08-14T09:26:00+08:00");
const dateMs = Date.parse("2026-08-14T00:00:00+08:00");
const stock = { thscode: "000001.SZ", ticker: "000001", name: "示例 A", auction_pct: 0, tags: ["人气", "起量"] };
const second = { thscode: "920116.BJ", ticker: "920116", name: "示例 B", auction_pct: null, tags: [] };
const third = { thscode: "600519.SH", ticker: "600519", name: "示例 C", auction_pct: 0.35, tags: ["高开"] };
const responseData = { date, date_ms: dateMs, timestamp, item: [stock, second, third] };
const success = (data: Record<string, unknown> = responseData) => Response.json({ code: 0, data });

test("reads the exact date with Fuyao credentials and retains native observations", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValueOnce(success());
  try {
    const result = await fetchDatedAuctionBenchmark(date, connection);
    expect(request.mock.calls[0]?.[0]).toBe(`https://fuyao.aicubes.cn/api/a-share/auction/short-term-benchmark?date=${date}`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-api-key": "fixture" }, redirect: "error" });
    expect(result).toEqual({
      source: "fuyao", endpoint: "/api/a-share/auction/short-term-benchmark", market: "A",
      tradeDate: date, calendarTimeZone: "Asia/Shanghai", tradeDateTimestamp: dateMs,
      responseAssembledAt: timestamp, observedAt: expect.any(String), coverage: "unknown",
      returnUnit: "percentage-points",
      rows: [
        { symbol: "000001.SZ", name: "示例 A", auctionReturnPct: 0, tags: ["人气", "起量"] },
        { symbol: "920116.BJ", name: "示例 B", auctionReturnPct: null, tags: [] },
        { symbol: "600519.SH", name: "示例 C", auctionReturnPct: 0.35, tags: ["高开"] },
      ],
    });
    request.mockResolvedValueOnce(success({ ...responseData, item: [] }));
    expect(await fetchDatedAuctionBenchmark(date, connection)).toMatchObject({ tradeDate: date, source: "fuyao", rows: [] });
    expect(request).toHaveBeenCalledTimes(2);
  } finally { request.mockRestore(); }
});

test("rejects foreign dates, duplicate or ambiguous stocks, denial and malformed payloads without fallback", async () => {
  const request = spyOn(globalThis, "fetch");
  try {
    const invalidRows = [
      [stock, stock],
      [{ ...stock, thscode: "000001.SH" }],
      [{ ...stock, ticker: "600519" }],
      [{ ...stock, auction_pct: "0.35" }],
      [{ ...stock, tags: [5] }],
    ];
    for (const data of [
      { ...responseData, date: "2026-08-13" },
      { ...responseData, date_ms: dateMs + 1 },
      { ...responseData, timestamp: dateMs - 1 },
      ...invalidRows.map(item => ({ ...responseData, item })),
    ]) {
      request.mockResolvedValueOnce(success(data));
      await expect(fetchDatedAuctionBenchmark(date, connection)).rejects.toMatchObject({
        code: "provider-failure", message: "Invalid Fuyao auction benchmark response",
      });
    }

    request.mockResolvedValueOnce(Response.json({ code: 1002, message: "private provider detail" }));
    await expect(fetchDatedAuctionBenchmark(date, connection)).rejects.toMatchObject({
      code: "provider-failure", message: "Invalid Fuyao auction benchmark response",
    });
    request.mockResolvedValueOnce(new Response("private provider detail", { status: 403 }));
    await expect(fetchDatedAuctionBenchmark(date, connection)).rejects.toMatchObject({
      code: "provider-failure", message: "Fuyao auction benchmark request failed",
    });
    request.mockResolvedValueOnce(new Response(" ".repeat(256 * 1024 + 1)));
    await expect(fetchDatedAuctionBenchmark(date, connection)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(fetchDatedAuctionBenchmark("2026-02-30", connection)).rejects.toThrow("Invalid Fuyao auction trade date");
    await expect(fetchDatedAuctionBenchmark(date, { env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture" } }))
      .rejects.toThrow("WHYJ_QUANT_FUYAO_API_KEY is not configured");
    await expect(fetchDatedAuctionBenchmark(date, { ...connection, baseUrl: "http://fuyao.example" })).rejects.toThrow("Invalid Fuyao base URL");
    expect(request).toHaveBeenCalledTimes(invalidRows.length + 6);
  } finally { request.mockRestore(); }
});

test("applies the deadline and preserves caller cancellation", async () => {
  const stall = (...[, init]: Parameters<typeof fetch>): Promise<Response> => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(stall, { preconnect: fetch.preconnect }));
  try {
    await expect(fetchDatedAuctionBenchmark(date, connection, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const pending = fetchDatedAuctionBenchmark(date, connection, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(2);
  } finally { request.mockRestore(); }
});

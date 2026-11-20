import { expect, spyOn, test } from "bun:test";
import { fetchDatedPopularityList } from "../index.ts";

const date = "2026-06-21"; // Sunday in Shanghai.
const dateMs = 1_781_971_200_000;
const connection = { env: { WHYJ_QUANT_FUYAO_API_KEY: "popularity-fixture" } };
const first = { thscode: "000725.SZ", ticker: "000725", name: "样本甲", rank: 3 };
const second = { thscode: "600519.SH", ticker: "600519", name: "样本乙", rank: 1 };
const responseData = { date, date_ms: dateMs, item: [first, second] };
const success = (data: Record<string, unknown> = responseData) => Response.json({ code: 0, data });
const fullList = Array.from({ length: 30 }, (_, i) => {
  const ticker = String(600510 + i);
  return { thscode: ticker + ".SH", ticker, name: "Sample " + i, rank: i + 1 };
});

test("captures an exact Shanghai calendar date, retaining provider ranks and independent clock metadata", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(success())
    .mockResolvedValueOnce(success({ ...responseData, item: [] }))
    .mockResolvedValueOnce(success({ ...responseData, item: fullList }));
  try {
    const before = Date.now();
    const list = await fetchDatedPopularityList(date, connection);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://fuyao.aicubes.cn/api/a-share/special-data/hot-stock-list-history?date=" + date);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-api-key": "popularity-fixture" }, redirect: "error" });
    expect(list).toEqual({
      source: "fuyao", endpoint: "/api/a-share/special-data/hot-stock-list-history", market: "A",
      calendarDate: date, calendarTimeZone: "Asia/Shanghai", calendarDateTimestamp: dateMs,
      observedAt: expect.any(String), coverage: "unknown",
      rows: [
        { symbol: "000725.SZ", ticker: "000725", name: "样本甲", rank: 3 },
        { symbol: "600519.SH", ticker: "600519", name: "样本乙", rank: 1 },
      ],
    });
    expect(Date.parse(list.observedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(list.observedAt)).toBeLessThanOrEqual(Date.now());
    expect((await fetchDatedPopularityList(date, connection)).rows).toEqual([]);
    expect((await fetchDatedPopularityList(date, connection)).rows).toHaveLength(30);
  } finally { fetcher.mockRestore(); }
});

test("rejects mismatched dates, malformed ranks, provider denials and oversized history without fallback", async () => {
  const fetcher = spyOn(globalThis, "fetch");
  try {
    for (const data of [
      { ...responseData, date: "2026-06-20" },
      { ...responseData, date_ms: dateMs + 28_800_000 },
      { ...responseData, item: [first, first] },
      { ...responseData, item: [{ ...first, thscode: "000001.SH" }] },
      { ...responseData, item: [{ ...first, ticker: "600519" }] },
      { ...responseData, item: [{ ...first, name: " " }] },
      { ...responseData, item: [{ ...first, rank: 0 }] },
      { ...responseData, item: [{ ...first, rank: 1.2 }] },
      { ...responseData, item: [...fullList, first] },
    ]) {
      fetcher.mockResolvedValueOnce(success(data));
      await expect(fetchDatedPopularityList(date, connection)).rejects.toMatchObject({
        code: "provider-failure", message: "Invalid Fuyao historical popularity response",
      });
    }
    fetcher.mockResolvedValueOnce(Response.json({ code: 1003, message: "private details" }));
    await expect(fetchDatedPopularityList(date, connection)).rejects.toMatchObject({
      code: "provider-failure", message: "Fuyao popularity date is outside provider history",
    });
    fetcher.mockResolvedValueOnce(Response.json({ code: 2001, message: "private details" }));
    await expect(fetchDatedPopularityList(date, connection)).rejects.toMatchObject({
      code: "provider-failure", message: "Invalid Fuyao historical popularity response",
    });
    fetcher.mockResolvedValueOnce(new Response("private details", { status: 403 }));
    await expect(fetchDatedPopularityList(date, connection)).rejects.toMatchObject({
      code: "provider-failure", message: "Fuyao historical popularity request failed",
    });
    fetcher.mockResolvedValueOnce(new Response(" ".repeat(64 * 1024 + 1)));
    await expect(fetchDatedPopularityList(date, connection)).rejects.toMatchObject({ code: "provider-failure" });
    for (const invalid of ["2026-02-30", "0000-01-01", "9999-01-01"]) {
      await expect(fetchDatedPopularityList(invalid, connection)).rejects.toThrow("Invalid Fuyao popularity calendar date");
    }
    await expect(fetchDatedPopularityList(date, { env: {} })).rejects.toThrow("WHYJ_QUANT_FUYAO_API_KEY is not configured");
    await expect(fetchDatedPopularityList(date, connection, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(13);
  } finally { fetcher.mockRestore(); }
});

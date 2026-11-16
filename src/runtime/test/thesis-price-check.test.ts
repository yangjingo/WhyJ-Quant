import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { saveBars } from "../../storage/index.ts";
import { fetchBars } from "../data/source-runtime.ts";
import type { BarsFetchResult } from "../../source/index.ts";
import type { ThesisPriceReference } from "../../types/thesis-price-check.ts";
import { collectThesisPriceCheck, compareThesisPrices } from "../research/thesis-price-check.ts";

const request = { symbol: "600000.SH", start: "2020-01-02", end: "2020-01-03" };
const bars = ["2020-01-02", "2020-01-03"].map(date => ({ date, open: 10, high: 12, low: 9, close: 11, volume: 100, amount: null }));
const reference: ThesisPriceReference = { ...request, adjustment: "forward-adjusted", observedAt: "2020-01-04T00:00:00.000Z",
  rows: bars.map(({ date, open, high, low, close }) => ({ date, open, high, low, close })) };
let root: string, previous: string | undefined, result: BarsFetchResult;
beforeEach(async () => {
  previous = process.env.OHQUANT_DIR; root = mkdtempSync(join(tmpdir(), "whyj-thesis-price-")); process.env.OHQUANT_DIR = root;
  const dataset = (await saveBars(request.symbol, "akshare", bars, request.start, request.end, undefined, "stock_zh_a_hist", "forward-adjusted"))!;
  result = { bars, source: "akshare", origin: "provider", asOfDate: request.end, dataset, attempts: [] };
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR; else process.env.OHQUANT_DIR = previous;
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root");
  rmSync(root, { recursive: true, force: true });
});
const collect = () => collectThesisPriceCheck(request, { fetch: async () => result });

it("uses the real configured-source chain and checks its immutable rows without a second provider", async () => {
  let calls = 0, preferred = 0;
  const checked = await collectThesisPriceCheck(request, { fetch: (symbol, market, start, end, source, options) => {
    expect(source).toBeUndefined(); expect(options?.providers?.budgetMs).toBe(20_000);
    return fetchBars(symbol, market, start, end, source, { deps: {
      getPreferredSource: () => { preferred++; return "akshare"; }, loadCache: async () => ({ bars: [], fresh: false }), saveBars,
    }, providers: { ...options?.providers, adapters: { akshare: { fetchBars: async received => {
      calls++; expect(received).toMatchObject(request); return { bars, endpoint: "stock_zh_a_hist", adjustment: "forward-adjusted" };
    } } }, fallbackOrder: { A: ["akshare"] } } });
  } });
  expect(calls).toBe(1); expect(preferred).toBeGreaterThan(0);
  expect(checked).toMatchObject({ status: "available", source: "akshare", origin: "provider", bars });
  const comparison = compareThesisPrices(reference, checked);
  expect(comparison.outcome).toBe("matching"); expect(comparison.comparedDates).toEqual(bars.map(bar => bar.date));
  expect(comparison.reason).toContain("不证明上游独立");
});

it("shows exact OHLC disagreement without treating either source as financial truth", async () => {
  const changed = { ...reference, rows: reference.rows.map(row => ({ ...row, close: 10.9 })) };
  const comparison = compareThesisPrices(changed, await collect());
  expect(comparison.outcome).toBe("different"); expect(comparison.differences).toHaveLength(2);
  expect(comparison.differences[0]).toEqual({ date: request.start, field: "close", reference: 10.9, checked: 11 });
  expect(comparison.reason).toContain("复权因子变化");
});

it("does not certify stale cache, mismatched adjustment or different trading dates", async () => {
  result = { ...result, origin: "stale-cache" };
  expect(compareThesisPrices(reference, await collect()).outcome).toBe("incomparable");
  result = { ...result, origin: "cache" };
  const checked = await collect();
  expect(compareThesisPrices({ ...reference, adjustment: "unadjusted" }, checked).outcome).toBe("incomparable");
  expect(compareThesisPrices({ ...reference, adjustment: "provider-unspecified" }, checked).outcome).toBe("incomparable");
  const comparison = compareThesisPrices({ ...reference, rows: reference.rows.slice(1) }, checked);
  expect(comparison.outcome).toBe("incomparable"); expect(comparison.missingDates).toEqual([request.start]);
  expect(compareThesisPrices({ ...reference, observedAt: "2020-01-03T00:00:00.000Z" }, checked).outcome).toBe("incomparable");
  expect(compareThesisPrices({ ...reference, observedAt: "2099-01-01T00:00:00.000Z" }, checked).outcome).toBe("incomparable");
});

it("rejects changed rows, foreign identity and missing/corrupt archive instead of using unpinned data", async () => {
  const original = result;
  result = { ...original, bars: original.bars.map(row => ({ ...row, close: 10 })) };
  expect((await collect()).status).toBe("unavailable");
  result = { ...original, dataset: { ...original.dataset!, symbol: "000001.SZ" } };
  expect((await collect()).status).toBe("unavailable");
  result = { ...original, dataset: undefined }; expect((await collect()).status).toBe("unavailable");
  result = original;
  const missing = await collectThesisPriceCheck(request, { fetch: async () => result, resolveDataset: () => { throw new Error("private path or token"); } });
  expect(missing.status).toBe("unavailable"); expect(JSON.stringify(missing)).not.toContain("private path or token");
  expect(compareThesisPrices(reference, missing).outcome).toBe("unavailable");
});

it("does not repair malformed reference or checked prices into agreement", async () => {
  const checked = await collect(); expect(checked.status).toBe("available"); if (checked.status !== "available") throw new Error();
  expect(compareThesisPrices({ ...reference, rows: [reference.rows[0]!, reference.rows[0]!] }, checked).outcome).toBe("incomparable");
  expect(compareThesisPrices(reference, { ...checked, bars: checked.bars.map(row => ({ ...row, close: NaN })) }).outcome).toBe("incomparable");
  expect(compareThesisPrices(reference, { ...checked, symbol: "000001.SZ" }).outcome).toBe("incomparable");
  expect(compareThesisPrices(reference, { ...checked, dataset: { ...checked.dataset, source: "foreign" } }).outcome).toBe("incomparable");
});

it("rejects invalid or unfinished windows before dispatch and propagates cancellation", async () => {
  let calls = 0; const fetch: typeof fetchBars = async () => { calls++; return result; };
  for (const invalid of [{ ...request, symbol: "AAPL" }, { ...request, start: "2020-02-31" }, { ...request, end: "2022-01-01" },
    { ...request, start: "2099-01-01", end: "2099-01-02" }]) {
    await expect(collectThesisPriceCheck(invalid, { fetch })).rejects.toThrow();
  }
  const controller = new AbortController(); controller.abort();
  await expect(collectThesisPriceCheck(request, { fetch, signal: controller.signal })).rejects.toThrow(); expect(calls).toBe(0);
  const running = new AbortController();
  await expect(collectThesisPriceCheck(request, { signal: running.signal, fetch: async () => { running.abort(); return result; } })).rejects.toThrow();
});

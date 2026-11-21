import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTradingDateObservations, loadPanelPortfolio, savePanelPortfolio, type StoredTradingDateBarObservation } from "../../storage/index.ts";
import { replayTspWatchlistReturn } from "../data/watchlist-return.ts";

const symbol = "600519.SH";
const asOf = "2024-03-04";
const added = "2024-03-02";
const requested = { startDate: "2024-03-01", endDate: "2024-03-05" };
const dated = (tradeDate: string, close: number, adjustment: "forward" | "none" = "forward"): StoredTradingDateBarObservation => ({
  schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate,
  sourceTimestamp: Date.parse(tradeDate + "T15:00:00+08:00"), requested, market: "A", assetType: "stock",
  calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines", observedAt: "2024-03-06T02:00:00Z",
  interval: "1d", adjustment, volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
  values: { open: close, high: close, low: close, close, volume: 0, amount: null },
});

let root: string;
let original: string | undefined;
beforeEach(() => {
  original = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-watchlist-return-runtime-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (original === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = original;
  rmSync(root, { recursive: true, force: true });
});
function membership(code: string, date: string, instrument: "security" | "fund" = "security") {
  savePanelPortfolio({ ...loadPanelPortfolio(), symbols: [{ code, name: "sample", added: date, instrument }] });
  return loadPanelPortfolio().revision!;
}

test("joins a legacy saved selection to its exact stock revision without changing either input", async () => {
  const revision = membership("600519", added);
  const ref = await archiveTradingDateObservations([dated("2024-03-01", 10), dated(asOf, 11), dated("2024-03-05", 19)]);
  const first = await replayTspWatchlistReturn({ ref, asOf, membershipRevision: revision });
  expect(first.input.membership).toEqual({ producer: "workspace", revision, code: "600519", addedAt: added });
  expect(first.input.history).toMatchObject({ symbol, ref, source: "tickflow", requested, coverage: "unknown" });
  expect(first.metrics).toMatchObject({ status: "available", addedDate: added,
    baseline: { tradeDate: "2024-03-01", close: 10 }, latest: { tradeDate: asOf, close: 11 } });
  expect(first.metrics.pctSinceAdded).toBeCloseTo(0.1, 12);
  expect(await replayTspWatchlistReturn({ ref, asOf, membershipRevision: revision })).toEqual(first);
  expect(loadPanelPortfolio().revision).toBe(revision);
  membership(symbol, asOf);
  await expect(replayTspWatchlistReturn({ ref, asOf, membershipRevision: revision })).rejects.toThrow("revision changed");
  expect((await replayTspWatchlistReturn({ ref, asOf })).metrics.pctSinceAdded).toBe(0);
});

test("distinguishes missing baseline from incompatible history or missing stock membership", async () => {
  const ref = await archiveTradingDateObservations([dated(asOf, 11)]);
  await expect(replayTspWatchlistReturn({ ref, asOf })).rejects.toThrow("absent");
  membership(symbol, added, "fund");
  await expect(replayTspWatchlistReturn({ ref, asOf })).rejects.toThrow("absent");
  membership(symbol, added);
  expect((await replayTspWatchlistReturn({ ref, asOf })).metrics).toMatchObject({ status: "missing-baseline", pctSinceAdded: null });
  await expect(replayTspWatchlistReturn({ ref, asOf: "2024-03-06" })).rejects.toThrow("covering the requested cutoff");
  const raw = await archiveTradingDateObservations([dated(asOf, 11, "none")]);
  await expect(replayTspWatchlistReturn({ ref: raw, asOf })).rejects.toThrow("forward-adjusted");
  await expect(replayTspWatchlistReturn({ ref, asOf }, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});
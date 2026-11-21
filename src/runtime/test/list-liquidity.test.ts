import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, type StoredMarketCrossSection } from "../../storage/index.ts";
import { replayTspListLiquidity } from "../data/list-liquidity.ts";

test("replays one dated stock with distinct Tushare and WhyJ evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-liquidity-"));
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const symbol = "600519.SH", tradeDate = "2024-03-04";
  const metadata = { tradeDate, observedAt: "2024-03-05T03:00:00Z", coverage: "unknown" } as const;
  const snapshot: StoredMarketCrossSection = {
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [
      { symbol: "600000.SH", name: "no observations", industry: null, listedOn: null },
      { symbol, name: "fixture", industry: null, listedOn: null },
    ] },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
      amountUnit: "CNY-thousand", rows: [
        { symbol, open: 10, high: 11, low: 10, close: 10.5, exRightsPreviousClose: null,
          changeCny: null, returnPct: null, volume: 750, amount: null },
      ] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [
        { symbol, close: 10.4, turnoverPct: 4, freeFloatTurnoverPct: 7, providerVolumeRatio: null,
          totalShares: 400, floatShares: 250, freeFloatShares: 100, pe: null, peTtm: null, pb: null,
          totalMarketValue: null, circulatingMarketValue: 2_600 },
      ] },
  };
  try {
    const ref = await archiveMarketCrossSection(snapshot);
    expect(await replayTspListLiquidity(ref, symbol)).toMatchObject({
      archiveRef: ref, symbol, tradeDate, market: "A",
      observations: {
        producer: "tushare",
        daily: { endpoint: "daily", adjustment: "none", volumeUnit: "hand", row: { close: 10.5, volume: 750 } },
        dailyBasic: { endpoint: "daily_basic", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand",
          row: { close: 10.4, turnoverPct: 4, circulatingMarketValue: 2_600 } },
      },
      metrics: { producer: "whyj", formula: { id: "tsp_list_liquidity", version: 1 },
        floatValueCny: 26_250_000, turnoverPct: 3 },
    });
    expect(await replayTspListLiquidity(ref, "600000.SH")).toMatchObject({
      observations: { daily: { row: null }, dailyBasic: { row: null } },
      metrics: { floatValueCny: null, turnoverPct: null },
    });
    snapshot.bars.rows[0]!.volume = 0;
    const corrected = await archiveMarketCrossSection(snapshot);
    expect((await replayTspListLiquidity(corrected, symbol)).metrics.turnoverPct).toBe(0);
    expect((await replayTspListLiquidity(ref, symbol)).metrics.turnoverPct).toBe(3);
    await expect(replayTspListLiquidity(ref, "600001.SH")).rejects.toThrow("absent from the archived roster");
    await expect(replayTspListLiquidity({ ...ref, revision: "invalid" }, symbol)).rejects.toThrow();
    await expect(replayTspListLiquidity(ref, symbol, AbortSignal.abort())).rejects.toThrow();
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveRiskWarningObservations, archiveSectorObservations } from "../../storage/index.ts";
import { replayTspMarketMainline } from "../data/market-mainline-replay.ts";

const sessions = ["2025-01-02", "2025-01-03", "2025-01-06"] as const;
const observedAt = "2025-01-07T03:00:00Z";
const symbols = Array.from({ length: 6 }, (_, index) => `${600001 + index}.SH`);
const sectorCode = "BK1000.DC", uncollected = "BK2000.DC";

function snapshot(tradeDate: string, seal: boolean) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({ source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, industry: null, listedOn: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.map((symbol, index) => ({ symbol, open: 10, high: seal ? 11 : 10, low: 10, close: seal ? 11 : 10,
        exRightsPreviousClose: 10, changeCny: seal ? 1 : 0, returnPct: seal ? 10 : 0, volume: 10, amount: index + 1 })) },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

async function sector(tradeDate: string, kind: "concept" | "industry" = "concept") {
  const meta = { market: "A", source: "tushare", tradeDate, observedAt, coverage: "unknown", taxonomy: "eastmoney" } as const;
  const catalogRef = await archiveSectorObservations({ ...meta, endpoint: "dc_index", kind, providerType: kind === "concept" ? "概念板块" : "行业板块",
    groups: [{ code: sectorCode, name: "Fixture", level: null }, { code: uncollected, name: "Uncollected", level: null }] });
  const membership = await archiveSectorObservations({ ...meta, endpoint: "dc_member", sectorCode,
    members: symbols.map(symbol => ({ symbol, name: null })) });
  return { tradeDate, catalogRef, memberRefs: [membership] };
}

async function fixture() {
  const marketRefs = await Promise.all([snapshot(sessions[0], false), snapshot(sessions[1], true)]);
  const limitRefs = await Promise.all(symbols.map(symbol => archiveDailyTradingLimits({ source: "tushare", market: "A", endpoint: "stk_limit",
    symbol, observedAt, coverage: "unknown", priceUnit: "CNY", requested: { startDate: sessions[0], endDate: sessions[1] },
    rows: sessions.slice(0, 2).map(tradeDate => ({ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 })),
  })));
  return { sessions, marketRefs, limitRefs, sectorHistory: [await sector(sessions[1])] };
}

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-mainline-replay-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("ranks all dated observed stocks and preserves coverage when a group archive is missing", async () => {
  const request = await fixture();
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Archive replay must stay offline"));
  try {
    const result = await replayTspMarketMainline(request);
    expect(result.scope).toEqual({ kind: "concept", taxonomy: "eastmoney", source: "tushare" });
    expect(result.rows.map(row => [row.tradingDate, row.status])).toEqual([
      [sessions[0], "missing-membership"], [sessions[1], "computed"], [sessions[2], "missing-market"],
    ]);
    const day = result.rows[1]!;
    expect(day.input.sector).toMatchObject({ catalogRef: request.sectorHistory[0]?.catalogRef,
      coverage: { catalogGroups: 2, archivedGroups: 1, uncollectedGroupIds: [uncollected] } });
    expect(day.mainline?.rows).toMatchObject([{ name: "Fixture", limitUpCount: 6, boardsSum: 6,
      leaderSymbol: symbols[5], leaderAmountCny: 6_000, rank: 1 }]);
    expect(result.input.tradingLimits).toHaveLength(6);
    expect(await replayTspMarketMainline(request)).toEqual(result);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

test("applies the exact risk date, preserves gaps and rejects mismatched sector scopes", async () => {
  const request = await fixture();
  const risk = await archiveRiskWarningObservations({ source: "tushare", market: "A", endpoint: "stock_st", tradeDate: sessions[1],
    coverage: "unknown", observedAt, rows: [{ symbol: symbols[5]!, name: "ST fixture", type: "ST", typeName: "风险警示板" }] });
  const filtered = await replayTspMarketMainline({ ...request, riskWarningRefs: [risk] });
  expect(filtered.rows[0]?.status).toBe("missing-risk-warnings");
  expect(filtered.rows[1]).toMatchObject({ status: "computed", input: { riskWarnings: { excludedSymbols: [symbols[5]] } },
    mainline: { rows: [{ limitUpCount: 5, leaderSymbol: symbols[4], leaderAmountCny: 5_000 }] } });
  const missing = await replayTspMarketMainline({ ...request,
    sectorHistory: [{ ...request.sectorHistory[0]!, memberRefs: [] }] });
  expect(missing.rows[1]).toMatchObject({ status: "missing-membership", mainline: null,
    input: { sector: { coverage: { catalogGroups: 2, archivedGroups: 0 } } } });
  await expect(replayTspMarketMainline({ ...request, sectorHistory: [request.sectorHistory[0]!, request.sectorHistory[0]!] }))
    .rejects.toThrow("Duplicate or off-calendar");
  await expect(replayTspMarketMainline({ ...request, sectorHistory: [{ ...request.sectorHistory[0]!, tradeDate: sessions[0] }] }))
    .rejects.toThrow("Sector catalog does not match");
  await expect(replayTspMarketMainline({ ...request, sectorHistory: [await sector(sessions[0], "industry"), request.sectorHistory[0]!] }))
    .rejects.toThrow("Incompatible market mainline sector scope");
});

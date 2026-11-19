import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMarketCrossSection, archiveSectorObservations } from "../../storage/index.ts";
import { replayTspSectorRotation } from "../data/sector-rotation.ts";

const groupCodes = ["BK1000.DC", "BK2000.DC", "BK3000.DC"];
const symbols = ["000001.SZ", "600000.SH"];

async function capture(tradeDate: string, returns: readonly (number | null)[], kind: "industry" | "concept" = "concept") {
  const scope = { tradeDate, market: "A", source: "tushare" } as const;
  const source = { tradeDate, observedAt: "2025-04-01T02:00:00Z", coverage: "unknown" } as const;
  const sector = { ...scope, ...source, taxonomy: "eastmoney" } as const;
  const marketRef = await archiveMarketCrossSection({ ...scope,
    universe: { ...source, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, industry: null, listedOn: null })) },
    bars: { ...source, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.map((symbol, index) => {
        const returnPct = returns[index] ?? null;
        const close = 10 * (1 + (returnPct ?? 0) / 100);
        return { symbol, open: 10, high: Math.max(10, close), low: Math.min(10, close), close,
          exRightsPreviousClose: 10, changeCny: returnPct === null ? null : close - 10, returnPct, volume: 2, amount: 2 };
      }) },
    basics: { ...source, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
  const catalogRef = await archiveSectorObservations({ ...sector, endpoint: "dc_index", kind,
    providerType: kind === "concept" ? "概念板块" : "行业板块",
    groups: groupCodes.map((code, index) => ({ code, name: `Group ${index}`, level: null })) });
  const memberRefs = await Promise.all(symbols.map((symbol, index) => archiveSectorObservations({
    ...sector, endpoint: "dc_member", sectorCode: groupCodes[index]!, members: [{ symbol, name: null }],
  })));
  return { marketRef, catalogRef, memberRefs };
}

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-sector-rotation-"));
  process.env.OHQUANT_DIR = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

test("replays sector ranks across exact market dates offline with per-date capture evidence", async () => {
  const first = await capture("2025-01-02", [3, -2]);
  const second = await capture("2025-01-03", [0, 5]);
  const empty = await capture("2025-01-06", [null, null]);
  const latest = await capture("2025-01-07", [7, 2]);
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
  try {
    const result = await replayTspSectorRotation([second, latest, first, empty]);
    expect(result.producer).toBe("whyj");
    expect(result.formula).toMatchObject({ id: "tsp_sector_rotation", version: 1 });
    expect(result.columns.map(({ tradingDate, rows }) => [tradingDate, rows.map(row => [row.id, row.rank, row.rankMovement])])).toEqual([
      ["2025-01-07", [[groupCodes[0], 1, null], [groupCodes[1], 2, null]]],
      ["2025-01-03", [[groupCodes[1], 1, 1], [groupCodes[0], 2, -1]]],
      ["2025-01-02", [[groupCodes[0], 1, null], [groupCodes[1], 2, null]]],
    ]);
    expect(result.input.sessions[2]).toMatchObject({ tradingDate: "2025-01-06", comparableGroups: 0, archives: {
      marketRef: empty.marketRef, catalogRef: empty.catalogRef,
      membershipRefs: empty.memberRefs.map((ref, index) => ({ ref, sectorCode: groupCodes[index] })),
      coverage: { archivedGroups: 2, uncollectedGroupIds: [groupCodes[2]] },
    } });
    expect(await replayTspSectorRotation([first, second, empty, latest])).toEqual(result);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

test("fails on duplicate dates, incompatible sector scope, missing archive and cancellation", async () => {
  const first = await capture("2025-01-02", [3, -2]);
  const second = await capture("2025-01-03", [-1, 5], "industry");
  await expect(replayTspSectorRotation([first, first])).rejects.toThrow("Incompatible or duplicate");
  await expect(replayTspSectorRotation([first, second])).rejects.toThrow("Incompatible or duplicate");
  await expect(replayTspSectorRotation([first, { ...second, marketRef: { ...second.marketRef, revision: "f".repeat(64) } }])).rejects.toThrow();
  await expect(replayTspSectorRotation([first], undefined, AbortSignal.abort(new Error("Cancelled rotation")))).rejects.toThrow("Cancelled rotation");
});

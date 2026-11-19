import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveMarketCrossSection, archiveSectorObservations, type StoredMarketCrossSection, type StoredSectorObservationBatch,
} from "../../storage/index.ts";
import { replayTspSectorRanking } from "../data/sector-rank-replay.ts";

const tradeDate = "2025-01-02";
const marketIdentity = { source: "tushare", market: "A", tradeDate } as const;
const day = { tradeDate, coverage: "unknown" } as const;
const sectorIdentity = { ...marketIdentity, taxonomy: "eastmoney", coverage: "unknown" } as const;
const robotics = { code: "BK1000.DC", name: "Robotics", level: null };
const electric = { code: "BK2000.DC", name: "Electric", level: null };
const utilities = { code: "BK3000.DC", name: "Utilities", level: null };

function marketFixture(): StoredMarketCrossSection {
  return {
    ...marketIdentity,
    universe: { ...day, endpoint: "bak_basic", observedAt: "2025-01-03T02:00:00Z", universe: "provider-dated-stocks", members: [
      { symbol: "000001.SZ", name: "Rising", industry: null, listedOn: null },
      { symbol: "600000.SH", name: "Flat", industry: null, listedOn: null },
      { symbol: "873593.BJ", name: "Missing bar", industry: null, listedOn: null },
    ] },
    bars: { ...day, endpoint: "daily", observedAt: "2025-01-03T02:10:00Z", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
      amountUnit: "CNY-thousand", rows: [
        { symbol: "000001.SZ", open: 10, high: 10.5, low: 10, close: 10.5, exRightsPreviousClose: 10, changeCny: 0.5, returnPct: 5, volume: 2, amount: 2.5 },
        { symbol: "600000.SH", open: 10, high: 10, low: 10, close: 10, exRightsPreviousClose: 10, changeCny: 0, returnPct: 0, volume: 0, amount: 0 },
        { symbol: "600001.SH", open: 10, high: 10.9, low: 10, close: 10.9, exRightsPreviousClose: 10, changeCny: 0.9, returnPct: 9, volume: 10, amount: 999 },
      ] },
    basics: { ...day, endpoint: "daily_basic", observedAt: "2025-01-03T02:15:00Z", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [] },
  };
}

const catalog: StoredSectorObservationBatch = { ...sectorIdentity, endpoint: "dc_index", observedAt: "2025-01-04T02:00:00Z",
  kind: "concept", providerType: "概念板块", groups: [utilities, electric, robotics] };
const members: Extract<StoredSectorObservationBatch, { endpoint: "dc_member" }> = { ...sectorIdentity, endpoint: "dc_member",
  sectorCode: robotics.code, observedAt: "2025-01-05T07:00:00.137Z",
  members: ["600000.SH", "000001.SZ", "873593.BJ", "600001.SH"].map(symbol => ({ symbol, name: null })) };

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-sector-rank-replay-"));
  process.env.OHQUANT_DIR = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

test("ranks exact archived members offline, preserving amounts, absent bars and coverage", async () => {
  const empty = { ...members, sectorCode: electric.code, members: [], observedAt: "2025-01-05T09:00:00Z" };
  const [marketRef, catalogRef, roboticsRef, electricRef] = await Promise.all([
    archiveMarketCrossSection(marketFixture()), archiveSectorObservations(catalog), archiveSectorObservations(members), archiveSectorObservations(empty),
  ]);
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider I/O"));
  try {
    const input = { marketRef, catalogRef, memberRefs: [electricRef, roboticsRef] };
    const result = await replayTspSectorRanking(input);
    expect(result.producer).toBe("whyj");
    expect(result.tradingDate).toBe(tradeDate);
    expect(result.leading).toEqual([{ id: robotics.code, name: robotics.name, memberCount: 3, observedCount: 2, returnCount: 2,
      averageFraction: 0.025, upCount: 1, downCount: 0, amountCny: 2_500, amountCount: 2,
      leader: { symbol: "000001.SZ", name: "Rising", changeFraction: 0.05 } }]);
    expect(result.lagging).toEqual(result.leading);
    expect(result.groups[1]).toEqual({ id: electric.code, name: electric.name, memberCount: 0, observedCount: 0, returnCount: 0,
      averageFraction: null, upCount: 0, downCount: 0, amountCny: null, amountCount: 0, leader: null });
    expect(result.input).toEqual({ marketRef, catalogRef,
      membershipRefs: [{ sectorCode: robotics.code, ref: roboticsRef }, { sectorCode: electric.code, ref: electricRef }],
      market: { source: "tushare", universeEndpoint: "bak_basic", universeObservedAt: "2025-01-03T02:00:00Z",
        priceEndpoint: "daily", priceObservedAt: "2025-01-03T02:10:00Z", coverage: "unknown", storedAmountUnit: "CNY-thousand" },
      coverage: { catalogGroups: 3, archivedGroups: 2, uncollectedGroupIds: [utilities.code] },
    });
    expect(result.membership).toEqual({ kind: "concept", taxonomy: "eastmoney", source: "tushare", revision: catalogRef.revision,
      basis: "provider-dated-snapshot", tradeDate, observedAt: catalog.observedAt, coverage: "unknown", groups: [
        { id: robotics.code, revision: roboticsRef.revision, observedAt: members.observedAt },
        { id: electric.code, revision: electricRef.revision, observedAt: empty.observedAt },
      ] });
    expect(await replayTspSectorRanking({ ...input, memberRefs: input.memberRefs.toReversed() })).toEqual(result);
    const omitted = await replayTspSectorRanking({ ...input, memberRefs: [] });
    expect(omitted.groups).toEqual([]);
    expect(omitted.input.coverage).toEqual({ catalogGroups: 3, archivedGroups: 0, uncollectedGroupIds: [robotics.code, electric.code, utilities.code] });
    expect(http).not.toHaveBeenCalled();
  } finally { http.mockRestore(); }
});

test("rejects cross-date, foreign, duplicate, corrupted and cancelled replay inputs", async () => {
  const [marketRef, catalogRef, memberRef, wrongCatalog, wrongMember, foreign, correction] = await Promise.all([
    archiveMarketCrossSection(marketFixture()), archiveSectorObservations(catalog), archiveSectorObservations(members),
    archiveSectorObservations({ ...catalog, tradeDate: "2025-01-03" }), archiveSectorObservations({ ...members, tradeDate: "2025-01-03" }),
    archiveSectorObservations({ ...members, sectorCode: "BK9999.DC" }), archiveSectorObservations({ ...members, members: [] }),
  ]);
  const input = { marketRef, catalogRef, memberRefs: [memberRef] };
  await expect(replayTspSectorRanking({ ...input, catalogRef: wrongCatalog })).rejects.toThrow("catalog does not match");
  await expect(replayTspSectorRanking({ ...input, catalogRef: memberRef })).rejects.toThrow("catalog does not match");
  await expect(replayTspSectorRanking({ ...input, memberRefs: [catalogRef] })).rejects.toThrow("membership does not match");
  await expect(replayTspSectorRanking({ ...input, memberRefs: [wrongMember] })).rejects.toThrow("membership does not match");
  await expect(replayTspSectorRanking({ ...input, memberRefs: [foreign] })).rejects.toThrow("Foreign or duplicate");
  await expect(replayTspSectorRanking({ ...input, memberRefs: [memberRef, correction] })).rejects.toThrow("Foreign or duplicate");
  await expect(replayTspSectorRanking(input, AbortSignal.abort(new Error("Replay cancelled")))).rejects.toThrow("Replay cancelled");
  writeFileSync(join(root, "data", "sector-observation-archives-v1", `${memberRef.revision}.json`), "{}");
  await expect(replayTspSectorRanking(input)).rejects.toThrow("Observation archive is damaged");
});

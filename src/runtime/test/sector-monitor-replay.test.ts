import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveBenchmarkIndexObservations, archiveDatedIndexMinutes, archiveQuotePollCapture, archiveSectorObservations,
  type StoredQuotePollCapture, type StoredSectorObservationBatch,
} from "../../storage/index.ts";
import { replayTspSectorMonitor } from "../data/sector-monitor-replay.ts";

const tradeDate = "2025-01-03", previousTradeDate = "2025-01-02";
const group = { code: "BK1000.DC", name: "Robotics", level: null };
const symbols = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH"];
const at = (time: string, date = tradeDate) => Date.parse(date + "T" + time + "+08:00");
const catalog: StoredSectorObservationBatch = {
  market: "A", source: "tushare", endpoint: "dc_index", tradeDate, observedAt: "2025-01-04T01:00:00Z",
  coverage: "unknown", taxonomy: "eastmoney", kind: "concept", providerType: "概念板块", groups: [group],
};
const membership: StoredSectorObservationBatch = {
  market: "A", source: "tushare", endpoint: "dc_member", tradeDate, observedAt: "2025-01-04T01:10:00Z",
  coverage: "unknown", taxonomy: "eastmoney", sectorCode: group.code,
  members: symbols.map((symbol, i) => ({ symbol, name: "Member " + (i + 1) })),
};

function poll(time: string, prices: number[], date = tradeDate): StoredQuotePollCapture {
  const timestamp = at(time, date);
  const observedAt = new Date(timestamp + 1000).toISOString();
  return {
    market: "A", source: "tickflow", endpoint: "/v1/quotes", tradeDate: date,
    startedAt: new Date(timestamp).toISOString(), observedAt, coverage: "unknown", units: "unknown",
    requestedSymbols: [...symbols, "600010.SH"],
    rows: prices.map((lastPrice, i) => ({ symbol: symbols[i]!, timestamp, receivedAt: observedAt, lastPrice,
      previousClose: 16, volume: 1000, amount: null })),
  };
}

let root: string, previousRoot: string | undefined;
beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-sector-monitor-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

test("replays named exact members, maintains the full denominator and uses quote receipt windows", async () => {
  const [catalogRef, memberRef, first, partial, later] = await Promise.all([
    archiveSectorObservations(catalog), archiveSectorObservations(membership),
    archiveQuotePollCapture(poll("09:31:00", [17, 16, 17, 16])),
    archiveQuotePollCapture(poll("09:32:00", [18, 18, 18])),
    archiveQuotePollCapture(poll("09:36:00", [18, 18, 18, 18])),
  ]);
  const online = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected online read"));
  try {
    const request = { kind: "sector", catalogRef, memberRef, quoteRefs: [first, partial, later],
      rule: { trigger: "momentum", windowMinutes: 5, direction: "up", thresholdFraction: 0.09375, cooldownMs: 0 } } as const;
    const result = await replayTspSectorMonitor(request);
    expect(result).toMatchObject({
      target: { kind: "concept", membershipRevision: memberRef.revision, id: group.code, members: symbols },
      input: {
        sampleTimeBasis: "quote-poll-receipt",
        membership: { catalogRef, memberRef, historicalAvailability: "unknown" },
        polls: [
          { ref: first, requestedMembers: symbols, returnedMembers: symbols.slice(0, 4), sourceTimeRange: { earliest: at("09:31:00") } },
          { ref: partial, returnedMembers: symbols.slice(0, 3) }, { ref: later },
        ],
      },
      rows: [
        { observedAt: at("09:31:01"), valid: true, coverageRatio: 0.8, totalCount: 5, changeFraction: 0.03125,
          leader: { symbol: symbols[0], name: "Member 1" }, triggered: false },
        { valid: false, coverageRatio: 0.6, totalCount: 5, triggered: false },
        { valid: true, changeFraction: 0.125, triggered: true },
      ],
    });
    expect(result.rows[2]?.windows.find(row => row.minutes === 5)).toMatchObject({
      baselineAt: at("09:31:01"), changeFraction: 0.09375,
    });
    expect(await replayTspSectorMonitor(request)).toEqual(result);
    expect(online).not.toHaveBeenCalled();
  } finally { online.mockRestore(); }
});

test("rejects unrelated memberships, dates, changed scope, wrong ordering and duplicate archives", async () => {
  const normal = poll("09:32:00", [16]);
  const [catalogRef, memberRef, foreign, first, sameDate, changed, wrongDay, overlap] = await Promise.all([
    archiveSectorObservations(catalog), archiveSectorObservations(membership),
    archiveSectorObservations({ ...membership, sectorCode: "BK2000.DC" }),
    archiveQuotePollCapture(poll("09:31:00", [16])), archiveQuotePollCapture(normal),
    archiveQuotePollCapture({ ...normal, requestedSymbols: [symbols[0]!] }),
    archiveQuotePollCapture(poll("09:32:00", [16], previousTradeDate)),
    archiveQuotePollCapture({ ...normal, startedAt: "2025-01-03T01:31:00Z" }),
  ]);
  const base = { kind: "sector", catalogRef, memberRef, quoteRefs: [first] } as const;
  await expect(replayTspSectorMonitor({ ...base, memberRef: foreign })).rejects.toThrow("outside its catalog");
  for (const quoteRefs of [[first, first], [first, changed], [first, wrongDay], [first, overlap], [sameDate, first]]) {
    await expect(replayTspSectorMonitor({ ...base, quoteRefs })).rejects.toThrow("date and member scope");
  }
  await expect(replayTspSectorMonitor(base, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("uses archived index minute labels and the verified previous session", async () => {
  const symbol = "000001.SH", observedAt = "2025-01-04T01:30:00Z";
  const [dailyRef, minuteRef] = await Promise.all([
    archiveBenchmarkIndexObservations({
      market: "A", source: "tickflow", endpoint: "/v1/klines", symbol, observedAt, coverage: "unknown",
      requested: { start: previousTradeDate, end: previousTradeDate }, priceUnit: "index-points", returnUnit: "percentage-points",
      rows: [{ tradeDate: previousTradeDate, sourceTimestamp: at("00:00:00", previousTradeDate),
        closePoints: 1024, previousClosePoints: null, changePoints: null, returnPct: null }],
    }),
    archiveDatedIndexMinutes({
      market: "A", source: "tickflow", endpoint: "/v1/klines", symbol, tradeDate, observedAt, coverage: "unknown",
      interval: "1m", priceBasis: "index-level", priceUnit: "index-points", volumeUnit: "provider-native",
      amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native",
      rows: [1024, 1088].map((closePoints, i) => ({
        sourceTimestamp: at(i === 0 ? "09:31:00" : "09:32:00"), openPoints: closePoints, highPoints: closePoints,
        lowPoints: closePoints, closePoints, volume: 0, amount: null,
      })),
    }),
  ]);
  const request = { kind: "index", minuteRef, previousClose: {
    dailyRef, calendar: { revision: "fixed-calendar", previousTradeDate, tradeDate },
  } } as const;
  const result = await replayTspSectorMonitor(request);
  expect(result).toMatchObject({
    target: { kind: "index", symbol }, input: { sampleTimeBasis: "provider-native",
      minutes: { ref: minuteRef, rowCount: 2 }, previousClose: { dailyRef, row: { closePoints: 1024 } } },
    rows: [{ observedAt: at("09:31:00"), changeFraction: 0, pricePoints: 1024 },
      { observedAt: at("09:32:00"), changeFraction: 0.0625, pricePoints: 1088 }],
  });
  expect(result.rows[1]?.windows[0]).toMatchObject({ minutes: 1, baselineAt: at("09:31:00"), changeFraction: 0.0625 });
  expect((await replayTspSectorMonitor({ kind: "index", minuteRef })).rows.map(row => [row.valid, row.changeFraction]))
    .toEqual([[false, null], [false, null]]);
  await expect(replayTspSectorMonitor({ ...request, previousClose: { dailyRef, calendar: { ...request.previousClose.calendar,
    previousTradeDate: tradeDate } } })).rejects.toThrow("Previous-close calendar");
});

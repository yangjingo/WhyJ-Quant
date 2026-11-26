import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveObservations, archiveTradingDateObservations, archiveTspExtensionPage, type StoredBarObservation } from "../../storage/index.ts";
import { replayTspExtensionIntraday, type TspExtensionIntradayReplayRequest } from "../data/tsp-extension-intraday.ts";

test("binds exact membership, minute and previous-close evidence and computes a fixed curve offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-extension-intraday-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const noProvider = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider was called during replay"));
  process.env.OHQUANT_DIR = root;
  try {
    const tradeDate = "2025-06-18", previousDate = "2025-06-17";
    const a = "600001.SH", b = "000002.SZ", c = "600003.SH";
    const start = Date.parse(tradeDate + "T09:30:00+08:00");
    const capturedAt = tradeDate + "T08:00:00Z";
    const values = (close: number) => ({ open: close, high: close, low: close, close, volume: 100, amount: null });
    const label = "AI+芯片";
    const membershipRef = await archiveTspExtensionPage({
      source: "tsp", origin: "https://tsp.example.test", endpoint: "/api/ext-data/flow_demo/rows", originalPublisher: "unknown",
      observedAt: capturedAt, sourceAsOf: null, request: {
        datasetId: "flow_demo", selection: { mode: "timeseries", date: tradeDate }, columns: ["tag", "symbol"], offset: 0, limit: 5,
      },
      datasetLabel: "Flow", partitionDate: tradeDate, snapshotSyncLocal: null, schemaRevision: "a".repeat(64), revision: "b".repeat(64),
      coverage: "partial", totalRows: 6, fields: [{ name: "tag", dtype: "string", label: "Tag" },
        { name: "symbol", dtype: "string", label: "Symbol" }],
      rows: [{ tag: label + "/自动化", symbol: a }, { tag: label + "-机器人", symbol: b }, { tag: label, symbol: a },
        { tag: label, symbol: "000005" }, { tag: label + "模型", symbol: c }],
      omittedFields: [],
    });
    const minute = (symbol: string, rows: readonly [number, number][], adjustment: "none" | "forward" = "none") =>
      archiveObservations(rows.map(([offset, close]): StoredBarObservation => ({
        schemaVersion: 1, kind: "minute_bar", symbol, timestamp: start + offset * 60_000, interval: "1m", adjustment,
        timezone: "UTC", market: "unknown", assetType: "unknown", sourceAsOf: "unknown", source: "tickflow", endpoint: "/v1/klines",
        observedAt: capturedAt, units: "unknown", finality: "unknown", coverage: "unknown", revision: "unknown", quality: "unknown",
        values: values(close),
      })));
    const [minuteA, minuteB, minuteC, forward, dailyA] = await Promise.all([
      minute(a, [[3, 110], [1, 108], [-1_440, 99]]), minute(b, [[2, 50], [3, 52]]), minute(c, [[2, 100]]), minute(a, [[1, 108]], "forward"),
      archiveTradingDateObservations([{
        schemaVersion: 2, kind: "trading_date_daily_bar", symbol: a, tradeDate: previousDate, sourceTimestamp: null,
        requested: { startDate: previousDate, endDate: previousDate }, market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
        source: "tushare", endpoint: "daily", observedAt: capturedAt, interval: "1d", adjustment: "none",
        volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown", values: values(100),
      }]),
    ]);
    const input: TspExtensionIntradayReplayRequest = {
      tradeDate, previousDate, membership: { ref: membershipRef, dimensionField: "tag", value: label, symbolField: "symbol" },
      universe: { id: "fixture", revision: "market-fixture", symbols: [a, b, c] },
      histories: [{ symbol: a, minuteRef: minuteA, previousCloseRef: dailyA }, { symbol: b, minuteRef: minuteB }, { symbol: c, minuteRef: minuteC }],
    };
    const replay = await replayTspExtensionIntraday(input);
    expect(replay).toMatchObject({
      producer: "whyj", basis: "mixed", membership: { symbols: [a, b].sort(), value: label, revision: membershipRef.revision },
      points: [
        { timestamp: start + 60_000, sector: 0.08, sectorCount: 1, market: 0.08, marketCount: 1 },
        { timestamp: start + 120_000, sector: 0.04, sectorCount: 2, market: 0, marketCount: 2 },
        { timestamp: start + 180_000, sector: 0.07, sectorCount: 2, market: 0.07, marketCount: 2 },
      ],
      input: { membership: { ref: membershipRef, coverage: "partial", matchedRows: 4, missingSymbols: 1, historicalAvailability: "unknown" },
        prices: [
          { symbol: a, minute: { ref: minuteA, rowCount: 2, source: "tickflow", finality: "unknown" },
            previousClose: { ref: dailyA, price: 100, source: "tushare", tradeDate: previousDate } },
          { symbol: b, minute: { ref: minuteB }, previousClose: null },
          { symbol: c, minute: { ref: minuteC }, previousClose: null },
        ],
      },
    });
    expect(await replayTspExtensionIntraday(input)).toEqual(replay);
    const corrected = await minute(a, [[1, 108], [3, 115]]);
    const correctedReplay = await replayTspExtensionIntraday({
      ...input, histories: [{ symbol: a, minuteRef: corrected, previousCloseRef: dailyA }, ...input.histories.slice(1)],
    });
    expect(correctedReplay.points.at(-1)).toMatchObject({ sector: 0.095, market: 0.095 });
    expect(correctedReplay.input.prices[0]?.minute.ref).toEqual(corrected);
    expect(await replayTspExtensionIntraday(input)).toEqual(replay);
    await expect(replayTspExtensionIntraday({ ...input, tradeDate: "2025-06-19" })).rejects.toThrow("minute membership");
    await expect(replayTspExtensionIntraday({ ...input, membership: { ...input.membership, symbolField: "omitted" } }))
      .rejects.toThrow("minute membership");
    await expect(replayTspExtensionIntraday({ ...input, histories: [{ symbol: a, minuteRef: forward }] })).rejects.toThrow("minute archive");
    await expect(replayTspExtensionIntraday({ ...input, histories: [{ symbol: a, minuteRef: minuteB }] })).rejects.toThrow("minute archive");
    await expect(replayTspExtensionIntraday({ ...input, previousDate: "2025-06-16" })).rejects.toThrow("prior-close archive");
    await expect(replayTspExtensionIntraday({ ...input, histories: [{ symbol: b, minuteRef: minuteB, previousCloseRef: dailyA }] }))
      .rejects.toThrow("prior-close archive");
    await expect(replayTspExtensionIntraday(input, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(noProvider).not.toHaveBeenCalled();
  } finally {
    noProvider.mockRestore();
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

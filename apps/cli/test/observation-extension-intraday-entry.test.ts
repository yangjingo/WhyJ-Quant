import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveObservations, archiveTradingDateObservations, archiveTspExtensionPage, type StoredBarObservation } from "../../../src/storage/index.ts";

test("actual CLI replays frozen extension curves and retains the archive and market denominators", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-extension-intraday-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const path = join(root, "dimension curve.json");
  const tradeDate = "2025-06-18", previousDate = "2025-06-17", a = "600001.SH", b = "600002.SH";
  const start = Date.parse(tradeDate + "T09:30:00+08:00"), observedAt = tradeDate + "T08:00:00Z";
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function run(...args: string[]) {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(input: unknown) {
    writeFileSync(path, JSON.stringify(input));
    return run("observation", "replay-extension-intraday", "--manifest", path);
  }
  process.env.OHQUANT_DIR = root;
  try {
    const membershipRef = await archiveTspExtensionPage({
      source: "tsp", origin: "https://tsp.example.test", endpoint: "/api/ext-data/demo/rows", originalPublisher: "unknown", observedAt,
      sourceAsOf: null, request: { datasetId: "demo", selection: { mode: "snapshot" }, columns: ["sector", "symbol"], offset: 0, limit: 5 },
      datasetLabel: "Demo", partitionDate: null, snapshotSyncLocal: "2025-06-18 16:00:00",
      schemaRevision: "a".repeat(64), revision: "b".repeat(64), coverage: "complete", totalRows: 1,
      fields: [{ name: "sector", dtype: "string", label: "Group" }, { name: "symbol", dtype: "string", label: "Symbol" }],
      rows: [{ sector: "chip", symbol: a }], omittedFields: [],
    });
    const minute = (symbol: string, samples: readonly [number, number][]) =>
      archiveObservations(samples.map(([offset, close]): StoredBarObservation => ({
        schemaVersion: 1, kind: "minute_bar", symbol, timestamp: start + offset * 60_000, interval: "1m", adjustment: "none",
        source: "tickflow", endpoint: "/v1/klines", market: "unknown", assetType: "unknown", timezone: "UTC", sourceAsOf: "unknown",
        observedAt, units: "unknown", finality: "unknown", coverage: "unknown", revision: "unknown", quality: "unknown",
        values: { open: close, high: close, low: close, close, volume: 100, amount: null },
      })));
    const [first, second, previousClose] = await Promise.all([
      minute(a, [[0, 100], [1, 110]]), minute(b, [[1, 50], [2, 49]]),
      archiveTradingDateObservations([{
        schemaVersion: 2, kind: "trading_date_daily_bar", symbol: a, tradeDate: previousDate, sourceTimestamp: null,
        requested: { startDate: previousDate, endDate: previousDate }, market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai",
        source: "tushare", endpoint: "daily", observedAt, interval: "1d", adjustment: "none",
        volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown",
        values: { open: 105, high: 105, low: 105, close: 105, volume: 100, amount: null },
      }]),
    ]);
    const manifest = {
      schemaVersion: 1, tradeDate, previousDate: null,
      membership: { revision: membershipRef.revision, dimensionField: "sector", value: "chip", symbolField: "symbol" },
      universe: { id: "fixed", revision: "fixed-fixture", symbols: [a, b] },
      histories: [{ symbol: a, minuteRevision: first.revision }, { symbol: b, minuteRevision: second.revision }],
    };
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation replay-extension-intraday",
      description: "Replay extension group and market minute curves from fixed archives",
    });
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", basis: "first_close", memberPolicy: "forward-fill", membership: { revision: membershipRef.revision, symbols: [a] },
      points: [
        { timestamp: start, sector: 0, sectorCount: 1, market: 0, marketCount: 1 },
        { timestamp: start + 60_000, sector: 0.1, sectorCount: 1, market: 0.05, marketCount: 2 },
        { timestamp: start + 120_000, sector: 0.1, sectorCount: 1, market: -0.02, marketCount: 1 },
      ],
      input: { membership: { ref: membershipRef, historicalAvailability: "unknown" },
        prices: [{ minute: { ref: first } }, { minute: { ref: second } }] },
    } } });
    expect(await replay(manifest)).toEqual(result);
    expect(await replay({
      ...manifest, previousDate,
      histories: [{ ...manifest.histories[0], previousCloseRevision: previousClose.revision }, manifest.histories[1]],
    })).toMatchObject({ code: 0, output: { data: { basis: "mixed",
      input: { prices: [{ previousClose: { ref: previousClose, tradeDate: previousDate, price: 105 } }, { previousClose: null }] },
    } } });
    expect(await replay({ ...manifest, histories: [] })).toMatchObject({ code: 0, output: { data: { status: "no_data", points: [] } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, histories: [manifest.histories[0], manifest.histories[0]] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, histories: [{ ...manifest.histories[0], symbol: "600003.SH" }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, histories: [{ ...manifest.histories[0], previousCloseRevision: "f".repeat(64) }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, previousDate: tradeDate })).toMatchObject(invalid);
    expect(await replay({ ...manifest, tradeDate: "2025-02-30" })).toMatchObject(invalid);
    expect(await replay({ ...manifest, unknownKey: true })).toMatchObject(invalid);
    expect(await replay({ ...manifest, membership: { ...manifest.membership, revision: "../outside" } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, membership: { ...manifest.membership, revision: "0".repeat(64) } })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
  } finally {
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

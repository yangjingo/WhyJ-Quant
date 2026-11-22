import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveBenchmarkIndexObservations, archiveDatedIndexMinutes, archiveQuotePollCapture, archiveSectorObservations } from "../../../src/storage/index.ts";

const tradeDate = "2025-01-03", previousTradeDate = "2025-01-02", observedAt = "2025-01-04T01:00:00Z";
const at = (time: string, date = tradeDate) => Date.parse(date + "T" + time + "+08:00");
const stocks = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH"];
const index = "000001.SH", code = "BK1000.DC";

function archivePoll(time: string, prices: number[]) {
  const timestamp = at(time);
  const receivedAt = new Date(timestamp + 1000).toISOString();
  return archiveQuotePollCapture({
    source: "tickflow", endpoint: "/v1/quotes", market: "A", tradeDate, startedAt: new Date(timestamp).toISOString(),
    observedAt: receivedAt, coverage: "unknown", units: "unknown", requestedSymbols: stocks,
    rows: prices.map((lastPrice, i) => ({ symbol: stocks[i]!, timestamp, receivedAt, lastPrice, previousClose: 16, volume: 100, amount: null })),
  });
}

async function archiveFixtures() {
  const sector = { source: "tushare", market: "A", tradeDate, observedAt, coverage: "unknown", taxonomy: "eastmoney" } as const;
  const [catalog, members, first, later, minutes, daily] = await Promise.all([
    archiveSectorObservations({ ...sector, endpoint: "dc_index", kind: "industry", providerType: "行业板块",
      groups: [{ code, name: "Fixture sector", level: null }] }),
    archiveSectorObservations({ ...sector, endpoint: "dc_member", sectorCode: code,
      members: stocks.map((symbol, i) => ({ symbol, name: "Stock " + (i + 1) })) }),
    archivePoll("09:31:00", [16, 16, 16, 16]),
    archivePoll("09:36:00", [18, 17, 16, 17]),
    archiveDatedIndexMinutes({
      source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: index, tradeDate, observedAt, coverage: "unknown",
      interval: "1m", priceBasis: "index-level", priceUnit: "index-points", volumeUnit: "provider-native",
      amountUnit: "provider-native", timeZone: "Asia/Shanghai", timestampLabel: "provider-native",
      rows: [1024, 1088].map((closePoints, i) => ({
        sourceTimestamp: at(i === 0 ? "09:31:00" : "09:32:00"), openPoints: closePoints, highPoints: closePoints,
        lowPoints: closePoints, closePoints, volume: 0, amount: null,
      })),
    }),
    archiveBenchmarkIndexObservations({
      source: "tickflow", endpoint: "/v1/klines", market: "A", symbol: index, observedAt, coverage: "unknown",
      requested: { start: previousTradeDate, end: previousTradeDate }, priceUnit: "index-points", returnUnit: "percentage-points",
      rows: [{ tradeDate: previousTradeDate, sourceTimestamp: at("00:00:00", previousTradeDate), closePoints: 1024,
        previousClosePoints: null, changePoints: null, returnPct: null }],
    }),
  ]);
  return { catalog, members, first, later, minutes, daily };
}

test("production CLI entry replays exact sector and index monitor fixtures", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-sector-monitor-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const manifest = join(root, "sector monitor.json");
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "",
        TICKFLOW_BASE_URL: "http://127.0.0.1:1", TUSHARE_BASE_URL: "http://127.0.0.1:1" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(value: unknown) {
    writeFileSync(manifest, JSON.stringify(value));
    return run("observation", "replay-sector-monitor", "--manifest", manifest);
  }
  process.env.OHQUANT_DIR = root;
  try {
    const { catalog, members, first, later, minutes, daily } = await archiveFixtures();
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation replay-sector-monitor", description: "Replay fixed intraday sector or index monitor metrics",
    });
    const sector = {
      version: 1, kind: "sector", catalogRevision: catalog.revision, memberRevision: members.revision,
      quoteRevisions: [first.revision, later.revision],
      rule: { trigger: "momentum", direction: "up", thresholdFraction: 0.0625, cooldownMs: 0, windowMinutes: 5 },
    };
    const result = await replay(sector);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", target: { kind: "industry", id: code },
      input: { sampleTimeBasis: "quote-poll-receipt", membership: { catalogRef: catalog, memberRef: members },
        polls: [{ ref: first }, { ref: later }] },
      rows: [{ observedAt: at("09:31:01"), coverageRatio: 0.8, changeFraction: 0, triggered: false },
        { observedAt: at("09:36:01"), coverageRatio: 0.8, changeFraction: 0.0625, triggered: true, leader: { symbol: stocks[0] } }],
    } } });
    expect(result.output.data.rows[1].windows.find((row: { minutes: number }) => row.minutes === 5))
      .toEqual({ minutes: 5, baselineAt: at("09:31:01"), changeFraction: 0.0625 });
    expect(await replay(sector)).toEqual(result);
    const indexManifest = { version: 1, kind: "index", minuteRevision: minutes.revision };
    const prevClose = { dailyRevision: daily.revision, calendar: { revision: "fixture", tradeDate, previousTradeDate } };
    expect(await replay({ ...indexManifest, previousClose: prevClose })).toMatchObject({ code: 0, output: { data: {
      target: { kind: "index", symbol: index }, input: { sampleTimeBasis: "provider-native", minutes: { ref: minutes },
        previousClose: { dailyRef: daily } },
      rows: [{ changeFraction: 0, pricePoints: 1024 }, { changeFraction: 0.0625, pricePoints: 1088 }],
    } } });
    expect(await replay(indexManifest)).toMatchObject({ code: 0, output: { data: {
      input: { previousClose: null }, rows: [{ valid: false, changeFraction: null }, { valid: false, changeFraction: null }],
    } } });
    const invalid = { code: 1, output: { error: { code: "invalid_arguments" } } };
    for (const value of [{ ...sector, version: 2 }, { ...sector, rule: { ...sector.rule, windowMinutes: 2 } },
      { ...sector, quoteRevisions: [later.revision, later.revision] }, { ...indexManifest, memberRevision: members.revision }]) {
      expect(await replay(value)).toMatchObject(invalid);
    }
    const unavailable = { code: 1, output: { error: { code: "observation_archive_unavailable" } } };
    expect(await replay({ ...sector, quoteRevisions: [later.revision, first.revision] })).toMatchObject(unavailable);
    expect(await replay({ ...sector, memberRevision: "f".repeat(64) })).toMatchObject(unavailable);
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

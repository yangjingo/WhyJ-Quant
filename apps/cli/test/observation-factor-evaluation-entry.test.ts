import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveBenchmarkIndexObservations, archiveMarketCrossSection, archiveTradingDateObservations,
  type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";

const sessions = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14"];

function archivePrices(symbol: string, closes: number[]) {
  const bars: StoredTradingDateBarObservation[] = sessions.map((tradeDate, index) => {
    const close = closes[index]!;
    return {
      kind: "trading_date_daily_bar", schemaVersion: 2, symbol, tradeDate, sourceTimestamp: null,
      requested: { startDate: sessions[0]!, endDate: sessions.at(-1)! }, market: "A", assetType: "stock",
      calendarTimeZone: "Asia/Shanghai", source: "tushare", endpoint: "daily", observedAt: "2026-03-04T08:00:00Z",
      interval: "1d", adjustment: "none", volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown",
      values: { open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, amount: close * 10 },
    };
  });
  return archiveTradingDateObservations(bars);
}

async function archiveMarketEnvironment() {
  const environmentSessions = sessions.slice(4);
  const marketSessions = environmentSessions.slice(0, -1);
  const observedAt = "2026-03-04T08:00:00Z";
  const market = await Promise.all(marketSessions.map(tradeDate => {
    const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
    return archiveMarketCrossSection({
      source: "tushare", market: "A", tradeDate,
      universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks", members: [] },
      bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand", rows: [] },
      basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
        marketValueUnit: "CNY-ten-thousand", rows: [] },
    });
  }));
  const benchmark = await archiveBenchmarkIndexObservations({
    symbol: "000001.SH", source: "tushare", market: "A", endpoint: "index_daily", observedAt, coverage: "unknown",
    priceUnit: "index-points", returnUnit: "percentage-points", requested: { start: environmentSessions[0]!, end: environmentSessions.at(-1)! },
    rows: marketSessions.map((tradeDate, index) => {
      const change = index === 0 ? 3 : -3;
      return { tradeDate, closePoints: 100 + change, previousClosePoints: 100, changePoints: change, returnPct: change };
    }),
  });
  return {
    sessions: environmentSessions, marketRevisions: market.map(ref => ref.revision),
    limitRevisions: [], priceHistory: [], benchmark: { symbol: "000001.SH", revisions: [benchmark.revision] },
  };
}

test("actual CLI projects fixed research factor archives into Rank IC and equal-weight group diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-factor-evaluation-cli-"));
  const path = join(root, "manifest.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    const previous = process.env.OHQUANT_DIR;
    process.env.OHQUANT_DIR = root;
    let up, down, flat, marketEnvironment;
    try {
      up = await archivePrices("600001.SH", [10, 11, 12, 13, 14, 15, 16, 17]);
      down = await archivePrices("000001.SZ", [20, 19, 18, 17, 16, 15, 14, 13]);
      flat = await archivePrices("300001.SZ", Array(8).fill(10));
      marketEnvironment = await archiveMarketEnvironment();
    } finally {
      if (previous === undefined) delete process.env.OHQUANT_DIR;
      else process.env.OHQUANT_DIR = previous;
    }
    const manifest = {
      factorId: "momentum_5d", rebalance: "daily", sessions, evaluationStart: sessions[5],
      symbols: [
        { symbol: "600001.SH", dailyRevisions: [up.revision] },
        { symbol: "000001.SZ", dailyRevisions: [down.revision] },
        { symbol: "300001.SZ", dailyRevisions: [flat.revision] },
      ],
      groups: { groupCount: 3, weight: "equal", commissionFraction: 0, slippageBps: 0 },
    };
    const replay = async (value: unknown) => {
      writeFileSync(path, JSON.stringify(value));
      return run("observation", "replay-factor-evaluation", "--manifest", path);
    };
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-factor-evaluation",
      description: "Replay fixed factor information and group diagnostics" });
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-analytics",
      description: "Replay fixed daily research factors and chart levels" });

    const example = await replay(manifest);
    expect(example).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { adjustment: "none", evaluationStart: "2026-01-12" },
      panel: { factorId: "momentum_5d", sessions: ["2026-01-12", "2026-01-13", "2026-01-14"] },
      information: { summary: { nDates: 2, icMean: 1 }, series: [{ pairCount: 3, ic: 1 }, { pairCount: 3, ic: 1 }] },
      grouping: { roundTripCost: 0, longShort: { topGroup: "Q3", bottomGroup: "Q1", executableShort: false } },
    } } });
    expect(example.output.data.input.symbols[0].daily[0].ref).toEqual(up);
    expect(example.output.data.panel.rows[0]).toEqual({ symbol: "600001.SH", tradeDate: "2026-01-12", close: 15, factor: 0.5 });
    expect(await replay(manifest)).toEqual(example);
    expect(example.output.data.information).not.toHaveProperty("marketRegime");

    const classified = await replay({ ...manifest, marketEnvironment });
    expect(classified).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { marketEnvironment: { precedingSession: "2026-01-09", scope: { phaseMode: "causal" } } },
      information: { marketRegime: {
        unclassifiedAtStart: null,
        assignments: [
          { tradeDate: "2026-01-12", previousTradeDate: "2026-01-09", state: "range", score: 53 },
          { tradeDate: "2026-01-13", previousTradeDate: "2026-01-12", state: "weak", score: 43 },
          { tradeDate: "2026-01-14", previousTradeDate: "2026-01-13", state: "weak", score: 43 },
        ],
        buckets: [{ state: "range", meanScore: 53, nDates: 1, nIcDates: 1 }, { state: "weak", meanScore: 43, nDates: 2, nIcDates: 1 }],
      } },
    } } });

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, marketEnvironment: { ...marketEnvironment, phaseMode: "retrospective-tsp" } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, groups: { slippageBps: -1 } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, sessions: sessions.toReversed() })).toMatchObject(invalid);
    expect(await replay({ ...manifest, symbols: [{ ...manifest.symbols[0], dailyRevisions: ["../outside"] }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, symbols: [{ ...manifest.symbols[0], financialReportRevisions: [],
      bookValueBasis: [{ basis: "caller-confirmed-unadjusted-CNY", periodEnd: "2025-12-31", reportRevision: up.revision }] }] })).toMatchObject(invalid);
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await replay({ ...manifest, marketEnvironment: { ...marketEnvironment, marketRevisions: marketEnvironment.marketRevisions.slice(1) } }))
      .toMatchObject(unavailable);
    expect(await replay({ ...manifest, symbols: [{ ...manifest.symbols[0], dailyRevisions: ["0".repeat(64)] }] })).toMatchObject(unavailable);
    writeFileSync(join(root, "data", "observation-archives-v2", up.revision + ".json"), "{}");
    expect(await replay(manifest)).toMatchObject(unavailable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

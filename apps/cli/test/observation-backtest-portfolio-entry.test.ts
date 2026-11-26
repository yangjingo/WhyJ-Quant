import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTspBacktestPortfolio } from "../../../src/quant/index.ts";
import { archiveQuotePollCapture, archiveTradingDateObservations } from "../../../src/storage/index.ts";

const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
  ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
  : [process.execPath, "run", "src/index.ts"];

async function runCli(root: string, ...args: string[]) {
  const child = Bun.spawn([...entry, "--json", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  return { code, output: JSON.parse(stdout) };
}

test("actual CLI replays a versioned portfolio and keeps bad evidence distinct", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-backtest-portfolio-cli-"));
  const path = join(root, "portfolio.json");
  function replay(manifest: unknown) {
    writeFileSync(path, JSON.stringify(manifest));
    return runCli(root, "observation", "replay-backtest-portfolio", "--manifest", path);
  }
  const manifest = {
    schemaVersion: 1,
    initialCapital: 100,
    equityCurve: [
      { date: "2026-05-27", equity: 100, exposureFraction: 0 },
      { date: "2026-05-28", equity: 110, exposureFraction: 0.5 },
      { date: "2026-05-29", equity: 99, exposureFraction: 0.65 },
      { date: "2026-06-01", equity: 112, exposureFraction: 0.4 },
    ],
    trades: [
      { pnlFraction: 0.16, holdingDays: 3 },
      { pnlFraction: -0.08, holdingDays: 2 },
      { pnlFraction: 0, holdingDays: 1 },
    ],
    includeMonteCarlo: false,
  };
  try {
    const help = await runCli(root, "--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation replay-backtest-portfolio",
      description: "Replay fixed TSP portfolio backtest metrics",
    });
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "available", producer: "whyj", formulaVersion: "tsp-backtest-portfolio-v1",
      equitySamples: 4, tradeSamples: 3,
      portfolio: { annualReturn: 1260.0591, maxDrawdown: -0.1, avgExposure: 0.3875, sharpe: 5.54 },
      realizedTrades: { winRate: 0.3333, profitFactor: 4, avgHoldingDays: 2 },
    } } });
    expect(result.output.data).not.toHaveProperty("monteCarlo");
    expect(result.output.data).not.toHaveProperty("perSymbol");
    expect(await replay(manifest)).toEqual(result);
    expect(result.output.data.curve).toEqual({ formulaVersion: "tsp-backtest-portfolio-curve-v1", rows: [
      { ...manifest.equityCurve[0], cash: null, positionCount: null, drawdownFraction: 0 },
      { ...manifest.equityCurve[1], cash: null, positionCount: null, drawdownFraction: 0 },
      { ...manifest.equityCurve[2], cash: null, positionCount: null, drawdownFraction: -0.1 },
      { ...manifest.equityCurve[3], cash: null, positionCount: null, drawdownFraction: 0 },
    ] });
    const chartEvidence = [
      { ...manifest.equityCurve[0], equity: 90, cash: 0, positionCount: 0 },
      { ...manifest.equityCurve[1], equity: 85, cash: null },
      { ...manifest.equityCurve[2], equity: 110, cash: 44.126, positionCount: 3 },
      { ...manifest.equityCurve[3], equity: 105, positionCount: null },
    ];
    const chart = await replay({ ...manifest, equityCurve: chartEvidence });
    expect(chart).toMatchObject({ code: 0, output: { ok: true, data: { portfolio: { maxDrawdown: -0.0556 } } } });
    expect(chart.output.data.curve).toEqual({ formulaVersion: "tsp-backtest-portfolio-curve-v1", rows: [
      { ...chartEvidence[0], drawdownFraction: -0.1 },
      { ...chartEvidence[1], positionCount: null, drawdownFraction: -0.15 },
      { ...chartEvidence[2], cash: 44.13, drawdownFraction: 0 },
      { ...chartEvidence[3], cash: null, drawdownFraction: -0.0455 },
    ] });
    const labelled = { ...manifest, trades: [
      { ...manifest.trades[0], symbol: "600000.SH" },
      { ...manifest.trades[1], symbol: "600000.SH" },
      manifest.trades[2]!,
    ] };
    const grouped = await replay(labelled);
    expect(grouped).toMatchObject({ code: 0, output: { ok: true } });
    expect(grouped.output.data).toEqual(computeTspBacktestPortfolio(labelled));
    const { perSymbol, ...original } = grouped.output.data;
    expect(original).toEqual(result.output.data);
    expect(perSymbol).toEqual({ formulaVersion: "tsp-backtest-per-symbol-v1", groupedTrades: 2, totalTrades: 3, rows: [
      { symbol: "600000.SH", tradeCount: 2, totalReturn: 0.0672, winRate: 0.5, best: 0.16, worst: -0.08 },
    ] });
    expect(await replay({ ...labelled, equityCurve: [] })).toMatchObject({ code: 0, output: { data: {
      status: "unavailable", reason: "empty-equity-curve", perSymbol,
    } } });
    expect(await replay({ ...manifest, equityCurve: [] })).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "unavailable", reason: "empty-equity-curve",
    } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, equityCurve: manifest.equityCurve.toReversed() })).toMatchObject(invalid);
    for (const extra of [{ cash: "0" }, { positionCount: "0" }, { positionCount: -1 }, { positionCount: 1.5 },
      { positionCount: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }]) {
      expect(await replay({ ...manifest, equityCurve: [{ ...manifest.equityCurve[0], ...extra }] })).toMatchObject(invalid);
    }
    expect(await replay({ ...manifest, trades: [{ pnlFraction: 0 }] })).toMatchObject(invalid);
    for (const symbol of [null, 600000, "600000", "600000.sh"]) {
      expect(await replay({ ...manifest, trades: [{ ...manifest.trades[0], symbol }] })).toMatchObject(invalid);
    }
    writeFileSync(path, JSON.stringify({ trades: labelled.trades }));
    expect(await runCli(root, "observation", "backtest-robustness", "--manifest", path)).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("actual CLI rebuilds paper ledger holdings and passes them unchanged into valuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-paper-ledger-cli-"));
  const path = join(root, "manifest.json");
  const tradeDate = "2026-01-06", stock = "600001.SH", etf = "510300.SH";
  const buy = { kind: "fill", entryId: "a", tradeDate: "2026-01-05", symbol: stock, assetType: "stock", currency: "CNY",
    side: "buy", quantity: 10, price: 10, fee: 0.5 };
  const manifest = { schemaVersion: 1, accountId: "paper", currency: "CNY", initialCash: 500, asOf: tradeDate, entries: [
    buy, { ...buy, entryId: "b", tradeDate, quantity: 5, price: 12 },
    { kind: "corp_action", entryId: "split", tradeDate, symbol: stock, factor: 1.25 },
    { ...buy, entryId: "sell", tradeDate, side: "sell", quantity: 7, price: 9, fee: 0.25 },
    { ...buy, entryId: "etf", symbol: etf, tradeDate, assetType: "etf", quantity: 2, price: 5, fee: 0 },
  ] };
  function replay(action: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    return runCli(root, "observation", action, "--manifest", path);
  }
  try {
    const help = (await runCli(root, "--help")).output.data.commands;
    expect(help).toContainEqual({
      command: "whyj --json observation replay-paper-ledger",
      description: "Rebuild simulated cash, holdings, and sellable shares from a fixed ledger",
    });
    const result = await replay("replay-paper-ledger", manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-paper-ledger-v1", cash: 391.75, entryCount: 5,
      positions: [
        { symbol: etf, quantity: 2, availableQuantity: 0 },
        { symbol: stock, quantity: 11.75, averageCost: 8.586666, availableQuantity: 5 },
      ],
      lots: [{ symbol: etf, entries: [{ tradeDate, quantity: 2 }] }, { symbol: stock, entries: [
        { tradeDate: "2026-01-05", quantity: 5.5 }, { tradeDate, quantity: 6.25 },
      ] }],
    } } });
    const { accountId, currency, cash, initialCash, positions } = result.output.data;
    expect(await replay("replay-paper-valuation", { schemaVersion: 1, accountId, currency, cash, initialCash, positions,
      tradeDate, basis: "finalized", priceBasisConfirmation: "caller-confirmed-unadjusted-CNY", dailyRevisions: [] }))
      .toMatchObject({ code: 0, output: { ok: true, data: { cash: 391.75, equity: 502.64, coverage: {
        holdings: 2, marketMarks: 0, costFallbackSymbols: [etf, stock],
      } } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const change of [
      { schemaVersion: 2 }, { entries: [buy, buy] }, { entries: [{ ...buy, side: "sell" }] },
      { entries: [{ ...buy, currency: "USD" }] }, { entries: [{ ...buy, factor: 1.25 }] },
      { entries: [{ ...manifest.entries[2], price: 10 }] },
    ]) expect(await replay("replay-paper-ledger", { ...manifest, ...change })).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("actual CLI replays completed paper fills and finalized NAV", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-paper-statistics-cli-"));
  const path = join(root, "account.json");
  const fields = { symbol: "600001.SH", currency: "CNY" };
  const buy = { ...fields, fillId: "buy", tradeDate: "2026-05-27", side: "buy", quantity: 100, price: 10, fee: 5 };
  const sell = { ...fields, fillId: "sell", tradeDate: "2026-06-01", side: "sell", quantity: 50, price: 12, fee: 2 };
  const manifest = { schemaVersion: 1, accountId: "paper-fixture", currency: "CNY", fills: [buy, sell],
    finalizedNav: [{ tradeDate: buy.tradeDate, nav: 10000, currency: "CNY" }, { tradeDate: sell.tradeDate, nav: 9500, currency: "CNY" }] };
  function replay(value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    return runCli(root, "observation", "replay-paper-statistics", "--manifest", path);
  }
  try {
    const help = await runCli(root, "--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation replay-paper-statistics",
      description: "Replay simulated account FIFO and finalized NAV metrics",
    });
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-paper-statistics-v1", accountId: "paper-fixture", currency: "CNY",
      roundTrips: [{ buyFillId: "buy", sellFillId: "sell", quantity: 50, pnl: 95.5, holdingDays: 5 }],
      summary: { realizedPnl: 95.5, winRateFraction: 1, maxDrawdownFraction: 0.05, fillCount: 2, positiveNavRows: 2 },
    } } });
    expect(await replay(manifest)).toEqual(result);
    expect(await replay({ ...manifest, finalizedNav: [] })).toMatchObject({
      code: 0, output: { ok: true, data: { summary: { maxDrawdownFraction: null, positiveNavRows: 0 } } },
    });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, fills: [sell] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, fills: [buy, buy] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, fills: [buy, { ...sell, currency: "USD" }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, fills: [{ ...buy, extra: true }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, finalizedNav: manifest.finalizedNav.toReversed() })).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("actual CLI values fixed holdings from either dated bars or a captured quote", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-paper-valuation-cli-"));
  const path = join(root, "valuation.json");
  const tradeDate = "2026-01-07", symbol = "600001.SH", fund = "510300.SH";
  const startedAt = "2026-01-07T02:00:00Z", observedAt = "2026-01-07T02:00:01Z";
  const base = {
    schemaVersion: 1, accountId: "paper-fixture", tradeDate, currency: "CNY", cash: 1000, initialCash: 2500,
    priceBasisConfirmation: "caller-confirmed-unadjusted-CNY",
    positions: [
      { symbol, assetType: "stock", currency: "CNY", quantity: 100, averageCost: 10, availableQuantity: 100 },
      { symbol: fund, assetType: "etf", currency: "CNY", quantity: 50, averageCost: 10, availableQuantity: 50 },
    ],
  };
  function replay(value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    return runCli(root, "observation", "replay-paper-valuation", "--manifest", path);
  }
  try {
    const previous = process.env.OHQUANT_DIR;
    process.env.OHQUANT_DIR = root;
    let daily, quote;
    try {
      [daily, quote] = await Promise.all([
        archiveTradingDateObservations([{
          schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate, sourceTimestamp: null,
          requested: { startDate: tradeDate, endDate: tradeDate }, market: "A", assetType: "stock",
          calendarTimeZone: "Asia/Shanghai", source: "tushare", endpoint: "daily", observedAt: "2026-01-07T08:00:00Z",
          interval: "1d", adjustment: "none", volumeUnit: "hand", amountUnit: "CNY-thousand", coverage: "unknown",
          values: { open: 10, high: 13, low: 10, close: 12, volume: 50, amount: null },
        }]),
        archiveQuotePollCapture({
          source: "tickflow", endpoint: "/v1/quotes", market: "A", tradeDate, startedAt, observedAt,
          coverage: "unknown", units: "unknown", requestedSymbols: [symbol],
          rows: [{ symbol, timestamp: Date.parse(startedAt), receivedAt: observedAt, lastPrice: 13,
            previousClose: 10, volume: 10, amount: null }],
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.OHQUANT_DIR;
      else process.env.OHQUANT_DIR = previous;
    }
    const help = await runCli(root, "--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation replay-paper-valuation",
      description: "Value a simulated account from fixed market archives",
    });
    const finalized = { ...base, basis: "finalized", dailyRevisions: [daily.revision] };
    const snapshot = { ...base, basis: "snapshot", quoteRevision: quote.revision };
    expect(await replay(finalized)).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-paper-valuation-v1", basis: "finalized", equity: 2700, totalPnl: 200,
      coverage: { marketMarks: 1, costFallbackSymbols: [fund] },
      inputs: { daily: [{ ref: daily, source: "tushare", endpoint: "daily", price: 12 }] },
    } } });
    const live = await replay(snapshot);
    expect(live).toMatchObject({ code: 0, output: { ok: true, data: {
      basis: "snapshot", equity: 2800, totalPnl: 300, coverage: { marketMarks: 1, costFallbackSymbols: [fund] },
      inputs: { quotePoll: { ref: quote, quotes: [{ symbol, price: 13, sourceTimestamp: Date.parse(startedAt) }] } },
    } } });
    expect(await replay(snapshot)).toEqual(live);
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...finalized, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await replay({ ...finalized, quoteRevision: quote.revision })).toMatchObject(invalid);
    expect(await replay({ ...finalized, dailyRevisions: ["../invalid"] })).toMatchObject(invalid);
    expect(await replay({ ...snapshot, priceBasisConfirmation: "unknown" })).toMatchObject(invalid);
    expect(await replay({ ...snapshot, positions: [{ ...base.positions[0]!, currency: "USD" }] })).toMatchObject(invalid);
    expect(await replay({ ...snapshot, unexpected: true })).toMatchObject(invalid);
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await replay({ ...snapshot, tradeDate: "2026-01-08" })).toMatchObject(unavailable);
    expect(await replay({ ...finalized, dailyRevisions: ["0".repeat(64)] })).toMatchObject(unavailable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

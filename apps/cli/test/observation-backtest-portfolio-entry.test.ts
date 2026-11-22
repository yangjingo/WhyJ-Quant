import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function runCli(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
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
    expect(await replay(manifest)).toEqual(result);
    expect(await replay({ ...manifest, equityCurve: [] })).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "unavailable", reason: "empty-equity-curve",
    } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, equityCurve: manifest.equityCurve.toReversed() })).toMatchObject(invalid);
    expect(await replay({ ...manifest, trades: [{ pnlFraction: 0 }] })).toMatchObject(invalid);
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

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI replays a versioned portfolio and keeps bad evidence distinct", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-backtest-portfolio-cli-"));
  const path = join(root, "portfolio.json");
  async function run(...args: string[]) {
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
  function replay(manifest: unknown) {
    writeFileSync(path, JSON.stringify(manifest));
    return run("observation", "replay-backtest-portfolio", "--manifest", path);
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
    const help = await run("--help");
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

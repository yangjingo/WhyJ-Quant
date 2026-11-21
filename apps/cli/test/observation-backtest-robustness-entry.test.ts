import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI evaluates and repeats a fixed trade robustness manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-backtest-robustness-cli-"));
  const path = join(root, "trades.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const evaluate = async (value: unknown) => {
    writeFileSync(path, JSON.stringify(value));
    return run("observation", "backtest-robustness", "--manifest", path);
  };

  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation backtest-robustness",
      description: "Calculate TSP trade robustness diagnostics from a local manifest" });
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-factor-evaluation",
      description: "Replay fixed factor information and group diagnostics" });

    const outcomes = [0.05, -0.03, 0.08, -0.06, 0.02, -0.04, 0.10, -0.05];
    const holdingDays = [1, 3, 5, 3, 4, 5, 6, 4];
    const manifest = { trades: outcomes.map((pnlFraction, index) => ({ pnlFraction, holdingDays: holdingDays[index]! })) };
    const result = await evaluate(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      sortino: 4.24, sortinoBasis: "realized-trades", returnSamples: 8,
      perTrade: { tradeSamples: 8, medianPnl: -0.005, avgHoldingDays: 3.9 },
      monteCarlo: { seed: 42, simulations: 1000, drawdownP50: -0.0976, drawdownP95: -0.2108 },
    } } });
    expect(await evaluate(manifest)).toEqual(result);

    const portfolio = await evaluate({ ...manifest, includeMonteCarlo: false, periodicReturns: [0.01, -0.02, 0.03, -0.01, 0] });
    expect(portfolio).toMatchObject({ code: 0, output: { ok: true, data: { sortino: 3.17, sortinoBasis: "periodic-returns",
      returnSamples: 5, perTrade: { tradeSamples: 8 } } } });
    expect(portfolio.output.data).not.toHaveProperty("monteCarlo");
    expect(await evaluate({ trades: [{ pnlFraction: 0.03, holdingDays: null }] })).toMatchObject({ code: 0, output: { ok: true,
      data: { sortino: 0, perTrade: { tradeSamples: 1, durationSamples: 0 }, monteCarlo: { drawdownP50: null, drawdownP95: null } },
    } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await evaluate({ ...manifest, periodsPerYear: 0 })).toMatchObject(invalid);
    expect(await evaluate({ ...manifest, periodicReturns: [null] })).toMatchObject(invalid);
    expect(await evaluate({ trades: [{ pnlFraction: 0.03, holdingDays: -2 }] })).toMatchObject(invalid);
    expect(await evaluate({ trades: [{ pnlFraction: 0.03 }] })).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

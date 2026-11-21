import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI replays dated walk-forward evidence and rejects an invalid manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-walk-forward-cli-"));
  const path = join(root, "folds.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const replay = async (value: unknown) => {
    writeFileSync(path, JSON.stringify(value));
    return run("observation", "replay-walk-forward", "--manifest", path);
  };

  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-walk-forward",
      description: "Replay TSP walk-forward validation from a local fold manifest" });

    const window = { index: 0, trainStart: "2024-01-01", trainEnd: "2024-03-31", testStart: "2024-04-01", testEnd: "2024-05-01" };
    const training = { candidateId: "candidate-a", objective: 2 };
    const heldOut = { candidateId: "candidate-a", objective: 1.5, totalReturn: 0.1, tradeCount: 12 };
    const manifest = { start: "2024-01-01", end: "2024-05-31", trainDays: 90, testDays: 30, stepDays: 30,
      objective: "sortino", direction: "max", folds: [{ window, training, heldOut }] };
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", formulaVersion: "tsp-walk-forward-v1",
      plannedFoldCount: 2, validFoldCount: 1, skippedFoldCount: 1, overlappingTestWindows: false,
      folds: [{ window, candidateId: "candidate-a", degraded: true }],
      skipped: [{ reason: "missing-training" }],
      summary: { averageTrainObjective: 2, averageHeldOutObjective: 1.5, compoundedHeldOutReturn: 0.1,
        degradation: 0.5, profitableFoldShare: 1, equityCurve: [{ fold: 0, date: "2024-05-01", value: 1.1 }] },
    } } });
    expect(await replay(manifest)).toEqual(result);

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run("observation", "replay-walk-forward")).toMatchObject(invalid);
    expect(await replay({ ...manifest, folds: [{ window, training, heldOut: { ...heldOut, candidateId: "other" } }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, folds: [{ window, training }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, start: "1980-01-01", stepDays: 1, folds: [] })).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
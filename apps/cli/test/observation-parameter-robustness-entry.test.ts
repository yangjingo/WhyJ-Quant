import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI repeats the parameter ranking and fails closed on an invalid candidate manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-parameter-robustness-cli-"));
  const path = join(root, "candidates.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const replay = async (manifest: unknown) => {
    writeFileSync(path, JSON.stringify(manifest));
    return run("observation", "replay-parameter-robustness", "--manifest", path);
  };

  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-parameter-robustness",
      description: "Replay TSP parameter robustness from a local candidate manifest" });
    const windows = [{ start: "2024-01-01", end: "2024-01-15" }, { start: "2024-01-16", end: "2024-01-30" },
      { start: "2024-01-31", end: "2024-02-13" }];
    const candidates = [[2.98, 2.98, 2.98], [3, 3, 3], [1, 5, 3]].map((objectives, index) => ({
      params: { p: index + 1 }, segments: windows.map((window, i) => ({ ...window, objective: objectives[i], tradeCount: 10 })),
    }));
    const manifest = { start: "2024-01-01", end: "2024-02-13", segmentCount: 3, objective: "sortino", candidates };
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-parameter-robustness-v1", windows, bestScore: 3, bestParams: { p: 2 },
      convergence: { label: "majority", maxCount: 2 }, plateau: { label: "slope", ratio: 0.5, validNeighborCount: 2 },
      results: [{ rank: 1, params: { p: 2 } }, { rank: 2, params: { p: 1 } }, { rank: 3, params: { p: 3 } }],
    } } });
    expect(await replay(manifest)).toEqual(result);

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, objective: "win_rate" })).toMatchObject(invalid);
    expect(await replay({ ...manifest, candidates: [candidates[0], candidates[0]] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, candidates: [{ ...candidates[0], segments: [...candidates[0]!.segments].reverse() }] }))
      .toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
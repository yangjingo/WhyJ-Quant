import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI replays an offline screener-score manifest and reports invalid evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-screener-score-cli-"));
  const path = join(root, "scores.json");
  const input = {
    tradeDate: "2024-03-04", candidateRevision: "a".repeat(64), strategy: { id: "fixture", revision: "b".repeat(64) },
    candidateSymbols: ["600001.SH", "600002.SH", "600003.SH"],
    columns: [{ field: "turnover", values: [1, 2, 3] }],
    weights: [{ field: "turnover", weight: 2, direction: "low" }, { field: "unknown", weight: 9 }],
    displayLimit: 2,
  };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const command = ["observation", "replay-screener-score", "--manifest", path];
  try {
    const original = JSON.stringify({ version: 1, input });
    writeFileSync(path, original);
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation replay-screener-score");
    const report = await run(...command);
    expect(report).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", candidateRevision: input.candidateRevision, strategy: input.strategy, tradeDate: input.tradeDate,
      formula: { id: "tsp_screener_score", version: 1 },
      scoring: { omittedFields: ["unknown"] }, order: { field: "score", limit: 2 },
      selected: [{ symbol: "600001.SH", score: 100, position: 1 }, { symbol: "600002.SH", score: 50, position: 2 }],
    } } });
    expect(await run(...command)).toEqual(report);
    expect(readFileSync(path, "utf8")).toBe(original);
    for (const malformed of [{ version: 2, input }, { version: 1, input: { ...input, columns: [{ field: "turnover", values: [2] }] } }]) {
      writeFileSync(path, JSON.stringify(malformed));
      expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

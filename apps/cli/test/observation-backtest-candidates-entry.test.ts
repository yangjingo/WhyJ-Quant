import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTspBacktestCandidates, type TspBacktestCandidateInput } from "../../../src/quant/index.ts";

test("actual CLI replays independent candidates with the same fixed Quant evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-backtest-candidates-cli-"));
  const path = join(root, "candidates.json");
  const evidence: TspBacktestCandidateInput = {
    candidateCount: 5,
    execution: { buy_no_next_bar: 1, pending_exit: 1 },
    trades: [
      { symbol: "600000.SH", exitDate: "2025-03-04", pnlFraction: -0.23, holdingDays: 2 },
      { symbol: "000001.SZ", exitDate: "2025-03-03", pnlFraction: 0.06, holdingDays: 1 },
      { symbol: "600000.SH", exitDate: "2025-03-03", pnlFraction: 0, holdingDays: 0 },
    ],
  };
  const manifest = { schemaVersion: 1, ...evidence };
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function run(...args: string[]) {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    return run("observation", "replay-backtest-candidates", "--manifest", path);
  }
  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation replay-backtest-candidates",
      description: "Replay fixed TSP independent candidate backtest metrics",
    });
    const result = await replay(manifest);
    expect(result.code).toBe(0);
    expect(result.output.ok).toBe(true);
    expect(result.output.data).toEqual(computeTspBacktestCandidates(evidence));
    expect(await replay(manifest)).toEqual(result);
    expect(await replay({ ...manifest, trades: [] })).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "unavailable", reason: "no-executable-trades", candidateCount: 5, tradeCount: 0, execution: evidence.execution,
    } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const patch of [{ schemaVersion: 2 }, { asOf: "2025-03-04" },
      { trades: [{ ...evidence.trades[0], extra: true }] },
      { execution: { pending_exit: -1 } }, { trades: [{ ...evidence.trades[0], exitDate: "2025-02-30" }] }]) {
      expect(await replay({ ...manifest, ...patch })).toMatchObject(invalid);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTspBacktestFactorAttribution, type TspBacktestFactorAttributionInput } from "../../../src/quant/index.ts";

test("CLI replays fixed backtest entry-factor attribution without provider credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-factor-attribution-cli-"));
  const manifest = join(root, "factor attribution.json");
  const evidence: TspBacktestFactorAttributionInput = {
    factors: ["rs", "volume"],
    snapshots: [
      { symbol: "000001.SZ", tradeDate: "2025-03-03", values: { rs: 0.5, volume: 0 } },
      { symbol: "600000.SH", tradeDate: "2025-03-04", values: { rs: 0.3, volume: null } },
    ],
    trades: [
      { symbol: "000001.SZ", entrySignalDate: "2025-03-03", entryDate: "2025-03-04", pnlFraction: 0.06 },
      { symbol: "600000.SH", entryDate: "2025-03-04", pnlFraction: 0 },
    ],
  };
  const value = { schemaVersion: 1, ...evidence };
  const privateInput = "private_fixture_marker";
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function run(...args: string[]) {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(privateInput);
    return { code, output: JSON.parse(stdout) };
  }
  function replay(input: unknown) {
    writeFileSync(manifest, JSON.stringify(input));
    return run("observation", "replay-backtest-factor-attribution", "--manifest", manifest);
  }
  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-backtest-factor-attribution",
      description: "Replay TSP entry-factor attribution from fixed trades and snapshots" });
    const result = await replay(value);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", status: "available", coverage: { matchedTrades: 2, winTrades: 1, nonWinTrades: 1 },
    } } });
    expect(result.output.data).toEqual(computeTspBacktestFactorAttribution(evidence));
    expect(result.output.data.factors).toContainEqual({ factor: "volume", winMean: 0, nonWinMean: null, difference: null,
      winSamples: 1, nonWinSamples: 0 });
    expect(await replay({ ...value, snapshots: [] })).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "unavailable", coverage: { matchedTrades: 0, winTrades: 1, nonWinTrades: 1 }, factors: [],
    } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const patch of [
      { schemaVersion: 2 }, { factors: ["rs", "rs"] }, { snapshots: [...evidence.snapshots, evidence.snapshots[0]] },
      { snapshots: [{ ...evidence.snapshots[0], values: { [privateInput]: 1 } }] },
      { snapshots: [{ ...evidence.snapshots[0], values: { rs: privateInput } }] },
      { trades: [{ ...evidence.trades[0], entryDate: "2025-03-02" }] },
      { trades: [{ ...evidence.trades[0], symbol: privateInput }] },
    ]) expect(await replay({ ...value, ...patch })).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

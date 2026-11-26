import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTspBacktestDailyTrades, type TspBacktestDailyTradesInput } from "../../../src/quant/index.ts";

test("actual CLI replays fixed daily trade amounts and preserves partial evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-backtest-daily-trades-cli-"));
  const path = join(root, "daily trades.json");
  const evidence: TspBacktestDailyTradesInput = { currency: "CNY", trades: [
    { symbol: "600000.SH", entryDate: "2025-01-06", exitDate: "2025-01-08", entryValue: 1200, exitValue: 1310, pnlAmount: 100 },
    { symbol: "000001.SZ", entryDate: "2025-01-07", exitDate: "2025-01-07", entryValue: 900, exitValue: 880, pnlAmount: -20 },
    { symbol: "000001.SZ", entryDate: "2025-01-06", exitDate: "2025-01-08", entryValue: 100, exitValue: 100, pnlAmount: 0 },
  ] };
  const manifest = { schemaVersion: 1, ...evidence };
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
    return { code, output: JSON.parse(stdout) };
  }
  function replay(value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    return run("observation", "replay-backtest-daily-trades", "--manifest", path);
  }
  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-backtest-daily-trades",
      description: "Replay TSP daily trade amounts and cumulative realized PnL" });
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", tradeCount: 3, rows: [
      { date: "2025-01-08", sellCount: 2, cumulativePnl: 80 },
      { date: "2025-01-07", buyCount: 1, sellCount: 1, realizedPnl: -20, cumulativePnl: -20 },
      { date: "2025-01-06", buyCount: 2, realizedPnl: 0, cumulativePnl: 0 },
    ] } } });
    expect(result.output.data).toEqual(computeTspBacktestDailyTrades(evidence));
    expect(await replay({ ...manifest, trades: [] })).toMatchObject({ code: 0, output: { ok: true, data: { rows: [], tradeCount: 0 } } });
    const partial = { ...manifest, trades: [
      evidence.trades[0]!, { ...evidence.trades[1]!, pnlAmount: null }, evidence.trades[2]!,
    ] };
    expect(await replay(partial)).toMatchObject({ code: 0, output: { ok: true, data: { rows: [
      { date: "2025-01-08", realizedPnl: 100, cumulativePnl: null },
      { date: "2025-01-07", realizedPnl: null, cumulativePnl: null, observedRealizedPnl: 0 },
      { date: "2025-01-06", realizedPnl: 0, cumulativePnl: 0 },
    ] } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, currency: "USD" })).toMatchObject(invalid);
    for (const patch of [
      { exitDate: "2025-01-05" }, { entryDate: "2025-02-30" }, { symbol: "600000" },
      { pnlAmount: "100" }, { entryValue: undefined }, { extra: true },
    ]) expect(await replay({ ...manifest, trades: [{ ...evidence.trades[0]!, ...patch }] })).toMatchObject(invalid);
    writeFileSync(path, JSON.stringify(manifest).padEnd(24 * 1024 * 1024 + 1));
    expect(await run("observation", "replay-backtest-daily-trades", "--manifest", path)).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

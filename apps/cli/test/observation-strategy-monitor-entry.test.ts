import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const action = "replay-strategy-monitor-alerts";
const day = "2026-05-08";
const time = Date.parse(`${day}T09:30:00+08:00`);

function complete(step: number, symbols: readonly string[], buy = false) {
  return {
    revision: `result-${step}`, tradeDate: day, evaluatedAt: time + step, status: "completed",
    rows: symbols.map(symbol => ({ symbol, score: 50 })),
    buySignals: buy ? symbols.map(symbol => ({ symbol, signals: ["entry"] })) : [], sellSignals: [],
  };
}

test("CLI replays stock and ETF strategy results offline and rejects incomplete evidence without leaking paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-strategy-monitor-cli-"));
  const manifest = join(root, "private strategy monitor.json");
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function run(...args: string[]) {
    const child = Bun.spawn([...entry, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 20_000,
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, stdout };
  }
  async function invoke(value: unknown) {
    writeFileSync(manifest, JSON.stringify(value));
    const { code, stdout } = await run("--json", "observation", action, "--manifest", manifest);
    return { code, output: JSON.parse(stdout) };
  }
  try {
    const help = await run("--json", "--help");
    expect(JSON.parse(help.stdout).data.commands).toContainEqual({ command: `whyj --json observation ${action}`,
      description: "Replay strategy signals and pool changes from captured results" });
    expect((await run("--help")).stdout).toContain(`whyj --json observation ${action} --manifest PATH`);
    const rule = { id: "strategy_monitor", revision: "rule-v1", strategyId: "momentum", strategyRevision: "strategy-v2",
      assetType: "stock", eventTypes: ["buy_signal", "sell_signal", "pool_entry", "pool_exit"], cooldownMs: 0,
      scoreMin: 50, scoreMax: 50 };
    const stocks = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH", "600006.SH"];
    const lag = { revision: "unavailable", tradeDate: day, evaluatedAt: time + 1, status: "unavailable" };
    const captures = [complete(0, []), lag, complete(2, stocks, true), complete(3, [])];
    const input = { schemaVersion: 1, rule, captures };
    const stock = await invoke(input);
    expect(stock).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", formulaVersion: 1,
      referenceRevision: expect.stringMatching(/^[a-f0-9]{40}$/), ruleId: rule.id, ruleRevision: rule.revision,
      strategyId: rule.strategyId, strategyRevision: rule.strategyRevision, assetType: "stock" } } });
    const evaluations = stock.output.data.evaluations;
    expect(evaluations.map(({ status, captureRevision }: { status: string; captureRevision: string }) => [status, captureRevision])).toEqual([
      ["baseline", "result-0"], ["unavailable", "unavailable"], ["completed", "result-2"], ["completed", "result-3"],
    ]);
    expect(evaluations[2].events).toEqual([
      { kind: "buy_signal", batch: true, members: stocks.map(symbol => ({ symbol, signals: ["entry"] })) },
      { kind: "pool_entry", batch: true, members: stocks.map(symbol => ({ symbol, signals: [] })) },
    ]);
    expect(evaluations[3]).toMatchObject({ pool: [], events: [{ kind: "pool_exit", batch: true,
      members: stocks.map(symbol => ({ symbol, signals: [] })) }] });
    expect(await invoke(input)).toEqual(stock);

    const etf = await invoke({ ...input, rule: { ...rule, assetType: "etf" }, captures: [complete(0, []), complete(2, ["510300.SH"], true)] });
    expect(etf).toMatchObject({ code: 0, output: { ok: true, data: { assetType: "etf", evaluations: [
      { events: [] }, { events: [{ kind: "buy_signal", batch: false, members: [{ symbol: "510300.SH", signals: ["entry"] }] },
        { kind: "pool_entry", batch: false, members: [{ symbol: "510300.SH", signals: [] }] }] },
    ] } } });

    for (const malformed of [
      { ...input, schemaVersion: 2 },
      { ...input, rule: { ...rule, strategyRevision: undefined } },
      { ...input, rule: { ...rule, assetType: "etf" } },
      { ...input, captures: [captures[0], { ...captures[0], evaluatedAt: time + 1 }] },
      { ...input, captures: [{ ...lag, status: undefined }] },
      { ...input, captures: [{ ...lag, rows: [] }] },
      { ...input, captures: [{ ...complete(2, stocks), sellSignals: undefined }] },
      { ...input, captures: [{ ...complete(2, stocks), rows: [{ symbol: stocks[0] }] }] },
      { ...input, captures: [{ ...complete(2, stocks), buySignals: [{ symbol: stocks[0], signals: ["x", "x"] }] }] },
    ]) {
      const bad = await invoke(malformed);
      expect(bad).toMatchObject({ code: 1, output: { ok: false, error: { code: "invalid_arguments" } } });
      expect(bad.output).not.toHaveProperty("data");
      expect(JSON.stringify(bad.output)).not.toContain("private strategy monitor.json");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

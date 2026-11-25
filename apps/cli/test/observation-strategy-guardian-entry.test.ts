import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI plans and replays strategy health from fixed manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-guardian-cli-"));
  const path = join(root, "guardian.json");
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function runProcess(...args: string[]) {
    const child = Bun.spawn([...entry, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TUSHARE_TOKEN: "", WHYJ_QUANT_TICKFLOW_API_KEY: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, stdout };
  }
  async function run(...args: string[]) {
    const { code, stdout } = await runProcess("--json", ...args);
    return { code, output: JSON.parse(stdout) };
  }
  function invoke(command: string, manifest: unknown) {
    writeFileSync(path, JSON.stringify(manifest));
    return run("observation", command, "--manifest", path);
  }
  const sessions = ["2026-01-02", ...Array.from({ length: 33 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5 + i))).filter(date => date.getUTCDay() % 6 !== 0)
    .map(date => date.toISOString().slice(0, 10))];
  const scope = { schemaVersion: 1, dataAsOf: "2026-01-02", sessions, thresholds: { minNewTradingDays: 25 } };
  const windows = [{ start: "2026-01-05", end: "2026-01-21" }, { start: "2026-01-22", end: "2026-02-06" }];
  const plan = (manifest: unknown) => invoke("plan-strategy-guardian", manifest);
  const replay = (manifest: unknown) => invoke("replay-strategy-guardian", manifest);
  const check = {
    ...scope, strategyId: "value-momentum", objective: "sharpe", baselineScore: 2, baselineTradeCount: 120,
    segments: windows.map(window => ({ ...window, objective: 0.5, tradeCount: 20, maxDrawdownFraction: -0.12 })),
  };
  try {
    const help = await run("--help");
    const commands = help.output.data.commands.map((entry: { command: string }) => entry.command);
    expect(commands).toContain("whyj --json observation plan-strategy-guardian");
    expect(commands).toContain("whyj --json observation replay-strategy-guardian");
    expect(commands).toContain("whyj --json observation replay-strategy-guardian-history");
    const plainHelp = await runProcess("--help");
    expect(plainHelp.stdout).toContain("whyj --json observation replay-strategy-guardian-history --manifest PATH");
    expect(await plan(scope)).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-strategy-guardian-v1", status: "ready", newTradingDays: 25, windows,
      thresholds: { minNewTradingDays: 25, maxSegments: 4, watchFraction: 0.2, retireFraction: 0.5, maxSoftDrawdownFraction: -0.3 },
    } } });
    const verdict = await replay(check);
    expect(verdict).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-strategy-guardian-v1", status: "retired", reasons: ["retirement-degradation"],
      degradationFraction: 0.75, plan: { windows }, evidence: { currentScore: 0.5, tradeCount: 40, worstDrawdownFraction: -0.12 },
    } } });
    expect(await replay(check)).toEqual(verdict);
    expect(await replay({ ...check, segments: check.segments.map(segment => ({ ...segment, objective: 2 })) }))
      .toMatchObject({ code: 0, output: { ok: true, data: { status: "healthy", degradationFraction: 0 } } });
    expect(await replay({ ...check, segments: [
      { ...check.segments[0]!, objective: null, tradeCount: null, maxDrawdownFraction: null }, check.segments[1]!,
    ] })).toMatchObject({ code: 0, output: { ok: true, data: {
      status: "watch", evidence: { missingScoreSegments: 1, incompleteData: true },
    } } });
    expect(await replay({ ...check, segments: check.segments.map(segment => ({ ...segment, objective: null })) }))
      .toMatchObject({ code: 0, output: { ok: true, data: { status: "unavailable", reason: "all-segment-scores-missing" } } });
    expect(await replay({ ...check, sessions: [], segments: [] })).toMatchObject({
      code: 0, output: { ok: true, data: { status: "skipped", reason: "insufficient-new-data" } },
    });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const history = { schemaVersion: 1, strategyId: check.strategyId, checks: [
      { verdict: "watch" }, { verdict: "watch", error: "partial" }, { verdict: null },
      { verdict: "watch", error: "" }, { verdict: "watch", error: null },
    ] };
    const replayHistory = (manifest: unknown) => invoke("replay-strategy-guardian-history", manifest);
    const historyResult = await replayHistory(history);
    expect(historyResult).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-strategy-guardian-history-v1", strategyId: check.strategyId,
      checkCount: 5, consecutiveWatch: 2, alert: true,
    } } });
    expect(await replayHistory(history)).toEqual(historyResult);
    expect(await replayHistory({ ...history, checks: [] })).toMatchObject({
      code: 0, output: { ok: true, data: { checkCount: 0, consecutiveWatch: 0, alert: false } },
    });
    expect(await replayHistory({ ...history, checks: [...history.checks, {}] })).toMatchObject({
      code: 0, output: { ok: true, data: { checkCount: 6, consecutiveWatch: 0, alert: false } },
    });
    for (const malformed of [{ verdict: "unknown" }, { verdict: "watch", error: false }, { extra: true }, null]) {
      expect(await replayHistory({ ...history, checks: [malformed] })).toMatchObject(invalid);
    }
    expect(await replayHistory({ ...history, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await plan({ ...scope, thresholds: { watchFraction: "0.2" } })).toMatchObject(invalid);
    expect(await plan({ ...scope, unexpected: true })).toMatchObject(invalid);
    expect(await replay({ ...check, objective: "win_rate" })).toMatchObject(invalid);
    expect(await replay({ ...check, segments: check.segments.toReversed() })).toMatchObject(invalid);
    expect(await replay({ ...check, segments: check.segments.map(segment => ({ ...segment, maxDrawdownFraction: 0.2 })) }))
      .toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

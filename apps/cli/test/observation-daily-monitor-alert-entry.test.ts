import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayTspDailyMonitorAlerts, type DailyMonitorAlertReplayRequest } from "../../../src/runtime/data/daily-monitor-alert-replay.ts";
import { archiveDailyTradingLimits, archiveTradingDateObservations, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";

const symbol = "600001.SH";
const missingSymbol = "000001.SZ";
const dates = ["2026-03-11", "2026-03-12"];
const observedAt = "2026-03-13T03:00:00Z";
const requested = { startDate: dates[0]!, endDate: dates[1]! };

function archivePrices(adjustment: "none" | "forward", closes: number[]) {
  return archiveTradingDateObservations(dates.map((tradeDate, index): StoredTradingDateBarObservation => {
    const close = closes[index]!;
    return {
      kind: "trading_date_daily_bar", schemaVersion: 2, symbol, tradeDate,
      sourceTimestamp: Date.parse(tradeDate + "T15:00:00+08:00"), requested,
      market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
      observedAt, interval: "1d", adjustment, volumeUnit: "unknown", amountUnit: "unknown", coverage: "unknown",
      values: { open: close, high: close, low: close, close, volume: 100, amount: null },
    };
  }));
}

async function runCli(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 20_000,
    env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  return { code, output: JSON.parse(stdout) };
}

test("actual CLI replays fixed daily monitor decisions offline and rejects invalid evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-daily-monitor-cli-"));
  const previous = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  try {
    const [ref, rawArchiveRef, tradingLimitArchiveRef] = await Promise.all([
      archivePrices("forward", [10.5, 11.5]), archivePrices("none", [11, 12]),
      archiveDailyTradingLimits({
        symbol, market: "A", source: "tushare", endpoint: "stk_limit", observedAt, priceUnit: "CNY", coverage: "unknown", requested,
        rows: dates.map((tradeDate, index) => ({ tradeDate, previousClose: 10 + index, limitUp: 11 + index, limitDown: 9 + index })),
      }),
    ]);
    const rule: DailyMonitorAlertReplayRequest["rule"] = {
      id: "limit_price", revision: "rule-v1", type: "signal", assetType: "stock", logic: "and", cooldownMs: 86_400_000, severity: "warn",
      scope: { kind: "watchlist_group", membershipRevision: "watchlist-v1", symbols: [symbol, missingSymbol] },
      conditions: [{ field: "signal_limit_up", op: "truth" }, { field: "close", op: ">", unit: "CNY", value: 10 }],
    };
    const scope = { rule, adjustment: "forward" as const, roster: [symbol, missingSymbol],
      sessions: dates.map(tradeDate => ({ tradeDate, evaluatedAt: Date.parse(tradeDate + "T15:10:00+08:00") })) };
    const manifest = { version: 1, ...scope, histories: [
      { symbol, dailyRevision: ref.revision, rawRevision: rawArchiveRef.revision, limitsRevision: tradingLimitArchiveRef.revision },
    ] };
    const path = join(root, "daily-monitor.json");
    const replay = async (value: unknown) => {
      writeFileSync(path, JSON.stringify(value));
      return runCli(root, "observation", "replay-daily-monitor-alerts", "--manifest", path);
    };

    const help = await runCli(root, "--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-daily-monitor-alerts",
      description: "Replay daily monitor alert decisions from local stock archives" });
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: { adjustment: "forward", basis: "historical-reconstruction",
      evaluations: dates.map((tradeDate, index) => ({ tradeDate, missingSymbols: [missingSymbol],
        events: [{ symbol, closeCny: 10.5 + index, operands: { signal_limit_up: true, close: 10.5 + index } }] })),
    } } });
    const runtime = await replayTspDailyMonitorAlerts({ ...scope, histories: [{ symbol, ref, exchange: { rawArchiveRef, tradingLimitArchiveRef } }] });
    expect(result.output.data).toEqual(runtime);
    expect(runtime.evaluations[0]?.events[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(await replay(manifest)).toEqual(result);
    const daily = await runCli(root, "observation", "replay-daily", "--revision", ref.revision);
    expect(daily).toMatchObject({ code: 0, output: { ok: true, data: { archiveRef: ref } } });
    expect(daily.output.data.daily.fields).toHaveLength(37);

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, version: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, sessions: [{ ...scope.sessions[0], extra: true }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, sessions: [{ ...scope.sessions[0], evaluatedAt: scope.sessions[0]!.evaluatedAt - 3_600_000 }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, histories: [manifest.histories[0], manifest.histories[0]] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, rule: { ...rule, conditions: [{ field: "close", op: ">", unit: "fraction", value: 10 }] } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, rule: { ...rule, conditions: [{ field: "unlisted_signal", op: "truth" }] } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, rule: { ...rule, scope: { kind: "symbols", symbols: ["600008.SH"] } } })).toMatchObject(invalid);
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await replay({ ...manifest, histories: [{ ...manifest.histories[0], dailyRevision: "0".repeat(64) }] })).toMatchObject(unavailable);
    expect(await replay({ ...manifest, adjustment: "none" })).toMatchObject(unavailable);
    writeFileSync(join(root, "data", "observation-archives-v2", ref.revision + ".json"), "{}");
    expect(await replay(manifest)).toMatchObject(unavailable);
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

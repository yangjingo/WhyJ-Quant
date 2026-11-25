import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayTspIntradayMonitorAlerts, type IntradayMonitorAlertReplayRequest } from "../../../src/runtime/data/intraday-monitor-alert-replay.ts";
import { archiveDailyTradingLimits, archiveHistoricalMinuteObservations, type StoredHistoricalMinuteBatch } from "../../../src/storage/index.ts";

const tradeDate = "2024-03-04", symbol = "600001.SH", missingSymbol = "000001.SZ";
const observedAt = "2024-03-06T00:00:00Z";
const requested = { startDate: tradeDate, endDate: tradeDate };
const prices: readonly (readonly [string, number])[] = [["09:30", 99], ["09:31", 9], ["09:32", 11], ["09:34", 12]];
const batch: StoredHistoricalMinuteBatch = {
  symbol, market: "A", source: "tushare", endpoint: "stk_mins", timeZone: "Asia/Shanghai", interval: "1m",
  volumeUnit: "share", amountUnit: "CNY", coverage: "unknown", finality: "unknown", adjustment: "unknown", observedAt, requested,
  rows: prices.map(([end, close], index) => ({ tradeTime: `${tradeDate} ${end}:00`, openingBoundary: index === 0,
    open: close, high: close, low: close, close, volume: 100, amount: close * 100 })),
};

async function runCli(root: string, ...args: string[]) {
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  const child = Bun.spawn([...entry, "--json", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 20_000,
    env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  return { code, output: JSON.parse(stdout) };
}

test("actual CLI replays the exact minute and custom monitor decisions from local evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-minute-monitor-cli-"));
  const previous = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  try {
    const ref = await archiveHistoricalMinuteObservations(batch);
    const previousCloseRef = await archiveDailyTradingLimits({ symbol, market: "A", source: "tushare", endpoint: "stk_limit",
      observedAt, requested, coverage: "unknown", priceUnit: "CNY",
      rows: [{ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 }] });
    const priceBasis = "caller-confirmed-same-basis" as const;
    const rule: IntradayMonitorAlertReplayRequest["rule"] = {
      id: "minute_cross", revision: "rule-v1", type: "signal", assetType: "stock", logic: "and", cooldownMs: 60_000, severity: "warn",
      scope: { kind: "watchlist_group", membershipRevision: "desk-v1", symbols: [symbol, missingSymbol] },
      conditions: [{ field: "signal_intraday_zero_cross_up", op: "truth" }, { field: "csgi_cross_ten", op: "truth" },
        { field: "volume", op: ">=", value: 100, unit: "share" }],
    };
    const customSignals: NonNullable<IntradayMonitorAlertReplayRequest["customSignals"]> = [
      { id: "cross_ten", conditions: [{ left: "price", op: "cross_up", right: 10 }] },
    ];
    const scope = { rule, roster: [symbol, missingSymbol], customSignals,
      slots: ["09:30", "09:31", "09:32", "09:33"].map(minute => ({ tradeDate, minute })) };
    const history = { symbol, minuteRevision: ref.revision, previousClose: { revision: previousCloseRef.revision, priceBasis } };
    const manifest = { version: 1, ...scope, histories: [history] };
    const path = join(root, "intraday-monitor.json");
    const replay = async (value: unknown) => {
      writeFileSync(path, JSON.stringify(value));
      return runCli(root, "observation", "replay-intraday-monitor-alerts", "--manifest", path);
    };

    const help = await runCli(root, "--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-intraday-monitor-alerts",
      description: "Replay closed-minute monitor alerts from local stock archives" });
    const result = await replay(manifest);
    const runtime = await replayTspIntradayMonitorAlerts({ ...scope, histories: [
      { symbol, ref, previousClose: { ref: previousCloseRef, priceBasis } },
    ] });
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: { membershipRevision: "desk-v1", granularity: "1m",
      histories: [{ ref, openingBoundaryCount: 1, previousClose: { archiveRef: previousCloseRef } }],
    } } });
    expect(result.output.data).toEqual(runtime);
    expect(runtime.evaluations.map(slot => [slot.minute, slot.missingSymbols, slot.events.length])).toEqual([
      ["09:30", [missingSymbol], 0], ["09:31", [missingSymbol], 1], ["09:32", [symbol, missingSymbol], 0], ["09:33", [missingSymbol], 0],
    ]);
    expect(runtime.evaluations[1]?.events[0]).toMatchObject({ symbol, originalTradeTime: `${tradeDate} 09:32:00`,
      operands: { signal_intraday_zero_cross_up: true, csgi_cross_ten: true, volume: 100 } });
    expect(runtime.evaluations[1]?.events[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(await replay(manifest)).toEqual(result);

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, version: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, slots: [{ tradeDate, minute: "12:00" }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, slots: [...scope.slots].reverse() })).toMatchObject(invalid);
    expect(await replay({ ...manifest, histories: [history, history] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, histories: [{ ...history, spot: true }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, rule: { ...rule, conditions: [{ field: "volume", op: ">", value: 1, unit: "hand" }] } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, customSignals: [] })).toMatchObject(invalid);

    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await replay({ ...manifest, histories: [{ ...history, minuteRevision: "0".repeat(64) }] })).toMatchObject(unavailable);
    expect(await replay({ ...manifest, histories: [{ symbol: missingSymbol, minuteRevision: ref.revision }] })).toMatchObject(unavailable);
    writeFileSync(join(root, "data", "historical-minute-archives-v1", ref.revision + ".json"), "{}");
    expect(await replay(manifest)).toMatchObject(unavailable);
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveHistoricalMinuteObservations, loadHistoricalMinuteArchive, type StoredHistoricalMinuteBatch } from "../../../src/storage/index.ts";

test("CLI replays exact custom minute events offline and distinguishes bad inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-intraday-signal-cli-"));
  const manifest = join(root, "signal.json");
  const prior = process.env.OHQUANT_DIR;
  process.env.OHQUANT_DIR = root;
  const date = "2024-01-02", symbol = "600000.SH";
  const batch: StoredHistoricalMinuteBatch = {
    symbol, market: "A", source: "tushare", endpoint: "stk_mins", timeZone: "Asia/Shanghai",
    interval: "1m", volumeUnit: "share", amountUnit: "CNY", coverage: "unknown", finality: "unknown", adjustment: "unknown",
    observedAt: "2024-01-03T03:00:00Z", requested: { startDate: date, endDate: date },
    rows: [9, 10, 11].map((close, index) => ({
      tradeTime: `${date} 09:${31 + index}:00`, openingBoundary: false, open: close, high: close, low: close,
      close, volume: 100, amount: close * 100,
    })),
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
  try {
    const ref = await archiveHistoricalMinuteObservations(batch);
    const record = { version: 1, minuteRevision: ref.revision,
      rule: { id: "cross_ten", conditions: [{ left: "price", op: "cross_up", right: 10 }] } };
    const original = JSON.stringify(record);
    writeFileSync(manifest, original);
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation replay-intraday-signal");
    const command = ["observation", "replay-intraday-signal", "--manifest", manifest];
    const actual = await run(...command);
    expect(actual).toMatchObject({ code: 0, output: { ok: true, data: {
      archiveRef: ref, rule: { id: "cross_ten", minBars: 0 }, producer: "whyj",
      formula: { id: "tsp_intraday_custom_signal", version: 1 },
      events: [{ symbol, tradingDate: date, minute: "09:32", originalTradeTime: "2024-01-02 09:33:00",
        values: { price: 11 }, eventId: expect.any(String) }],
    } } });
    expect(await run(...command)).toEqual(actual);
    expect(readFileSync(manifest, "utf8")).toBe(original);
    expect(await loadHistoricalMinuteArchive(ref)).toEqual(batch);
    writeFileSync(manifest, JSON.stringify({ ...record, rule: { ...record.rule, conditions: [] } }));
    expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    writeFileSync(manifest, JSON.stringify({ ...record, minuteRevision: "f".repeat(64) }));
    expect(await run(...command)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

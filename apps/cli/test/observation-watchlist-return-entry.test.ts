import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveTradingDateObservations, loadPanelPortfolio, savePanelPortfolio, type StoredTradingDateBarObservation } from "../../../src/storage/index.ts";

const symbol = "600519.SH", asOf = "2024-03-04";
function observation(tradeDate: string, close: number): StoredTradingDateBarObservation {
  return { schemaVersion: 2, kind: "trading_date_daily_bar", symbol, tradeDate,
    sourceTimestamp: Date.parse(tradeDate + "T15:00:00+08:00"), requested: { startDate: "2024-03-01", endDate: "2024-03-05" },
    market: "A", assetType: "stock", calendarTimeZone: "Asia/Shanghai", source: "tickflow", endpoint: "/v1/klines",
    observedAt: "2024-03-06T02:00:00Z", interval: "1d", adjustment: "forward", volumeUnit: "unknown",
    amountUnit: "unknown", coverage: "unknown", values: { open: close, high: close, low: close, close, volume: 0, amount: null },
  };
}

test("CLI combines local membership and fixed archives offline with revision evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-watchlist-return-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  process.env.OHQUANT_DIR = root;
  try {
    savePanelPortfolio({ ...loadPanelPortfolio(), symbols: [{ code: "600519", name: "fixture", added: "2024-03-02" }] });
    const membershipRevision = loadPanelPortfolio().revision!;
    const [ref, missingBaseline] = await Promise.all([
      archiveTradingDateObservations([observation("2024-03-01", 10), observation(asOf, 11), observation("2024-03-05", 22)]),
      archiveTradingDateObservations([observation(asOf, 11)]),
    ]);
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation replay-watchlist-return");
    const args = ["observation", "replay-watchlist-return", "--revision", ref.revision, "--as-of", asOf,
      "--membership-revision", membershipRevision];
    const report = await run(...args);
    expect(report).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { membership: { producer: "workspace", revision: membershipRevision, code: "600519", addedAt: "2024-03-02" },
        history: { ref, symbol, source: "tickflow" } },
      metrics: { producer: "whyj", status: "available", returnUnit: "fraction",
        baseline: { tradeDate: "2024-03-01", close: 10 }, latest: { tradeDate: asOf, close: 11 } },
    } } });
    expect(report.output.data.metrics.pctSinceAdded).toBeCloseTo(0.1, 12);
    expect(await run(...args)).toEqual(report);
    const unavailable = await run("observation", "replay-watchlist-return", "--revision", missingBaseline.revision, "--as-of", asOf);
    expect(unavailable.output.data.metrics).toMatchObject({ status: "missing-baseline", pctSinceAdded: null });
    expect(loadPanelPortfolio().revision).toBe(membershipRevision);
    savePanelPortfolio({ ...loadPanelPortfolio(), symbols: [{ code: symbol, name: "fixture", added: asOf }] });
    expect(await run(...args)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    expect(await run("observation", "replay-watchlist-return", "--revision", ref.revision))
      .toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
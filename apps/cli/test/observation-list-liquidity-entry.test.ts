import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveMarketCrossSection, loadMarketCrossSectionArchive, type StoredMarketCrossSection } from "../../../src/storage/index.ts";

test("CLI returns deterministic list liquidity with original source units", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-liquidity-cli-"));
  const prior = process.env.OHQUANT_DIR;
  const tradeDate = "2024-03-04", symbol = "600519.SH";
  const metadata = { tradeDate, observedAt: "2024-03-05T03:00:00Z", coverage: "unknown" } as const;
  const snapshot: StoredMarketCrossSection = {
    source: "tushare", market: "A", tradeDate,
    universe: { ...metadata, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: [{ symbol, name: "fixture", industry: null, listedOn: null }] },
    bars: { ...metadata, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand",
      amountUnit: "CNY-thousand", rows: [
        { symbol, open: 10, high: 11, low: 10, close: 10.5, exRightsPreviousClose: null,
          changeCny: null, returnPct: null, volume: 0, amount: null },
      ] },
    basics: { ...metadata, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares",
      marketValueUnit: "CNY-ten-thousand", rows: [
        { symbol, close: 10.4, turnoverPct: 4, freeFloatTurnoverPct: null, providerVolumeRatio: null,
          totalShares: 400, floatShares: 250, freeFloatShares: null, pe: null, peTtm: null, pb: null,
          totalMarketValue: null, circulatingMarketValue: 2_600 },
      ] },
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
  process.env.OHQUANT_DIR = root;
  try {
    const ref = await archiveMarketCrossSection(snapshot);
    const help = await run("--help");
    expect(help.output.data.commands.map((entry: { command: string }) => entry.command))
      .toContain("whyj --json observation replay-list-liquidity");
    const command = ["observation", "replay-list-liquidity", "--symbol", symbol];
    const args = [...command, "--revision", ref.revision];
    const report = await run(...args);
    expect(report).toMatchObject({ code: 0, output: { ok: true, data: {
      archiveRef: ref, symbol, tradeDate,
      observations: { producer: "tushare", dailyBasic: {
        marketValueUnit: "CNY-ten-thousand", row: { turnoverPct: 4, circulatingMarketValue: 2_600 },
      } },
      metrics: { producer: "whyj", floatValueCny: 26_250_000, turnoverPct: 0 },
    } } });
    expect(await run(...args)).toEqual(report);
    const unavailable = await archiveMarketCrossSection({ ...snapshot, basics: { ...snapshot.basics, rows: [] } });
    expect(await run(...command, "--revision", unavailable.revision)).toMatchObject({
      code: 0, output: { data: { metrics: { floatValueCny: null, turnoverPct: null } } },
    });
    expect(await run(...command, "--revision", "bad"))
      .toMatchObject({ code: 1, output: { error: { code: "invalid_arguments" } } });
    expect(await run("observation", "replay-list-liquidity", "--symbol", "600000.SH", "--revision", ref.revision))
      .toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    expect(await loadMarketCrossSectionArchive(ref)).toEqual(snapshot);
  } finally {
    if (prior === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

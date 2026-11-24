import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveValuationQuotePollCapture } from "../../../src/storage/index.ts";

test("actual CLI compares fixed paper accounts and rejects conflicting or missing revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-paper-comparison-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const manifestPath = join(root, "comparison manifest.json");
  const tradeDate = "2025-06-18", previous = "2025-06-17", currency = "CNY", symbol = "510330.SH";
  const startedAt = tradeDate + "T02:00:00Z", receivedAt = tradeDate + "T02:00:02Z";
  const sourceTimestamp = Date.parse(startedAt);
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(value: unknown) {
    writeFileSync(manifestPath, JSON.stringify(value));
    return run("observation", "replay-paper-comparison", "--manifest", manifestPath);
  }
  process.env.OHQUANT_DIR = root;
  try {
    const ref = await archiveValuationQuotePollCapture({
      tradeDate, startedAt, observedAt: receivedAt, source: "tickflow", endpoint: "/v1/quotes", market: "A",
      coverage: "unknown", units: "unknown", requestedSymbols: [symbol],
      rows: [{ symbol, timestamp: sourceTimestamp, receivedAt, lastPrice: 4.5, previousClose: 4, volume: 100, amount: null }],
    });
    const active = { accountId: "active", status: "active", cash: 300, initialCash: 700,
      positions: [{ symbol, assetType: "etf", quantity: 100, availableQuantity: 100, averageCost: 4, currency }],
      fills: [
        { fillId: "b", tradeDate: previous, symbol, side: "buy", quantity: 200, price: 4, fee: 2, currency },
        { fillId: "s", tradeDate, symbol, side: "sell", quantity: 100, price: 5, fee: 1, currency },
      ],
      finalizedNav: [{ tradeDate: previous, currency, nav: 700 }, { tradeDate, currency, nav: 770 }],
      dailyRevisions: [], valuationQuoteRevision: ref.revision,
    };
    const frozen = { accountId: "frozen", status: "frozen", cash: 800, initialCash: 800,
      positions: [], fills: [], finalizedNav: [], dailyRevisions: [],
    };
    const manifest = { schemaVersion: 1, tradeDate, currency, priceBasisConfirmation: "caller-confirmed-unadjusted-CNY",
      accounts: [active, frozen],
    };
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation replay-paper-comparison", description: "Compare simulated accounts and their finalized NAV from fixed archives",
    });
    const compared = await replay(manifest);
    expect(compared).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", tradeDate, accounts: [
        { accountId: "active", finalized: { equity: 700 }, snapshot: { equity: 750 },
          statistics: { realizedPnl: 98, roundTripCount: 1 }, nav: [{ normalizedNav: 1 }, { normalizedNav: 1.1 }] },
        { accountId: "frozen", snapshot: null, nav: [] },
      ],
      inputs: [
        { accountId: "active", snapshot: { quotePoll: { ref, source: "tickflow", quotes: [{ symbol, sourceTimestamp, receivedAt }] } } },
        { accountId: "frozen", snapshot: null },
      ],
    } } });
    expect(await replay(manifest)).toEqual(compared);
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, accounts: [active, active] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, accounts: [{ ...active, quoteRevision: ref.revision }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, accounts: [{ ...active, producer: "tickflow" }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, accounts: [{ ...active, valuationQuoteRevision: "0".repeat(64) }] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
  } finally {
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

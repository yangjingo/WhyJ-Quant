import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDailyTradingLimits, archiveMarketCrossSection, archiveRiskWarningObservations,
  archiveSectorObservations } from "../../../src/storage/index.ts";

const previousDate = "2025-01-02", activeDate = "2025-01-03", missingDate = "2025-01-06";
const observedAt = "2025-01-07T01:02:03Z";
const symbols = Array.from({ length: 6 }, (_, index) => `${600001 + index}.SH`);

function market(tradeDate: string, close: number) {
  const meta = { tradeDate, observedAt, coverage: "unknown" } as const;
  return archiveMarketCrossSection({ source: "tushare", market: "A", tradeDate,
    universe: { ...meta, endpoint: "bak_basic", universe: "provider-dated-stocks",
      members: symbols.map(symbol => ({ symbol, name: symbol, industry: null, listedOn: null })) },
    bars: { ...meta, endpoint: "daily", adjustment: "none", priceUnit: "CNY", volumeUnit: "hand", amountUnit: "CNY-thousand",
      rows: symbols.map((symbol, index) => ({ symbol, open: 10, high: close, low: 10, close, exRightsPreviousClose: 10,
        changeCny: close - 10, returnPct: close === 11 ? 10 : 0, volume: 10, amount: index + 1 })) },
    basics: { ...meta, endpoint: "daily_basic", priceUnit: "CNY", shareUnit: "ten-thousand-shares", marketValueUnit: "CNY-ten-thousand", rows: [] },
  });
}

async function fixture() {
  const marketRefs = await Promise.all([market(previousDate, 10), market(activeDate, 11)]);
  const limits = await Promise.all(symbols.map(symbol => archiveDailyTradingLimits({ source: "tushare", market: "A", endpoint: "stk_limit",
    symbol, observedAt, coverage: "unknown", priceUnit: "CNY", requested: { startDate: previousDate, endDate: activeDate },
    rows: [previousDate, activeDate].map(tradeDate => ({ tradeDate, previousClose: 10, limitUp: 11, limitDown: 9 })),
  })));
  const meta = { market: "A", source: "tushare", tradeDate: activeDate, observedAt, coverage: "unknown", taxonomy: "eastmoney" } as const;
  const catalog = await archiveSectorObservations({ ...meta, endpoint: "dc_index", kind: "concept", providerType: "概念板块",
    groups: [{ code: "BK1000.DC", name: "Fixture", level: null }, { code: "BK2000.DC", name: "Uncollected", level: null }] });
  const members = await archiveSectorObservations({ ...meta, endpoint: "dc_member", sectorCode: "BK1000.DC",
    members: symbols.map(symbol => ({ symbol, name: null })) });
  const warning = await archiveRiskWarningObservations({ source: "tushare", market: "A", endpoint: "stock_st", tradeDate: activeDate,
    observedAt, coverage: "unknown", rows: [{ symbol: symbols[5]!, name: "ST Fixture", type: "ST", typeName: "风险警示板" }] });
  return { warning, manifest: { sessions: [previousDate, activeDate, missingDate],
    marketRevisions: marketRefs.map(ref => ref.revision), limitRevisions: limits.map(ref => ref.revision),
    sectorHistory: [{ tradeDate: activeDate, catalogRevision: catalog.revision, memberRevisions: [members.revision] }],
  } };
}

test("CLI replays the market mainline from immutable inputs and keeps dated missing evidence explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-mainline-cli-"));
  const previous = process.env.OHQUANT_DIR;
  const path = join(root, "mainline manifest.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const replay = (input: unknown, action = "replay-market-mainline") => {
    writeFileSync(path, JSON.stringify(input));
    return run("observation", action, "--manifest", path);
  };
  process.env.OHQUANT_DIR = root;
  try {
    const { manifest, warning } = await fixture();
    const help = (await run("--help")).output.data.commands;
    expect(help).toContainEqual({
      command: "whyj --json observation replay-market-mainline",
      description: "Replay industry or concept mainlines from dated archives",
    });
    expect(help.map((entry: { command: string }) => entry.command)).toContain("whyj --json observation replay-market-regime-summary");
    expect(help.map((entry: { command: string }) => entry.command)).toContain("whyj --json observation archive-market-regime-manifest");
    const plain = await replay(manifest);
    expect(plain).toMatchObject({ code: 0, output: { ok: true, data: { scope: { kind: "concept", taxonomy: "eastmoney" },
      rows: [
        { tradingDate: previousDate, status: "missing-membership", mainline: null },
        { tradingDate: activeDate, status: "computed",
          input: { sector: { coverage: { archivedGroups: 1, uncollectedGroupIds: ["BK2000.DC"] } } },
          mainline: { formula: { id: "tsp_market_mainline" }, rows: [{ name: "Fixture", rank: 1, score: 0, limitUpCount: 6,
            leaderSymbol: symbols[5], leaderAmountCny: 6_000 }] } },
        { tradingDate: missingDate, status: "missing-market", mainline: null },
      ],
    } } });
    expect(await replay(manifest)).toEqual(plain);
    const filtered = await replay({ ...manifest, riskWarningRevisions: [warning.revision], filter: { maxMembers: 6 } });
    expect(filtered).toMatchObject({ code: 0, output: { data: { rows: [
      { status: "missing-risk-warnings" },
      { status: "computed", input: { riskWarnings: { ref: warning, excludedSymbols: [symbols[5]] } },
        mainline: { rows: [{ limitUpCount: 5, leaderSymbol: symbols[4], leaderAmountCny: 5_000 }] } },
      { status: "missing-market" },
    ] } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const input of [
      { ...manifest, extra: true }, { ...manifest, filter: { minMembers: 8, maxMembers: 6 } },
      { ...manifest, sectorHistory: [manifest.sectorHistory[0], manifest.sectorHistory[0]] },
      { ...manifest, riskWarningRevisions: ["bad revision"] },
    ]) expect(await replay(input)).toMatchObject(invalid);
    expect(await replay({ ...manifest, marketRevisions: ["e".repeat(64)] })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });

    const { sectorHistory, ...marketScope } = manifest;
    const summaryManifest = { ...marketScope, priceHistory: [], benchmark: { symbol: "000001.SH", revisions: [] },
      phaseMode: "retrospective-tsp", window: { start: activeDate, end: activeDate }, concepts: { sectorHistory } };
    const summaryAction = "replay-market-regime-summary";
    const summaryResult = await replay(summaryManifest, summaryAction);
    expect(summaryResult).toMatchObject({ code: 0, output: { ok: true, data: {
      summary: {
        window: { start: activeDate, end: activeDate, sessions: 1 }, segments: [
          { days: 1, conceptDays: 1, topConcepts: [{ name: "Fixture", topFiveDays: 1, maxBoards: 1 }] },
        ],
      },
      history: {
        calendar: { sessions: [previousDate, activeDate, missingDate] }, phase: { mode: "retrospective-tsp" },
        rows: [{ tradingDate: previousDate }, { tradingDate: activeDate,
          daily: { activity: { totalAmountCny: 21_000, meanAmountCny: 3_500 }, exchange: { limitUp: { count: 6 } } } },
        { tradingDate: missingDate, daily: null }],
      },
      mainline: { scope: { kind: "concept" } },
    } } });
    expect(await replay({ ...summaryManifest, version: 1 }, summaryAction)).toEqual(summaryResult);
    const archiveAction = "archive-market-regime-manifest";
    const archived = await replay({ ...summaryManifest, version: 1 }, archiveAction);
    expect(archived).toMatchObject({ code: 0, output: { ok: true, data: {
      ref: { version: 1, kind: "market-regime-manifest" }, sessionCount: 3,
    } } });
    const revision = archived.output.data.ref.revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await run("observation", summaryAction, "--revision", revision)).toEqual(summaryResult);
    expect(await replay({ ...summaryManifest, version: 2 }, archiveAction)).toMatchObject(invalid);
    expect(await run("observation", summaryAction, "--revision", revision, "--manifest", path)).toMatchObject(invalid);
    expect(await run("observation", summaryAction, "--revision", "../invalid")).toMatchObject(invalid);
    expect(await run("observation", summaryAction, "--revision", "0".repeat(64))).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    for (const input of [
      { ...summaryManifest, window: { start: missingDate, end: previousDate } },
      { ...summaryManifest, version: 2 },
      { ...summaryManifest, window: { start: previousDate, end: "2024-01-01" } },
      { ...summaryManifest, concepts: { sectorHistory: [{ ...sectorHistory[0], catalogRevision: "bad" }] } },
    ]) expect(await replay(input, summaryAction)).toMatchObject(invalid);
    expect(await replay({ ...summaryManifest, marketRevisions: ["e".repeat(64)] }, summaryAction)).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
  } finally {
    if (previous === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

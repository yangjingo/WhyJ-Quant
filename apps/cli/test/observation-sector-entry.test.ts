import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI collects dated sector observations and replays ranks and rotation offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-sector-"));
  const date = "2025-01-02", token = "fixture-sector-cli-credential", sector = "BK1000.DC", symbol = "600000.SH";
  const nextDate = "2025-01-03", otherSector = "BK2000.DC", otherSymbol = "000001.SZ";
  let stopped = false, denyNext = false;
  const calls: unknown[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const query = await req.json() as { api_name: string; params: { trade_date: string; idx_type?: string; ts_code?: string } };
    const { trade_date: day, idx_type: kind, ts_code: group } = query.params;
    calls.push(query);
    if (denyNext) { denyNext = false; return new Response(token, { status: 403 }); }
    if (query.api_name === "dc_index") return Response.json({ code: 0, data: {
      fields: ["ts_code", "trade_date", "name", "idx_type", "level"], items: [
        [sector, day, "Robotics", kind, null], [otherSector, day, "Utilities", kind, null],
      ],
    } });
    if (query.api_name === "dc_member") return Response.json({ code: 0, data: {
      fields: ["trade_date", "ts_code", "con_code", "name"], items: [[day, group, group === sector ? symbol : otherSymbol, null]],
    } });
    if (query.api_name === "bak_basic") return Response.json({ code: 0, data: {
      fields: ["trade_date", "ts_code", "name", "industry", "list_date"], items: [[day, symbol, "Fixture", null, null], [day, otherSymbol, "Other", null, null]],
    } });
    if (query.api_name === "daily") return Response.json({ code: 0, data: {
      fields: "ts_code,trade_date,open,high,low,close,vol,amount,pre_close,change,pct_chg".split(","),
      items: day === "20250102" ? [
        [symbol, day, 10, 10.5, 10, 10.5, 2, 2.5, 10, 0.5, 5], [otherSymbol, day, 10, 10, 9.8, 9.8, 2, 2.5, 10, -0.2, -2],
      ] : [
        [symbol, day, 10, 10, 9.9, 9.9, 2, 2.5, 10, -0.1, -1], [otherSymbol, day, 10, 10.7, 10, 10.7, 2, 2.5, 10, 0.7, 7],
      ],
    } });
    if (query.api_name === "daily_basic") return Response.json({ code: 0, data: {
      fields: "ts_code,trade_date,close,pe,pe_ttm,pb,total_mv,circ_mv,turnover_rate,turnover_rate_f,volume_ratio,total_share,float_share,free_share".split(","),
      items: [],
    } });
    return new Response("unexpected query", { status: 400 });
  } });
  const settings = { ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: token, TUSHARE_BASE_URL: provider.url.origin } };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({
      command: "whyj --json observation collect-sector-catalog|collect-sector-members|replay-sector-rank",
      description: "Collect dated sector evidence or replay the WhyJ sector ranks",
    });
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation replay-sector-rotation",
      description: "Replay WhyJ sector RPS rotation from a dated archive manifest" });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await run("observation", "collect-sector-catalog", "--date", "2025-02-30", "--kind", "concept")).toMatchObject(invalid);
    expect(await run("observation", "collect-sector-members", "--date", date, "--sector-code", "wrong")).toMatchObject(invalid);
    expect(calls).toHaveLength(0);
    const collectCatalog = ["observation", "collect-sector-catalog", "--date", date, "--kind", "concept"];
    denyNext = true;
    expect(await run(...collectCatalog)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    const result = await run(...collectCatalog);
    const members = await run("observation", "collect-sector-members", "--date", date, "--sector-code", sector);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: { status: "archived", tradeDate: date, endpoint: "dc_index",
      ref: { version: 1, kind: "dated-sector-catalog" } } } });
    expect(members).toMatchObject({ code: 0, output: { ok: true, data: { status: "archived", tradeDate: date, endpoint: "dc_member",
      ref: { version: 1, kind: "dated-sector-members" } } } });
    expect(calls).toHaveLength(3);
    expect(calls.slice(1)).toMatchObject([
      { api_name: "dc_index", token, params: { trade_date: "20250102", idx_type: "概念板块" } },
      { api_name: "dc_member", token, params: { trade_date: "20250102", ts_code: sector } },
    ]);

    const market = await run("observation", "collect-market", "--date", date);
    expect(market).toMatchObject({ code: 0, output: { ok: true, data: { status: "archived", tradeDate: date,
      ref: { version: 1, kind: "market-cross-section" } } } });
    expect(calls.slice(3)).toMatchObject(["bak_basic", "daily", "daily_basic"].map(api_name => ({
      api_name, token, params: { trade_date: "20250102" },
    })));
    const marketRef = market.output.data.ref;
    const captureMember = (date: string, code: string) => run("observation", "collect-sector-members", "--date", date, "--sector-code", code);
    const memberB = await captureMember(date, otherSector);
    const nextCatalog = await run("observation", "collect-sector-catalog", "--date", nextDate, "--kind", "concept");
    const nextMembers = [await captureMember(nextDate, sector), await captureMember(nextDate, otherSector)];
    const nextMarket = await run("observation", "collect-market", "--date", nextDate);
    const industryCatalog = await run("observation", "collect-sector-catalog", "--date", nextDate, "--kind", "industry");
    expect([memberB, nextCatalog, ...nextMembers, nextMarket, industryCatalog].map(result => result.code)).toEqual([0, 0, 0, 0, 0, 0]);
    await provider.stop(true);
    stopped = true;

    const catalogRef = result.output.data.ref, memberRef = members.output.data.ref;
    const path = join(root, "members list.json");
    const replay = ["observation", "replay-sector-rank", "--market-revision", marketRef.revision, "--catalog-revision", catalogRef.revision, "--members-file", path];
    writeFileSync(path, JSON.stringify([memberRef.revision]));
    const first = await run(...replay);
    expect(await run(...replay)).toEqual(first);
    expect(first).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", tradingDate: date,
      formula: { id: "tsp_sector_ranking", version: 1 }, membership: { basis: "provider-dated-snapshot", groups: [
        { id: sector, observedAt: members.output.data.observedAt, revision: memberRef.revision },
      ] }, leading: [{ id: sector, averageFraction: 0.05, amountCny: 2_500 }],
      input: { marketRef, catalogRef, coverage: { archivedGroups: 1, uncollectedGroupIds: [otherSector] } },
    } } });
    writeFileSync(path, "[]");
    expect(await run(...replay)).toMatchObject({ code: 0, output: { data: { groups: [], input: { coverage: { archivedGroups: 0, uncollectedGroupIds: [sector, otherSector] } } } } });
    for (const contents of ["{", JSON.stringify([memberRef.revision, memberRef.revision]), " ".repeat(512_001)]) {
      writeFileSync(path, contents);
      expect(await run(...replay)).toMatchObject(invalid);
    }
    writeFileSync(path, JSON.stringify([catalogRef.revision]));
    expect(await run(...replay)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    const sessions = [
      { marketRevision: marketRef.revision, catalogRevision: catalogRef.revision, memberRevisions: [memberRef.revision, memberB.output.data.ref.revision] },
      { marketRevision: nextMarket.output.data.ref.revision, catalogRevision: nextCatalog.output.data.ref.revision,
        memberRevisions: nextMembers.map(result => result.output.data.ref.revision) },
    ];
    const rotation = ["observation", "replay-sector-rotation", "--manifest", path];
    writeFileSync(path, JSON.stringify(sessions));
    const movement = await run(...rotation);
    expect(movement).toMatchObject({ code: 0, output: { ok: true, data: { producer: "whyj", formula: { id: "tsp_sector_rotation", version: 1 },
      columns: [{ tradingDate: nextDate, rows: [
        { id: otherSector, rank: 1, rankMovement: 1, averageFraction: 0.07 }, { id: sector, rank: 2, rankMovement: -1 },
      ] }, { tradingDate: date, rows: [{ id: sector, rank: 1, rankMovement: null }, { id: otherSector, rank: 2, rankMovement: null }] }],
      input: { sessions: [{ tradingDate: date, archives: { marketRef, catalogRef } }, { tradingDate: nextDate, archives: { marketRef: nextMarket.output.data.ref } }] },
    } } });
    writeFileSync(path, JSON.stringify(sessions.toReversed()));
    expect(await run(...rotation)).toEqual(movement);
    expect(await run(...rotation, "--days", "7.5")).toMatchObject(invalid);
    for (const manifest of [{ sessions }, [{ ...sessions[0], memberRevisions: [memberRef.revision, memberRef.revision] }]]) {
      writeFileSync(path, JSON.stringify(manifest));
      expect(await run(...rotation)).toMatchObject(invalid);
    }
    for (const manifest of [[sessions[0], sessions[0]], [sessions[0], { ...sessions[1], catalogRevision: industryCatalog.output.data.ref.revision }],
      [sessions[0], { ...sessions[1], marketRevision: "f".repeat(64) }]]) {
      writeFileSync(path, JSON.stringify(manifest));
      expect(await run(...rotation)).toMatchObject({ code: 1, output: { error: { code: "observation_archive_unavailable" } } });
    }
    expect(calls).toHaveLength(14);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

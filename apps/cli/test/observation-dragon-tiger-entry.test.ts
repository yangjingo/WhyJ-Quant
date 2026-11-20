import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI captures all three Fuyao boards and replays WhyJ rankings offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-dragon-tiger-"));
  const tradeDate = "2026-07-01", token = "fixture-dragon-tiger";
  const stock = { thscode: "002407.SZ", ticker: "002407", name: "Fixture", range_days: 1 };
  const calls: (string | null)[][] = [];
  let deny = true, stopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/api/a-share/special-data/dragon-tiger-list") return new Response(null, { status: 404 });
    const board = url.searchParams.get("board_type"), date = url.searchParams.get("date");
    calls.push([date, board]);
    if (deny || req.headers.get("X-api-key") !== token) return new Response(token, { status: 403 });
    const stocks = board === "all" ? [{ ...stock, net_value: 20 }, { ...stock, range_days: 3, net_value: 80 }] : [];
    const seats = board === "hot_money" ? [{ name: "Seat", buying: 35, rows: [{ ...stock, hot_money_item_net_value: 35 }] }] : [];
    return Response.json({ code: 0, data: { board_type: board, trade_date: date, timestamp: 1_782_921_600_000,
      count: stocks.length + seats.length, stock_count: stocks.length ? 1 : 0, stock_items: stocks, hot_money_items: seats } });
  } });
  const origin = provider.url.origin;
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost", WHYJ_QUANT_FUYAO_API_KEY: stopped ? "" : token,
        FUYAO_BASE_URL: origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  try {
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation collect-dragon-tiger|replay-dragon-tiger",
      description: "Capture dated Fuyao boards or replay WhyJ dragon-tiger rankings",
    });
    const collect = (board: string) => run("observation", "collect-dragon-tiger", "--date", tradeDate, "--board", board);
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await collect("latest")).toMatchObject(invalid);
    expect(await collect("all")).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    deny = false;
    const revisions: string[] = [];
    for (const board of ["all", "org", "hot_money"]) {
      const result = await collect(board);
      expect(result).toMatchObject({ code: 0, output: { ok: true, data: { tradeDate, boardKind: board, source: "fuyao",
        status: board === "org" ? "empty" : "archived", ref: { kind: "dragon-tiger-board" } } } });
      revisions.push(result.output.data.ref.revision);
    }
    expect(calls).toEqual([[tradeDate, "all"], [tradeDate, "all"], [tradeDate, "org"], [tradeDate, "hot_money"]]);
    await provider.stop(true);
    stopped = true;
    const replay = (date: string, refs: string[]) => run("observation", "replay-dragon-tiger", "--date", date, "--revisions", refs.join(","));
    expect(await replay(tradeDate, revisions)).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { all: { stocks: [{ rangeDays: 1 }, { rangeDays: 3 }] }, org: { stocks: [] },
        hot_money: { seats: [{ name: "Seat", stocks: [{ seatNetValueCny: 35 }] }] } },
      metrics: { producer: "whyj", all: { leadingNetBuys: [{ netValueCny: 80 }, { netValueCny: 20 }] },
        institutions: { leaders: [] }, hotMoney: { leaders: [{ name: "Seat", netValueCny: 35 }] } },
    } } });
    expect(await replay(tradeDate, [revisions[0]!, revisions[0]!])).toMatchObject(invalid);
    expect(await replay("2026-06-30", revisions)).toMatchObject(unavailable);
    expect(await replay(tradeDate, ["f".repeat(64)])).toMatchObject(unavailable);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

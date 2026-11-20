import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

test("CLI captures dated provider money flows and replays exact populated and empty archives offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-money-flow-"));
  const date = "2024-09-03";
  const token = "fixture-money-flow-cli";
  const fields = [
    "ts_code", "trade_date",
    "buy_sm_vol", "buy_sm_amount", "sell_sm_vol", "sell_sm_amount",
    "buy_md_vol", "buy_md_amount", "sell_md_vol", "sell_md_amount",
    "buy_lg_vol", "buy_lg_amount", "sell_lg_vol", "sell_lg_amount",
    "buy_elg_vol", "buy_elg_amount", "sell_elg_vol", "sell_elg_amount",
    "net_mf_vol", "net_mf_amount",
  ];
  const requests: unknown[] = [];
  let mode: "denied" | "empty" | "available" = "denied";
  let stopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/") return new Response(null, { status: 404 });
    requests.push(await request.json());
    if (mode === "denied") return new Response(token, { status: 403 });
    const row = ["600001.SH", "20240903", 0, 0, 20, 2.25, 31, 3.15, 38, 3.88, 41, 4.18, 46, 4.68, null, null, 58, 5.78, -12, -0.21];
    return Response.json({ code: 0, data: { fields, items: mode === "empty" ? [] : [row] } });
  } });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const collect = (day: string) => run("observation", "collect-money-flow", "--date", day);
  const replay = (revision: string) => run("observation", "replay-money-flow", "--revision", revision);
  try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.preferences.source = "tushare";
    settings.env = { WHYJ_QUANT_TUSHARE_TOKEN: token, TUSHARE_BASE_URL: provider.url.origin };
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(settings));
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation collect-money-flow|replay-money-flow",
      description: "Capture and replay exact dated Tushare money flows",
    });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await collect("2024-02-30")).toMatchObject(invalid);
    expect(await collect("2009-12-31")).toMatchObject(invalid);
    expect(await replay("../outside")).toMatchObject(invalid);
    expect(requests).toHaveLength(0);
    expect(await collect(date)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });

    mode = "empty";
    const empty = await collect(date);
    expect(empty).toMatchObject({ code: 0, output: { ok: true, data: { tradeDate: date, status: "empty", rowCount: 0 } } });
    mode = "available";
    const captured = await collect(date);
    expect(captured).toMatchObject({ code: 0, output: { ok: true, data: { tradeDate: date, status: "archived", rowCount: 1,
      source: "tushare", endpoint: "moneyflow", volumeUnit: "hand", amountUnit: "CNY-ten-thousand" } } });
    expect(requests).toEqual(Array(3).fill({ api_name: "moneyflow", token, params: { trade_date: "20240903" }, fields: fields.join(",") }));
    await provider.stop(true);
    stopped = true;
    writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS));

    const receipt = captured.output.data;
    const revision = receipt.ref.revision;
    expect(await replay(revision)).toMatchObject({ code: 0, output: { ok: true, data: {
      ref: receipt.ref,
      observation: { tradeDate: date, observedAt: receipt.observedAt, amountUnit: "CNY-ten-thousand", volumeUnit: "hand", rows: [{
        symbol: "600001.SH",
        small: { buyVolumeHand: 0, buyAmount: 0, sellVolumeHand: 20, sellAmount: 2.25 },
        medium: { buyVolumeHand: 31, buyAmount: 3.15, sellVolumeHand: 38, sellAmount: 3.88 },
        large: { buyVolumeHand: 41, buyAmount: 4.18, sellVolumeHand: 46, sellAmount: 4.68 },
        extraLarge: { buyVolumeHand: null, buyAmount: null, sellVolumeHand: 58, sellAmount: 5.78 },
        netVolumeHand: -12, netAmount: -0.21,
      }] },
    } } });
    expect(await replay(empty.output.data.ref.revision)).toMatchObject({ code: 0, output: { ok: true, data: { observation: { rows: [] } } } });
    expect(await replay("0".repeat(64))).toMatchObject(unavailable);
    writeFileSync(join(root, "data", "money-flow-archives-v1", revision + ".json"), "{}");
    expect(await replay(revision)).toMatchObject(unavailable);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

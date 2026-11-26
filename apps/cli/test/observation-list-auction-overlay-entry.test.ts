import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI reads a dated TSP auction overlay and retains native source evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-list-auction-cli-"));
  const path = join(root, "auction overlay.json");
  const token = "tsp_auction_cli_fixture", date = "2025-06-18", symbol = "600000.SH", missing = "000001.SZ";
  const input = { version: 1, datasetId: "auction_demo", date, symbols: [symbol, missing],
    fields: { price: "price", matchedQuantity: "matched", unmatchedQuantity: "unmatched" },
    timeBasis: "caller-confirmed-shanghai-wall-clock" };
  const requests: URL[] = [];
  let online = true;
  const wideSeries = Array.from({ length: 4096 }, (_, value) => ["09:14:59", value]);
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    requests.push(url);
    if (!online || req.headers.get("authorization") !== "Bearer " + token) return new Response(token, { status: 403 });
    const field = url.searchParams.get("field");
    const points = field === "widePrice" ? wideSeries : field === "price" ? [["9:15", 10], ["09:16:00", 11]]
      : field === "matched" ? [["09:15:00", 0]] : [["09:15", -3], ["09:16", 0]];
    return Response.json({ config_id: input.datasetId, field, date, granularity: "intraday", items: { [symbol]: points } });
  } });
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  const run = async (...args: string[]) => {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TSP_READ_EXT_TOKEN: token, WHYJ_QUANT_TSP_BASE_URL: provider.url.origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(token);
    return { code, output: JSON.parse(stdout) };
  };
  const query = (manifest: unknown) => {
    writeFileSync(path, JSON.stringify(manifest));
    return run("observation", "read-list-auction-overlay", "--manifest", path);
  };
  try {
    const help = await run("--help");
    expect(help.output.data.commands).toContainEqual({ command: "whyj --json observation read-list-auction-overlay",
      description: "Read a dated TSP auction overlay with native extension observations" });
    for (const invalid of [{ ...input, date: "2025-02-30" }, { ...input, date: "0000-01-01" }, { ...input, timeBasis: undefined }, { ...input, symbols: [symbol, symbol] },
      { ...input, fields: { ...input.fields, unmatchedQuantity: "matched" } }, { ...input, fields: { price: "bad,field" } }]) {
      expect(await query(invalid)).toMatchObject({ code: 1, output: { ok: false, error: { code: "invalid_arguments" } } });
    }
    expect(requests).toHaveLength(0);
    const result = await query(input);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      input: { price: { source: "tsp", originalPublisher: "unknown", valueUnit: "unknown",
        series: [{ symbol, points: [{ time: "9:15", value: 10 }, { time: "09:16:00", value: 11 }] }, { symbol: missing, points: null }] } },
      overlay: { producer: "whyj", version: 1, tradeDate: date, rows: [
        { symbol, status: "observed", points: [
          { time: "09:15:00", price: 10, matchedQuantity: 0, unmatchedQuantity: -3, unmatchedSide: "sell" },
          { time: "09:16:00", price: 11, matchedQuantity: null, unmatchedQuantity: 0, unmatchedSide: "balanced" },
        ] }, { symbol: missing, status: "unavailable-price", points: [] },
      ] },
    } } });
    expect(requests.map(url => url.searchParams.get("field")).sort()).toEqual(["matched", "price", "unmatched"]);
    for (const url of requests) {
      expect(url.pathname).toBe("/api/ext-data/auction_demo/series");
      expect(url.searchParams.get("date")).toBe(date);
      expect(url.searchParams.get("symbols")).toBe([symbol, missing].join(","));
    }
    const wide = await query({ ...input, fields: { price: "widePrice" } });
    expect(wide.code).toBe(0);
    expect(wide.output.data.input.price.series[0].points).toHaveLength(wideSeries.length);
    expect(wide.output.data.input.price.series[0].points.at(-1)).toEqual({ time: "09:14:59", value: 4095 });

    online = false;
    expect(await query({ ...input, fields: { price: "price" } })).toMatchObject({ code: 1, output: { ok: false,
      error: { code: "observation_collection_failed" } } });
    expect(requests).toHaveLength(5);
  } finally {
    await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

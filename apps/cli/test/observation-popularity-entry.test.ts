import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI captures a Sunday popularity list and replays immutable ranks after Fuyao stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-cli-popularity-"));
  const date = "2026-06-21", token = "popularity-cli-fixture", dateMs = 1_781_971_200_000;
  const path = "/api/a-share/special-data/hot-stock-list-history";
  const requests: (string | null)[] = [];
  let mode: "denied" | "empty" | "available" = "denied";
  let stopped = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== path) return new Response(null, { status: 404 });
    requests.push(url.searchParams.get("date"));
    if (mode === "denied" || request.headers.get("X-api-key") !== token) {
      return Response.json({ code: 2001, message: token });
    }
    const entries = [
      { thscode: "600519.SH", ticker: "600519", name: "Sample A", rank: 11 },
      { thscode: "000725.SZ", ticker: "000725", name: "Sample B", rank: 3 },
    ];
    return Response.json({ code: 0, data: { date, date_ms: dateMs, item: mode === "empty" ? [] : entries } });
  } });
  const origin = provider.url.origin;
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost", FUYAO_BASE_URL: origin,
        WHYJ_QUANT_FUYAO_API_KEY: stopped ? "" : token },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout).not.toContain(token);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  };
  const collect = (calendarDate: string) => run("observation", "collect-popularity", "--date", calendarDate);
  const replay = (revision: string) => run("observation", "replay-popularity", "--revision", revision);

  try {
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation collect-popularity|replay-popularity",
      description: "Capture and replay exact dated Fuyao popularity ranks",
    });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await collect("2026-02-30")).toMatchObject(invalid);
    expect(await collect("9999-01-01")).toMatchObject(invalid);
    expect(await replay("../outside")).toMatchObject(invalid);
    expect(requests).toEqual([]);

    expect(await collect(date)).toMatchObject({ code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } });
    mode = "empty";
    const empty = await collect(date);
    expect(empty).toMatchObject({ code: 0, output: { ok: true, data: { calendarDate: date, status: "empty", rowCount: 0 } } });
    mode = "available";
    const captured = await collect(date);
    expect(captured).toMatchObject({ code: 0, output: { ok: true, data: { calendarDate: date, status: "archived", rowCount: 2,
      source: "fuyao", endpoint: path, calendarTimeZone: "Asia/Shanghai", calendarDateTimestamp: dateMs, coverage: "unknown" } } });
    expect(requests).toEqual([date, date, date]);
    await provider.stop(true);
    stopped = true;

    const receipt = captured.output.data;
    const revision = receipt.ref.revision;
    expect(await replay(revision)).toMatchObject({ code: 0, output: { ok: true, data: {
      ref: receipt.ref,
      observation: { calendarDate: date, calendarDateTimestamp: dateMs, observedAt: receipt.observedAt, rows: [
        { symbol: "600519.SH", ticker: "600519", name: "Sample A", rank: 11 },
        { symbol: "000725.SZ", ticker: "000725", name: "Sample B", rank: 3 },
      ] },
    } } });
    expect(await replay(empty.output.data.ref.revision)).toMatchObject({ code: 0, output: { ok: true, data: { observation: { rows: [] } } } });
    expect(await replay("0".repeat(64))).toMatchObject(unavailable);
    writeFileSync(join(root, "data", "popularity-archives-v1", revision + ".json"), "{}");
    expect(await replay(revision)).toMatchObject(unavailable);
  } finally {
    if (!stopped) await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

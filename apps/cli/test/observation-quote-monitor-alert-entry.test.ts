import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveQuotePollCapture, loadQuotePollArchive, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const a = "600001.SH", b = "600002.SH", missing = "600003.SH";
const roster = [a, b, missing];

test("CLI captures one selected-source monitor poll and exactly replays its current decision offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-quote-monitor-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const manifest = join(root, "quote monitor.json");
  const requests: URL[] = [];
  let available = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url));
    if (!available || request.headers.get("x-api-key") !== "quote-monitor-fixture") return new Response("", { status: 403 });
    const now = Date.now(), dayStart = Date.parse(`${shanghai.format(now)}T00:00:00+08:00`);
    const timestamp = Math.max(dayStart, now - 1000);
    return Response.json({ data: [a, b].map(symbol => ({ symbol, region: "CN", timestamp, last_price: 11, prev_close: 10,
      open: 10, high: 11, low: 10, volume: 300, amount: 2 })) });
  } });
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  const run = async (...args: string[]) => {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 25_000,
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TICKFLOW_API_KEY: "quote-monitor-fixture", TICKFLOW_BASE_URL: server.url.origin },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("quote-monitor-fixture");
    return { code, output: JSON.parse(stdout) };
  };
  const invoke = (mode: "collect" | "replay", input: unknown) => {
    writeFileSync(manifest, JSON.stringify(input));
    return run("observation", `${mode}-quote-monitor-alerts`, "--manifest", manifest);
  };

  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "quote-monitor-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = (await run("--help")).output.data.commands;
    expect(help).toContainEqual({ command: "whyj --json observation collect-quote-monitor-alerts",
      description: "Capture and evaluate one current stock quote monitor poll" });
    expect(help).toContainEqual({ command: "whyj --json observation replay-quote-monitor-alerts",
      description: "Replay monitor alert decisions from exact stock quote polls" });

    const now = Date.now(), tradeDate = shanghai.format(now);
    const timestamp = Math.max(Date.parse(`${tradeDate}T00:00:00+08:00`), now - 10_000);
    const observedAt = new Date(timestamp).toISOString();
    const prior = await archiveQuotePollCapture({ source: "tickflow", endpoint: "/v1/quotes", market: "A", tradeDate,
      startedAt: observedAt, observedAt, coverage: "unknown", units: "unknown", requestedSymbols: roster,
      rows: [{ symbol: a, timestamp, receivedAt: observedAt, lastPrice: 11, previousClose: 10, volume: 300, amount: 2 }] });
    const base = { version: 1, roster, maxAgeMs: 30_000, priceBasis: "caller-confirmed-unadjusted-CNY", volumeUnit: "share", amountUnit: "CNY-thousand",
      rule: { id: "current_quote", revision: "rule-v1", type: "price", assetType: "stock", scope: { kind: "all" },
        logic: "and", severity: "warn", cooldownMs: 120_000, conditions: [
          { field: "change_pct", op: ">", value: 0.08, unit: "fraction" },
          { field: "volume", op: ">=", value: 3, unit: "hand" },
          { field: "amount", op: ">=", value: 2000, unit: "CNY" },
        ] } };
    const collect = { ...base, tradeDate, priorCaptureRevisions: [prior.revision] };
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await invoke("collect", { ...collect, tradeDate: "2025-01-01" })).toMatchObject(invalid);
    expect(await invoke("collect", { ...collect, priorCaptureRevisions: [prior.revision, prior.revision] })).toMatchObject(invalid);
    expect(await invoke("collect", { ...collect, rule: { ...base.rule,
      conditions: [{ field: "volume", op: ">", value: 4, unit: "share" }] } })).toMatchObject(invalid);
    const failed = { code: 1, output: { ok: false, error: { code: "observation_collection_failed" } } };
    expect(await invoke("collect", { ...collect, priorCaptureRevisions: ["0".repeat(64)] })).toMatchObject(failed);
    expect(requests).toHaveLength(0);

    const current = await invoke("collect", collect);
    expect(current).toMatchObject({ code: 0, output: { ok: true, data: {
      capture: { tradeDate, source: "tickflow", requestedSymbols: roster, missingSymbols: [missing] }, priorCaptureRefs: [prior],
      evaluation: { missingSymbols: [missing], suppressedCount: 1, events: [{ symbol: b, priceCny: 11,
        eventId: expect.stringMatching(/^[a-f0-9]{64}$/), operands: { change_pct: 0.1, volume: 3, amount: 2000 } }] },
    } } });
    expect(current.output.data).not.toHaveProperty("evaluations");
    expect(requests.map(url => [url.pathname, url.searchParams.get("symbols")])).toEqual([["/v1/quotes", roster.join(",")]]);
    const capturedRef = current.output.data.capture.ref;
    expect(await loadQuotePollArchive(capturedRef)).toMatchObject({ units: "unknown", rows: [{ volume: 300, amount: 2 }, { volume: 300, amount: 2 }] });

    available = false;
    const replay = { ...base, captureRevisions: [prior.revision, capturedRef.revision] };
    const offline = await invoke("replay", replay);
    expect(offline.output.data.evaluations.at(-1)).toEqual(current.output.data.evaluation);
    expect(await invoke("replay", replay)).toEqual(offline);
    expect(await invoke("replay", { ...replay, captureRevisions: [] })).toMatchObject(invalid);
    const unavailable = { code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } } };
    expect(await invoke("replay", { ...replay, roster: [a] })).toMatchObject(unavailable);
    expect(await invoke("replay", { ...replay, captureRevisions: ["f".repeat(64)] })).toMatchObject(unavailable);
    expect(requests).toHaveLength(1);
    expect(await invoke("collect", collect)).toMatchObject(failed);
    expect(requests).toHaveLength(2);
  } finally {
    await server.stop(true);
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

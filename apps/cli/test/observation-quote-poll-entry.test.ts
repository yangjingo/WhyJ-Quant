import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveQuotePollCapture, loadQuotePollArchive, saveSettings } from "../../../src/storage/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/types/config.ts";

const shanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const symbol = "600001.SH", missing = "600002.SH";

async function archiveFixture(time: string, volume: number, amount: number) {
  const tradeDate = "2025-01-03";
  const timestamp = Date.parse(tradeDate + "T" + time + "+08:00");
  const observedAt = new Date(timestamp + 1000).toISOString();
  return archiveQuotePollCapture({
    source: "tickflow", endpoint: "/v1/quotes", market: "A", tradeDate,
    startedAt: new Date(timestamp).toISOString(), observedAt, coverage: "unknown", units: "unknown",
    requestedSymbols: [symbol, missing],
    rows: [{ symbol, timestamp, receivedAt: observedAt, lastPrice: 11, previousClose: 10, volume, amount }],
  });
}

test("CLI captures an explicit TickFlow quote poll and replays fixed increments offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-quote-poll-cli-"));
  const previousRoot = process.env.OHQUANT_DIR;
  const symbolsFile = join(root, "poll symbols.json");
  const manifestFile = join(root, "delta manifest.json");
  const requests: URL[] = [];
  let available = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url));
    if (!available || request.headers.get("x-api-key") !== "poll-cli-fixture") return new Response("", { status: 403 });
    return Response.json({ data: [{ symbol, region: "CN", timestamp: Date.now(),
      last_price: 11, prev_close: 10, open: 10, high: 11, low: 10, volume: 100, amount: null }] });
  } });
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(input: unknown) {
    writeFileSync(manifestFile, JSON.stringify(input));
    return run("observation", "replay-quote-poll-delta", "--manifest", manifestFile);
  }
  process.env.OHQUANT_DIR = root;
  try {
    saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "poll-cli-fixture", TICKFLOW_BASE_URL: server.url.origin } });
    const help = (await run("--help")).output.data.commands;
    expect(help).toContainEqual({ command: "whyj --json observation collect-quote-poll",
      description: "Archive one current Shanghai quote poll for a specified stock list" });
    expect(help).toContainEqual({ command: "whyj --json observation replay-quote-poll-delta",
      description: "Replay volume and amount increments from fixed quote polls" });

    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    const collect = () => run("observation", "collect-quote-poll", "--date", shanghai.format(Date.now()), "--symbols-file", symbolsFile);
    writeFileSync(symbolsFile, JSON.stringify([symbol, symbol]));
    expect(await collect()).toMatchObject(invalid);
    expect(requests).toHaveLength(0);
    writeFileSync(symbolsFile, JSON.stringify([missing, symbol]));
    const collected = await collect();
    expect(collected).toMatchObject({ code: 0, output: { ok: true, data: { source: "tickflow", endpoint: "/v1/quotes",
      status: "archived", requestedSymbols: [symbol, missing], rowCount: 1, missingSymbols: [missing], units: "unknown" } } });
    expect(requests.map(url => [url.pathname, url.searchParams.get("symbols")])).toEqual([["/v1/quotes", symbol + "," + missing]]);
    const capturedRef = collected.output.data.ref;
    expect(await loadQuotePollArchive(capturedRef)).toMatchObject({
      observedAt: collected.output.data.observedAt, rows: [{ symbol, volume: 100, amount: null }],
    });
    available = false;
    expect(await replay({ version: 1, currentRevision: capturedRef.revision })).toMatchObject({ code: 0, output: { data: {
      input: { previous: null, current: { ref: capturedRef } }, rows: [{ symbol, current: { volume: 100, amount: null } }, { symbol: missing }],
    } } });

    const previous = await archiveFixture("09:30:10", 1000, 2000);
    const current = await archiveFixture("09:30:20", 1300, 5000);
    const base = { version: 1, previousRevision: previous.revision, currentRevision: current.revision, rule: { metric: "amount", threshold: 3000 } };
    expect(await replay(base)).toMatchObject({ code: 0, output: { data: {
      status: "comparable", pollSpanMs: 10_000, amountUnit: "unknown",
      input: { previous: { ref: previous }, current: { ref: current } },
      rows: [{ symbol, nativeVolumeDelta: 300, nativeAmountDelta: 3000, amountDeltaCny: null, triggered: null }, { symbol: missing }],
    } } });
    const manifest = { ...base, amountUnit: "CNY", volumeUnit: "share" };
    const qualified = await replay(manifest);
    expect(qualified).toMatchObject({ code: 0, output: { data: {
      input: { amountUnitBasis: "caller-declared", current: { units: "unknown" } },
      rows: [{ symbol, volumeDeltaHands: 3, amountDeltaCny: 3000, triggered: true }, { symbol: missing, availability: "missing-previous" }],
    } } });
    expect(await replay(manifest)).toEqual(qualified);
    expect(await replay({ version: 1, currentRevision: current.revision })).toMatchObject({ code: 0, output: { data: { status: "missing-previous" } } });
    expect(await replay({ ...base, version: 2 })).toMatchObject(invalid);
    expect(await replay({ ...base, amountUnit: "unknown" })).toMatchObject(invalid);
    expect(await replay({ ...base, rule: { metric: "volume", threshold: 0 } })).toMatchObject(invalid);
    expect(await replay({ ...base, previousRevision: current.revision })).toMatchObject(invalid);
    expect(await replay({ ...base, previousRevision: "f".repeat(64) })).toMatchObject({
      code: 1, output: { error: { code: "observation_archive_unavailable" } },
    });
    expect(requests).toHaveLength(1);
  } finally {
    await server.stop(true);
    if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
    else process.env.OHQUANT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI captures one TSP page and repeats the same calculation offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-extension-page-cli-"));
  const path = join(root, "page manifest.json");
  const date = "2025-06-18", token = "tsp_extension_cli_fixture";
  const requests: string[] = [];
  let stopped = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    if (request.method !== "GET" || url.pathname !== "/api/ext-data/flow_demo/rows" || url.searchParams.get("date") !== date ||
      url.searchParams.get("offset") !== "0" || url.searchParams.get("limit") !== "3" ||
      url.searchParams.get("columns") !== "category,amount" || request.headers.get("authorization") !== "Bearer " + token) {
      return new Response("", { status: 403 });
    }
    return Response.json({
      id: "flow_demo", label: "Flow", mode: "timeseries", date, total: 5, offset: 0, limit: 3,
      fields: [{ name: "category", dtype: "string", label: "Category" }, { name: "amount", dtype: "float", label: "Amount" }],
      rows: [{ category: "A/B", amount: 0 }, { category: "A", amount: 20 }, { category: "C", amount: null }],
    });
  } });
  const origin = server.url.origin;
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function run(...args: string[]) {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, OHQUANT_DIR: root, NO_PROXY: "127.0.0.1,localhost",
        WHYJ_QUANT_TSP_BASE_URL: origin, WHYJ_QUANT_TSP_READ_EXT_TOKEN: token },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(token);
    return { code, output: JSON.parse(stdout) };
  }
  function invoke(action: string, manifest: unknown) {
    writeFileSync(path, JSON.stringify(manifest));
    return run("observation", action, "--manifest", path);
  }
  try {
    const help = (await run("--help")).output.data.commands;
    for (const action of ["collect-extension-page", "replay-extension-page-groups"]) {
      expect(help.some((entry: { command: string }) => entry.command === "whyj --json observation " + action)).toBe(true);
    }
    const request = { schemaVersion: 1, datasetId: "flow_demo", selection: { mode: "timeseries", date },
      columns: ["category", "amount"], offset: 0, limit: 3 };
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await invoke("collect-extension-page", { ...request, columns: ["category", "category"] })).toMatchObject(invalid);
    expect(await invoke("collect-extension-page", { ...request, selection: { mode: "snapshot", date } })).toMatchObject(invalid);
    expect(await invoke("collect-extension-page", { ...request, selection: { mode: "timeseries", date: "0000-01-01" } })).toMatchObject(invalid);
    expect(requests).toHaveLength(0);
    const capture = await invoke("collect-extension-page", request);
    expect(capture).toMatchObject({ code: 0, output: { ok: true, data: {
      source: "tsp", partitionDate: date, status: "archived", rowCount: 3, totalRows: 5, coverage: "partial",
      ref: { version: 1, kind: "tsp-extension-page" },
    } } });
    const receipt = capture.output.data;
    expect(receipt.ref.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt).not.toHaveProperty("rows");
    await server.stop(true);
    stopped = true;

    const manifest = { schemaVersion: 1, revision: receipt.ref.revision, dimensionField: "category",
      metrics: [{ field: "amount", aggregate: "avg" }], units: { amount: "CNY" } };
    const replay = (value: unknown) => invoke("replay-extension-page-groups", value);
    const calculated = await replay(manifest);
    expect(calculated).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", dataset: { source: "tsp", coverage: "partial", observedAt: receipt.observedAt },
      groups: [{ key: "A", metrics: [{ value: 10, unit: "CNY", observedCount: 2 }] },
        { key: "B", metrics: [{ value: 0 }] }, { key: "C", metrics: [{ value: null, observedCount: 0 }] }],
      input: { ref: receipt.ref, revision: receipt.revision, originalPublisher: "unknown",
        unitEvidence: [{ field: "amount", unit: "CNY", basis: "caller-declared" }] },
    } } });
    expect(await replay(manifest)).toEqual(calculated);
    expect(await replay({ ...manifest, units: undefined })).toMatchObject({ code: 0, output: { data: {
      input: { unitEvidence: [{ field: "amount", unit: "unknown", basis: "unknown" }] },
    } } });
    expect(await replay({ ...manifest, revision: "../outside" })).toMatchObject(invalid);
    expect(await replay({ ...manifest, metrics: [{ field: "amount", aggregate: "median" }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, metrics: [...manifest.metrics, ...manifest.metrics] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, units: { amount: "Unknown" } })).toMatchObject(invalid);
    expect(await replay({ ...manifest, extra: true })).toMatchObject(invalid);
    expect(await replay({ ...manifest, revision: "0".repeat(64) })).toMatchObject({
      code: 1, output: { ok: false, error: { code: "observation_archive_unavailable" } },
    });
    expect(requests).toHaveLength(1);
  } finally {
    if (!stopped) await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

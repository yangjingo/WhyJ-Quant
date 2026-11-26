import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual CLI replays groups from declared fixed rows and preserves native units and missing evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-extension-groups-cli-"));
  const path = join(root, "extension manifest.json");
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function run(...args: string[]) {
    const child = Bun.spawn([...entry, "--json", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OHQUANT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, output: JSON.parse(stdout) };
  }
  function replay(value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    return run("observation", "replay-extension-groups", "--manifest", path);
  }
  try {
    const dataset = { id: "example", schemaRevision: "fields-v2", revision: "receipt-v1", source: "fixture-provider",
      frequency: "daily", effectiveDate: "2025-06-18", sourceAsOf: null, observedAt: "2025-06-18T08:00:00Z",
      coverage: "partial", totalRows: 7 };
    const manifest = { schemaVersion: 1, dataset, fields: [
      { name: "category", type: "text" }, { name: "amount", type: "number", unit: "CNY" },
    ], dimensionField: "category", metrics: [{ field: "amount", aggregate: "avg" }],
    rows: [{ category: "A/B", amount: 0 }, { category: "A", amount: 20 }, { category: "C", amount: null }] };
    expect((await run("--help")).output.data.commands).toContainEqual({
      command: "whyj --json observation replay-extension-groups", description: "Calculate fixed extension group metrics from typed rows",
    });
    const first = await replay(manifest);
    expect(first).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", dataset, rowCount: 3, memberships: 4,
      groups: [
        { key: "A", count: 2, metrics: [{ field: "amount", unit: "CNY", observedCount: 2, value: 10 }] },
        { key: "B", count: 1, metrics: [{ observedCount: 1, value: 0 }] },
        { key: "C", count: 1, metrics: [{ observedCount: 0, value: null }] },
      ],
    } } });
    expect(await replay(manifest)).toEqual(first);
    expect(await replay({ ...manifest, rows: [] })).toMatchObject({ code: 0, output: { data: { rowCount: 0, groups: [] } } });
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    expect(await replay({ ...manifest, schemaVersion: 2 })).toMatchObject(invalid);
    expect(await replay({ ...manifest, rows: [{ category: "B", amount: "1" }] })).toMatchObject(invalid);
    expect(await replay({ ...manifest, dataset: { ...dataset, unknown: true } })).toMatchObject(invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

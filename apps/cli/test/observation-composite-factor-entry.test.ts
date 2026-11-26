import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("production CLI replays a fixed composite factor without a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "whyj-tsp-composite-cli-"));
  const path = join(root, "composite.json");
  const tradeDate = "2026-05-27";
  const members = [{ factorId: "x", weight: 2 }, { factorId: "y", weight: -0.5 }];
  const rows = [
    { tradeDate, symbol: "A", values: { x: 0, y: 1 } },
    { tradeDate, symbol: "B", values: { x: 2, y: null } },
    { tradeDate, symbol: "C", values: { x: 2, y: 5 } },
    { tradeDate, symbol: "D", values: { x: 4, y: 9 } },
  ];
  const manifest = { schemaVersion: 1, members, rows: rows.toReversed() };
  const entry = process.env.WHYJ_TEST_BUNDLED_CLI === "1"
    ? ["node", fileURLToPath(new URL("../../../dist/index.js", import.meta.url))]
    : [process.execPath, "run", "src/index.ts"];
  async function cli(...args: string[]) {
    const child = Bun.spawn([...entry, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, OHQUANT_DIR: root, WHYJ_QUANT_TICKFLOW_API_KEY: "", WHYJ_QUANT_TUSHARE_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, stdout };
  }
  async function replay(value: unknown) {
    writeFileSync(path, JSON.stringify(value));
    const result = await cli("--json", "observation", "replay-composite-factor", "--manifest", path);
    return { code: result.code, output: JSON.parse(result.stdout) };
  }
  try {
    const help = await cli("--json", "--help");
    expect(JSON.parse(help.stdout).data.commands).toContainEqual({
      command: "whyj --json observation replay-composite-factor",
      description: "Replay a composite factor from fixed dated factor values",
    });
    expect((await cli("--help")).stdout).toContain("whyj --json observation replay-composite-factor --manifest PATH");
    const result = await replay(manifest);
    expect(result).toMatchObject({ code: 0, output: { ok: true, data: {
      producer: "whyj", formulaVersion: "tsp-composite-factor-v1", members,
    } } });
    const scored = result.output.data.rows;
    expect(scored.map(({ symbol }: { symbol: string }) => symbol)).toEqual(["A", "B", "C", "D"]);
    expect(scored[0].score).toBeCloseTo(-Math.sqrt(6) + 0.5, 14);
    expect(scored[1]).toEqual({ tradeDate, symbol: "B", score: null });
    expect(scored[2]).toEqual({ tradeDate, symbol: "C", score: 0 });
    expect(scored[3].score).toBeCloseTo(Math.sqrt(6) - 0.5, 14);
    expect(await replay(manifest)).toEqual(result);
    const one = rows[0]!;
    const invalid = { code: 1, output: { ok: false, error: { code: "invalid_arguments" } } };
    for (const changed of [
      { schemaVersion: 2 }, { source: "tickflow" }, { rows: [one, one] },
      { members: [members[0], { ...members[1], weight: 0 }] },
      { rows: [{ ...one, tradeDate: "2026-02-30" }] },
      { rows: [{ ...one, values: { x: 1 } }] },
      { rows: [{ ...one, values: { x: 1, y: 2, z: 3 } }] },
      { rows: [{ ...one, values: { x: "1", y: 2 } }] },
    ]) {
      expect(await replay({ ...manifest, ...changed })).toMatchObject(invalid);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

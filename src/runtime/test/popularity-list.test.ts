import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDatedPopularityList, replayDatedPopularityList } from "../data/popularity-list.ts";

const date = "2026-06-21";
const dateMs = 1_781_971_200_000;
const batch = { date, date_ms: dateMs, item: [{ thscode: "600519.SH", ticker: "600519", name: "Sample", rank: 1 }] };
const credential = "popularity-runtime-fixture";
const fixtureEnv = { WHYJ_QUANT_FUYAO_API_KEY: credential, FUYAO_BASE_URL: "https://popularity.test" };
let root: string;
let previous: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "whyj-popularity-runtime-"));
  const overrides = { ...fixtureEnv, OHQUANT_DIR: root };
  previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("collects configured provider ranks and opens populated and empty captures without a credential", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ code: 0, data: batch }))
    .mockResolvedValueOnce(Response.json({ code: 0, data: { ...batch, item: [] } }));
  try {
    const filled = await collectDatedPopularityList(date);
    expect(filled).toMatchObject({ calendarDate: date, calendarDateTimestamp: dateMs, source: "fuyao", rowCount: 1, status: "archived" });
    const empty = await collectDatedPopularityList(date);
    expect(empty).toMatchObject({ status: "empty", rowCount: 0 });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://popularity.test/api/a-share/special-data/hot-stock-list-history?date=" + date);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-api-key": credential });
    expect(JSON.stringify(filled)).not.toContain(credential);
    delete process.env.WHYJ_QUANT_FUYAO_API_KEY;
    expect((await replayDatedPopularityList(filled.ref)).observation).toMatchObject({
      observedAt: filled.observedAt, rows: [{ symbol: "600519.SH", ticker: "600519", name: "Sample", rank: 1 }],
    });
    expect((await replayDatedPopularityList(empty.ref)).observation.rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

test("denial, mismatched dates and aborts do not write a popularity capture", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(credential, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ code: 0, data: { ...batch, date: "2026-06-22" } }));
  try {
    await expect(collectDatedPopularityList(date)).rejects.toMatchObject({ code: "provider-failure", message: "Fuyao historical popularity request failed" });
    await expect(collectDatedPopularityList(date)).rejects.toMatchObject({ code: "provider-failure" });
    await expect(collectDatedPopularityList(date, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "data", "popularity-archives-v1"))).toBe(false);
  } finally { fetcher.mockRestore(); }
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSectorObservationArchive, readSettings, saveSettings } from "../../storage/index.ts";
import { DEFAULT_SETTINGS } from "../../types/config.ts";
import { collectSectorObservations } from "../data/sector-collection.ts";

const credential = "fixture-sector-token";
const tradeDate = "2025-01-02", compact = "20250102", sectorCode = "BK1184.DC";
const catalogRequest = { kind: "dated-sector-catalog", groupKind: "concept", tradeDate } as const;
const membersRequest = { kind: "dated-sector-members", sectorCode, tradeDate } as const;
const catalogFields = ["ts_code", "trade_date", "name", "idx_type", "level"];
const memberFields = ["trade_date", "ts_code", "con_code", "name"];
const catalogRow = [sectorCode, compact, "Robotics", "概念板块", null];
const memberRow = [compact, sectorCode, "600000.SH", null];
const table = (fields: string[], items: unknown[][]) => Response.json({ code: 0, data: { fields, items } });
const preconnect = fetch.preconnect;

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-sector-collection-"));
  process.env.OHQUANT_DIR = root;
  saveSettings({ ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
    env: { WHYJ_QUANT_TUSHARE_TOKEN: credential } });
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

test("configured sector collection binds separate exact requests to offline references", async () => {
  const http = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(table(catalogFields, [catalogRow]))
    .mockResolvedValueOnce(table(memberFields, [memberRow]));
  try {
    const catalog = await collectSectorObservations(catalogRequest);
    const members = await collectSectorObservations({ ...membersRequest, sectorCode: " bk1184.dc " });
    const evidence = { status: "archived", rowCount: 1, tradeDate, taxonomy: "eastmoney", coverage: "unknown", source: "tushare", market: "A" };
    expect(catalog).toMatchObject({ ...evidence, endpoint: "dc_index", scope: { groupKind: "concept" },
      ref: { version: 1, kind: "dated-sector-catalog" } });
    expect(members).toMatchObject({ ...evidence, endpoint: "dc_member", scope: { sectorCode },
      ref: { version: 1, kind: "dated-sector-members" } });
    expect(catalog.ref.revision).not.toBe(members.ref.revision);
    expect(JSON.stringify([catalog, members])).not.toContain(credential);
    expect(http.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toMatchObject([
      { api_name: "dc_index", token: credential, params: { trade_date: compact, idx_type: "概念板块" } },
      { api_name: "dc_member", token: credential, params: { trade_date: compact, ts_code: sectorCode } },
    ]);

    http.mockRejectedValue(new Error("Unexpected provider I/O while reopening"));
    expect(await loadSectorObservationArchive(catalog.ref)).toEqual({
      market: "A", source: "tushare", endpoint: "dc_index", tradeDate, taxonomy: "eastmoney", coverage: "unknown", observedAt: catalog.observedAt,
      kind: "concept", providerType: "概念板块", groups: [{ code: sectorCode, name: "Robotics", level: null }],
    });
    expect(await loadSectorObservationArchive(members.ref)).toEqual({
      market: "A", source: "tushare", endpoint: "dc_member", tradeDate, taxonomy: "eastmoney", coverage: "unknown", observedAt: members.observedAt,
      sectorCode, members: [{ symbol: "600000.SH", name: null }],
    });
    expect(http).toHaveBeenCalledTimes(2);
  } finally { http.mockRestore(); }
});

test("empty membership keeps the original scope and a readable empty archive", async () => {
  const request = { ...membersRequest, sectorCode: " bk1184.dc ", tradeDate: String(tradeDate) };
  const http = spyOn(globalThis, "fetch").mockImplementationOnce(Object.assign(async () => {
    request.sectorCode = "BK0493.DC";
    request.tradeDate = "2025-01-03";
    return table(memberFields, []);
  }, { preconnect }));
  try {
    const receipt = await collectSectorObservations(request);
    expect(receipt).toMatchObject({ status: "empty", rowCount: 0, tradeDate, scope: { sectorCode }, coverage: "unknown" });
    expect(await loadSectorObservationArchive(receipt.ref)).toMatchObject({ tradeDate, sectorCode, members: [], observedAt: receipt.observedAt });
    expect(http).toHaveBeenCalledTimes(1);
  } finally { http.mockRestore(); }
});

test("unsupported, denied, wrong-date and cancelled collection create no archive", async () => {
  const http = spyOn(globalThis, "fetch");
  try {
    saveSettings({ ...DEFAULT_SETTINGS, revision: readSettings().revision, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tickflow" },
      env: { WHYJ_QUANT_TICKFLOW_API_KEY: "fixture-tickflow-key" } });
    await expect(collectSectorObservations(catalogRequest)).rejects.toMatchObject({ code: "unsupported" });
    expect(http).not.toHaveBeenCalled();

    saveSettings({ ...DEFAULT_SETTINGS, revision: readSettings().revision, preferences: { ...DEFAULT_SETTINGS.preferences, source: "tushare" },
      env: { WHYJ_QUANT_TUSHARE_TOKEN: credential } });
    http.mockResolvedValueOnce(new Response(credential, { status: 403 }));
    await expect(collectSectorObservations(catalogRequest)).rejects.toThrow("Provider reference request failed");
    http.mockResolvedValueOnce(table(memberFields, [["20250103", ...memberRow.slice(1)]]));
    await expect(collectSectorObservations(membersRequest)).rejects.toThrow("Provider dated sector membership invalid");
    const controller = new AbortController();
    http.mockImplementationOnce(Object.assign(async () => {
      controller.abort(new Error("Cancelled sector collection"));
      return table(catalogFields, [catalogRow]);
    }, { preconnect }));
    await expect(collectSectorObservations(catalogRequest, { signal: controller.signal })).rejects.toThrow("Cancelled sector collection");
    expect(http).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, "data", "sector-observation-archives-v1"))).toBe(false);
  } finally { http.mockRestore(); }
});

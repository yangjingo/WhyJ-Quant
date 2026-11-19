import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSectorObservations, loadHistoricalMinuteArchive, loadSectorObservationArchive,
  type StoredSectorObservationBatch } from "../index.ts";

const identity = { market: "A", source: "tushare", tradeDate: "2025-01-02", coverage: "unknown", taxonomy: "eastmoney" } as const;
const catalog = (): Extract<StoredSectorObservationBatch, { endpoint: "dc_index" }> => ({
  ...identity, endpoint: "dc_index", kind: "concept", providerType: "概念板块", observedAt: "2025-01-03T02:00:00Z",
  groups: [{ code: "BK1184.DC", name: "人形机器人", level: null }, { code: "BK0493.DC", name: "新能源", level: "主题" }],
});
const memberList = (): Extract<StoredSectorObservationBatch, { endpoint: "dc_member" }> => ({
  ...identity, endpoint: "dc_member", sectorCode: "BK1184.DC", observedAt: "2025-01-03T02:05:00Z",
  members: [{ symbol: "873593.BJ", name: "鼎智科技" }, { symbol: "600000.SH", name: null }],
});

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OHQUANT_DIR;
  root = mkdtempSync(join(tmpdir(), "whyj-sector-archive-"));
  process.env.OHQUANT_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OHQUANT_DIR;
  else process.env.OHQUANT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("catalog and members keep independent times, captured order and immutable corrections", async () => {
  const groupInput = catalog(), memberInput = memberList();
  const [group, again, members] = await Promise.all([
    archiveSectorObservations(groupInput), archiveSectorObservations(groupInput), archiveSectorObservations(memberInput),
  ]);
  expect(group).toEqual(again);
  expect(group.version).toBe(1);
  expect(group.kind).toBe("dated-sector-catalog");
  expect(group.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(members.kind).toBe("dated-sector-members");
  expect(await loadSectorObservationArchive(group)).toEqual(groupInput);
  expect(await loadSectorObservationArchive(members)).toEqual(memberInput);
  const corrected = { ...memberInput, observedAt: "2025-01-04T02:00:00Z", members: memberInput.members.slice(0, 1) };
  const revised = await archiveSectorObservations(corrected);
  expect(revised.revision).not.toBe(members.revision);
  expect(await loadSectorObservationArchive(revised)).toEqual(corrected);
  expect(await loadSectorObservationArchive(members)).toEqual(memberInput);
  const empty = { ...memberInput, members: [] };
  expect(await loadSectorObservationArchive(await archiveSectorObservations(empty))).toEqual(empty);
});

test("rejects invalid taxonomy, dates, identity, extra metadata and cap-saturated responses", async () => {
  const groups = catalog(), members = memberList();
  const invalid = [
    { ...groups, taxonomy: "other" }, { ...groups, kind: "industry" }, { ...groups, tradeDate: "2025-02-30" },
    { ...groups, observedAt: "2025-01-03" }, { ...groups, groups: [groups.groups[0], groups.groups[0]] },
    { ...groups, groups: [{ ...groups.groups[0], code: "885800.TI" }] }, { ...groups, token: "unexpected" },
    { ...members, tradeDate: "2024-12-19" }, { ...members, sectorCode: "BK1184" },
    { ...members, members: [{ symbol: "000001.SH", name: null }] }, { ...members, members: [members.members[0], members.members[0]] },
    { ...members, members: Array.from({ length: 5000 }, () => members.members[0]) },
  ];
  for (const data of invalid) await expect(archiveSectorObservations(data as StoredSectorObservationBatch)).rejects.toThrow("Invalid observation archive");
});

test("exact sector references reject corruption, wrong kinds and cancellation", async () => {
  const members = memberList();
  const ref = await archiveSectorObservations(members);
  await expect(loadSectorObservationArchive({ ...ref, kind: "dated-sector-catalog" })).rejects.toThrow("Invalid");
  await expect(loadSectorObservationArchive({ ...ref, revision: "../private" })).rejects.toThrow("Invalid");
  await expect(loadHistoricalMinuteArchive(ref as never)).rejects.toThrow("Invalid");
  const signal = AbortSignal.abort();
  await expect(loadSectorObservationArchive(ref, signal)).rejects.toThrow();
  await expect(archiveSectorObservations(catalog(), signal)).rejects.toThrow();
  writeFileSync(join(root, "data", "sector-observation-archives-v1", `${ref.revision}.json`), "{}");
  await expect(loadSectorObservationArchive(ref)).rejects.toThrow("damaged");
  await expect(archiveSectorObservations(members)).rejects.toThrow("damaged");
});

import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createDataDrafts } from "../data-drafts.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import { probeDataConnection } from "../../../runtime/data/data-readiness.ts";
import type { SettingsPort } from "../../workbench/model.ts";

const SECRET = "private-synthetic-data-key";
const probe: typeof probeDataConnection = (settings, request, options) => probeDataConnection(settings, request, { ...options,
  adapters: { [request.source]: { fetchBars: async () => [{ date: request.start, open: 10, high: 10, low: 10, close: 10, volume: 1, amount: null }] } } });
function fixture() {
  let saved = structuredClone(DEFAULT_SETTINGS); saved.revision = "r1";
  let changes = 0, busy = false;
  const port: SettingsPort = { read: () => structuredClone(saved), save: next => {
    if (next.revision !== saved.revision) throw Object.assign(new Error("stale"), { code: "ESTORAGECONFLICT" });
    saved = structuredClone(next); saved.revision = "r2";
  } };
  return { port, read: () => saved, changed: () => changes, setBusy: (v: boolean) => { busy = v; }, options: {
    processEnv: {}, probe, beforeSave: () => { if (busy) throw new Error("busy"); }, afterSave: () => { changes++; },
  } };
}

test("a selected source is checked before an exact revision is saved without exposing credentials", async () => {
  const f = fixture(), drafts = createDataDrafts(f.port, f.options), opened = drafts.start();
  const edited = drafts.edit({ id: opened.id, market: "A", source: "tickflow", key: SECRET, endpoint: "http://127.0.0.1:11442" });
  expect(JSON.stringify(edited)).not.toContain(SECRET);
  expect(JSON.stringify(f.read())).not.toContain(SECRET);
  expect(() => drafts.save({ id: opened.id, version: edited.version })).toThrow("请先成功检查");
  const verified = await drafts.verify(opened.id);
  expect(verified).toMatchObject({ canSave: true, sample: { source: "tickflow" }, result: { status: "ready", capability: "daily-bars" } });
  expect(JSON.stringify(verified)).not.toContain(SECRET);
  f.setBusy(true); expect(() => drafts.save({ id: opened.id, version: verified.version })).toThrow("busy"); f.setBusy(false);
  drafts.save({ id: opened.id, version: verified.version });
  expect(f.read().env.WHYJ_QUANT_TICKFLOW_API_KEY).toBe(SECRET);
  expect(f.read().preferences.source).toBe("tickflow"); expect(f.changed()).toBe(1);
  expect(() => drafts.save({ id: opened.id, version: verified.version })).toThrow("已关闭或过期"); drafts.dispose();
});

test("editing, cancellation and stale settings cannot save previously checked evidence", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const gated: typeof probe = async (settings, request, options) => { started(); await new Promise<void>(resolve => { release = resolve; }); return probe(settings, request, options); };
  const drafts = createDataDrafts(f.port, { ...f.options, probe: gated }), first = drafts.start();
  drafts.edit({ id: first.id, market: "A", source: "tickflow", key: SECRET });
  const running = drafts.verify(first.id); await begun;
  const cancelled = drafts.cancel(first.id);
  expect(cancelled).toMatchObject({ cancelled: true, checking: false, canSave: false, sample: { source: "tickflow" } });
  const changed = drafts.edit({ id: first.id, symbol: "600000.SH" });
  release(); await running; await setImmediate();
  expect(() => drafts.save({ id: first.id, version: changed.version })).toThrow("请先成功检查"); drafts.close(first.id);
  const checked = createDataDrafts(f.port, f.options), a = checked.start(), b = checked.start();
  checked.edit({ id: a.id, market: "A", source: "tickflow", key: SECRET });
  checked.edit({ id: b.id, market: "A", source: "tickflow", key: "another-fixture-key" });
  const verifiedA = await checked.verify(a.id), verifiedB = await checked.verify(b.id);
  checked.edit({ id: a.id, symbol: "600000.SH" }); const changedA = await checked.verify(a.id);
  expect(() => checked.save({ id: a.id, version: verifiedA.version })).toThrow("草稿已变化");
  checked.save({ id: a.id, version: changedA.version });
  expect(() => checked.save({ id: b.id, version: verifiedB.version })).toThrow("stale");
  expect(f.read().env.WHYJ_QUANT_TICKFLOW_API_KEY).toBe(SECRET); checked.dispose(); drafts.dispose();
});

test("bounds drafts, rejects unsafe endpoints and clears pending checks on disposal", async () => {
  const f = fixture(), drafts = createDataDrafts(f.port, f.options), ids = Array.from({ length: 8 }, () => drafts.start().id);
  expect(() => drafts.start()).toThrow("草稿过多");
  expect(() => drafts.edit({ id: ids[0]!, source: "tickflow", endpoint: "http://example.com" })).toThrow("参数无效");
  expect(() => drafts.edit({ id: ids[0]!, source: "tickflow", endpoint: "https://user:secret@example.com" })).toThrow("参数无效");
  expect(() => drafts.edit({ id: ids[0]!, unexpected: SECRET } as never)).toThrow("参数无效");
  drafts.dispose(); expect(() => drafts.close(ids[0]!)).toThrow("已关闭或过期");
  let started!: () => void, release!: () => void, signal: AbortSignal | undefined;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const pending = createDataDrafts(f.port, { ...f.options, probe: async (settings, request, options) => {
    signal = options?.signal; started(); await new Promise<void>(resolve => { release = resolve; }); return probe(settings, request, options);
  } });
  const id = pending.start().id; pending.edit({ id, market: "A", source: "tickflow", key: SECRET });
  const checking = pending.verify(id); await begun; pending.dispose();
  await expect(checking).rejects.toThrow("已关闭或过期"); expect(signal?.aborted).toBe(true);
  release(); await setImmediate(); expect(f.changed()).toBe(0);
});

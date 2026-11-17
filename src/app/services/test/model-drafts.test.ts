import { expect, test } from "bun:test";
import { createModelDrafts } from "../model-drafts.ts";
import { DEFAULT_SETTINGS, type OhQuantSettings } from "../../../types/config.ts";
import type { SettingsPort } from "../../workbench/model.ts";
import type { ModelProbeResult } from "../../../runtime/models/model-probe.ts";

const secret = "fixture-model-key-never-return";
const ready: ModelProbeResult = { status: "ready", ok: true, detail: "provider text must not be returned" };
function fixture() {
  let saved: OhQuantSettings = { ...structuredClone(DEFAULT_SETTINGS), revision: "r1", provider: "custom", model: "local-model", thinkingLevel: "off",
    providers: { custom: { api: "openai-completions", baseUrl: "http://127.0.0.1:8765/v1", apiKey: "old-fixture-key" },
      other: { custom: true, baseUrl: "https://other.invalid/v1", apiKey: "unrelated-fixture-key" } } };
  let writes = 0, calls = 0, busy = false, checked: OhQuantSettings | undefined;
  const port: SettingsPort = { read: () => structuredClone(saved), save(next) {
    if (next.revision !== saved.revision) throw Object.assign(new Error("stale"), { code: "ESTORAGECONFLICT" });
    saved = structuredClone(next); saved.revision = `r${++writes + 1}`;
  } };
  return { port, read: () => saved, writes: () => writes, calls: () => calls, checked: () => checked,
    busy: (value: boolean) => { busy = value; }, options: {
      beforeSave: () => { if (busy) throw new Error("busy"); },
      probe: async (next: OhQuantSettings) => { calls++; checked = structuredClone(next); return ready; },
    } };
}

test("keeps the draft private and saves exactly the explicitly checked version", async () => {
  const f = fixture(), drafts = createModelDrafts(f.port, f.options), start = drafts.start();
  expect(f.calls()).toBe(0); expect(f.writes()).toBe(0);
  expect(JSON.stringify(start)).not.toContain("old-fixture-key"); expect(JSON.stringify(start)).not.toContain("127.0.0.1:8765");
  const edited = drafts.edit({ id: start.id, provider: "custom", model: "new-model", protocol: "openai-completions",
    endpoint: "http://127.0.0.1:9999/v1", key: secret, thinkingLevel: "off" });
  expect(JSON.stringify(edited)).not.toContain(secret); expect(f.calls()).toBe(0); expect(f.writes()).toBe(0);
  expect(() => drafts.save({ id: start.id, version: edited.version })).toThrow("请先成功检查");
  const checked = await drafts.verify(start.id);
  expect(checked).toMatchObject({ status: "ready", canSave: true, model: "new-model", keyConfigured: true });
  expect(JSON.stringify(checked)).not.toContain(secret); expect(JSON.stringify(checked)).not.toContain("provider text");
  expect(f.calls()).toBe(1); expect(f.checked()?.providers?.custom?.apiKey).toBe(secret);
  f.busy(true); expect(() => drafts.save({ id: start.id, version: checked.version })).toThrow("busy"); f.busy(false);
  drafts.save({ id: start.id, version: checked.version });
  expect(f.read().model).toBe("new-model"); expect(f.read().providers?.custom?.apiKey).toBe(secret);
  expect(f.read().providers?.other?.apiKey).toBe("unrelated-fixture-key"); expect(f.writes()).toBe(1);
  expect(() => drafts.close(start.id)).toThrow("已关闭或过期"); drafts.dispose();
});

test("edits, cancellation, late checks and competing settings cannot authorize a stale save", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const drafts = createModelDrafts(f.port, { ...f.options, probe: async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return ready; } });
  const opened = drafts.start(), pending = drafts.verify(opened.id); await begun;
  const edited = drafts.edit({ id: opened.id, model: "later-model" });
  expect((await pending).canSave).toBe(false); release(); await Promise.resolve();
  expect(() => drafts.save({ id: opened.id, version: edited.version })).toThrow("请先成功检查");
  const cancelled = drafts.cancel(opened.id); expect(cancelled).toMatchObject({ status: "cancelled", canSave: false });
  drafts.close(opened.id);
  const other = createModelDrafts(f.port, f.options), a = other.start(), b = other.start();
  const checkedA = await other.verify(a.id), checkedB = await other.verify(b.id);
  other.save({ id: a.id, version: checkedA.version });
  expect(() => other.save({ id: b.id, version: checkedB.version })).toThrow("stale");
  const calls = f.calls(); await expect(other.verify(b.id)).rejects.toThrow("其他窗口"); expect(f.calls()).toBe(calls);
  expect(f.writes()).toBe(1); other.dispose(); drafts.dispose();
});

test("bounds drafts, rejects unsafe input, and removes only the chosen saved key", async () => {
  const f = fixture(), drafts = createModelDrafts(f.port, f.options), ids = Array.from({ length: 8 }, () => drafts.start().id);
  expect(() => drafts.start()).toThrow("草稿过多");
  expect(() => drafts.edit({ id: ids[0]!, endpoint: "http://example.com/v1" })).toThrow("参数无效");
  expect(() => drafts.edit({ id: ids[0]!, endpoint: "https://user:secret@example.com/v1" })).toThrow("参数无效");
  expect(() => drafts.edit({ id: ids[0]!, extra: secret } as never)).toThrow("参数无效");
  expect(() => drafts.remove({ provider: "unknown", revision: "r1" })).toThrow("参数无效");
  expect(() => drafts.remove({ provider: "custom", revision: "stale" })).toThrow("其他窗口");
  f.busy(true); expect(() => drafts.remove({ provider: "custom", revision: "r1" })).toThrow("busy"); f.busy(false);
  expect(drafts.remove({ provider: "custom", revision: "r1" })).toBe(true);
  expect(f.read().provider).toBe("custom"); expect(f.read().providers?.custom?.apiKey).toBeUndefined();
  expect(f.read().providers?.other?.apiKey).toBe("unrelated-fixture-key"); expect(f.calls()).toBe(0);
  drafts.dispose(); expect(() => drafts.close(ids[0]!)).toThrow("已关闭或过期");
});

test("does not echo a credential even when it also appears in stored metadata", () => {
  const f = fixture(), current = f.port.read();
  current.model = secret; current.providers!.custom!.apiKey = secret; current.providers!.custom!.name = `label-${secret}`;
  f.port.save(current);
  const drafts = createModelDrafts(f.port, f.options), opened = drafts.start();
  expect(JSON.stringify(opened)).not.toContain(secret); drafts.dispose();
});

test("switching providers preserves the previous provider's configuration exactly", async () => {
  const f = fixture(), before = structuredClone(f.read().providers!.custom), drafts = createModelDrafts(f.port, f.options);
  const opened = drafts.start(); drafts.edit({ id: opened.id, provider: "other", model: "other-model", thinkingLevel: "off" });
  const checked = await drafts.verify(opened.id); expect(checked.canSave).toBe(true);
  drafts.save({ id: opened.id, version: checked.version });
  expect(f.read().providers?.custom).toEqual(before); expect(f.read().provider).toBe("other"); drafts.dispose();
});

test("selecting a different provider does not silently reuse the prior provider's model ID", () => {
  const f = fixture(), drafts = createModelDrafts(f.port, f.options), opened = drafts.start();
  const selected = drafts.edit({ id: opened.id, provider: "openai" });
  expect(selected.provider).toBe("openai"); expect(selected.model).not.toBe("local-model");
  expect(selected.models.some(model => model.id === selected.model)).toBe(true); drafts.dispose();
});

test("opening a legacy draft does not copy its environment credential into provider settings", async () => {
  let saved: OhQuantSettings = { ...structuredClone(DEFAULT_SETTINGS), revision: "r1", env: { WHYJ_QUANT_API_KEY: secret } };
  const port: SettingsPort = { read: () => structuredClone(saved), save: next => { saved = structuredClone(next); } };
  const drafts = createModelDrafts(port, { beforeSave() {}, probe: async () => ready });
  const opened = drafts.start(); expect(opened.keyConfigured).toBe(false); expect(JSON.stringify(opened)).not.toContain(secret);
  const checked = await drafts.verify(opened.id); expect(checked.canSave).toBe(true);
  drafts.save({ id: opened.id, version: checked.version });
  expect(saved.env.WHYJ_QUANT_API_KEY).toBe(secret); expect(saved.providers?.[saved.provider!]?.apiKey).toBeUndefined();
  drafts.dispose();
});

test("a retired provider's saved key can be removed without activating it", () => {
  const f = fixture(), current = f.port.read(); current.providers!.retired = { apiKey: "retired-fixture-key" };
  f.port.save(current); const before = f.read().provider, drafts = createModelDrafts(f.port, f.options);
  expect(drafts.remove({ provider: "retired", revision: f.read().revision })).toBe(true);
  expect(f.read().providers?.retired?.apiKey).toBeUndefined(); expect(f.read().provider).toBe(before);
  expect(f.calls()).toBe(0); drafts.dispose();
});

test("refuses key replacement when an existing auth header could override the new key", () => {
  for (const modelScoped of [false, true]) {
    const f = fixture(), current = f.port.read(), config = current.providers!.custom!;
    if (modelScoped) config.models = { "local-model": { headers: { Authorization: "Bearer hidden-old-header" } } };
    else config.headers = { "x-api-key": "hidden-old-header" };
    f.port.save(current);
    const drafts = createModelDrafts(f.port, f.options), opened = drafts.start();
    expect(JSON.stringify(opened)).not.toContain("hidden-old-header");
    expect(() => drafts.edit({ id: opened.id, key: secret })).toThrow("认证头");
    expect(f.read().providers?.custom?.apiKey).toBe("old-fixture-key"); expect(f.calls()).toBe(0); drafts.dispose();
  }
});

test("disposal aborts a pending probe and rejects a later success", async () => {
  const f = fixture(); let started!: () => void, release!: () => void, signal: AbortSignal | undefined;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const drafts = createModelDrafts(f.port, { ...f.options, probe: async (_settings, options) => {
    signal = options?.signal; started(); await new Promise<void>(resolve => { release = resolve; }); return ready;
  } });
  const opened = drafts.start(), pending = drafts.verify(opened.id); await begun;
  drafts.dispose(); expect(signal?.aborted).toBe(true); await expect(pending).rejects.toThrow("已关闭或过期");
  release(); await Promise.resolve(); expect(f.writes()).toBe(0);
});

import { expect, test } from "bun:test";
import { removeDataCredential } from "../data-credentials.ts";
import { DEFAULT_SETTINGS } from "../../../types/config.ts";
import type { SettingsPort } from "../../workbench/model.ts";

test("removes only the selected local key without a provider request or source change", () => {
  const current = structuredClone(DEFAULT_SETTINGS); current.revision = "r1"; current.preferences.source = "tickflow";
  current.env.WHYJ_QUANT_TICKFLOW_API_KEY = "synthetic-private-tickflow";
  current.env.WHYJ_QUANT_TUSHARE_TOKEN = "synthetic-private-tushare";
  let saved = structuredClone(current), writes = 0;
  const port: SettingsPort = { read: () => structuredClone(saved), save: value => { writes++; saved = structuredClone(value); } };
  const oldEnv = process.env.WHYJ_QUANT_TICKFLOW_API_KEY; process.env.WHYJ_QUANT_TICKFLOW_API_KEY = "synthetic-environment";
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("unexpected request"); }) as unknown as typeof fetch;
  try {
    expect(removeDataCredential(port, { source: "tickflow", revision: "r1" })).toBe(true);
    expect(saved.env.WHYJ_QUANT_TICKFLOW_API_KEY).toBeUndefined();
    expect(saved.env.WHYJ_QUANT_TUSHARE_TOKEN).toBe("synthetic-private-tushare");
    expect(saved.preferences.source).toBe("tickflow"); expect(process.env.WHYJ_QUANT_TICKFLOW_API_KEY).toBe("synthetic-environment"); expect(requests).toBe(0); expect(writes).toBe(1);
    expect(removeDataCredential(port, { source: "tickflow", revision: "r1" })).toBe(false); expect(writes).toBe(1);
  } finally { globalThis.fetch = original; if (oldEnv === undefined) delete process.env.WHYJ_QUANT_TICKFLOW_API_KEY; else process.env.WHYJ_QUANT_TICKFLOW_API_KEY = oldEnv; }
});

test("rejects stale revisions, unsupported providers and unexpected fields without mutation", () => {
  const current = structuredClone(DEFAULT_SETTINGS); current.revision = "r1"; current.env.WHYJ_QUANT_TICKFLOW_API_KEY = "synthetic-private";
  let writes = 0; const port: SettingsPort = { read: () => current, save: () => { writes++; } };
  for (const input of [{ source: "tickflow", revision: "old" }, { source: "akshare", revision: "r1" },
    { source: "tickflow", revision: "r1", key: "secret" }, { source: "tickflow" }, null]) {
    expect(() => removeDataCredential(port, input)).toThrow();
  }
  expect(writes).toBe(0); expect(current.env.WHYJ_QUANT_TICKFLOW_API_KEY).toBe("synthetic-private");
});

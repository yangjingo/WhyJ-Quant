import { expect, test } from "bun:test";
import { createHostClient } from "../client.ts";

test("an unsupported optional RPC retains its fixed code without masking other failures", async () => {
  const connection = { token: "fixture-token", instanceId: "fixture-instance", workspaceId: "fixture-workspace" };
  const client = (status: number, code: string) => createHostClient({ baseUrl: "http://127.0.0.1:1", connection,
    fetch: async () => Response.json({ ok: false, error: { code, message: "fixture failure" } }, { status }) });
  await expect(client(404, "METHOD_NOT_FOUND").startDataDraft!()).rejects.toMatchObject({ code: "METHOD_NOT_FOUND", message: "fixture failure" });
  const other = await client(503, "HOST_STOPPING").startDataDraft!().catch(error => error);
  expect(other.message).toBe("fixture failure"); expect(other.code).toBeUndefined();
});

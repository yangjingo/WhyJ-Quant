import { expect, test } from "bun:test";
import { createHostClient } from "../client.ts";

test("an unsupported optional RPC retains its fixed code without masking other failures", async () => {
  const connection = { token: "fixture-token", instanceId: "fixture-instance", workspaceId: "fixture-workspace" };
  const client = (status: number, code: string) => createHostClient({ baseUrl: "http://127.0.0.1:1", connection,
    fetch: async () => Response.json({ ok: false, error: { code, message: "fixture failure" } }, { status }) });
  await expect(client(404, "METHOD_NOT_FOUND").startDataDraft!()).rejects.toMatchObject({ code: "METHOD_NOT_FOUND", message: "fixture failure" });
  await expect(client(404, "METHOD_NOT_FOUND").readObservationIndicators!({ version: 2, revision: "a".repeat(64) }))
    .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  await expect(client(404, "METHOD_NOT_FOUND").readObservationAnalytics!({ version: 2, revision: "a".repeat(64) }))
    .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  await expect(client(404, "METHOD_NOT_FOUND").readObservationExchangeIndicators!({
    archiveRef: { version: 2, revision: "a".repeat(64) },
    tradingLimitArchiveRef: { version: 1, kind: "daily-trading-limits", revision: "b".repeat(64) },
  })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  await expect(client(404, "METHOD_NOT_FOUND").readObservationIntraday!({
    archiveRef: { version: 1, kind: "historical-minute-bars", revision: "a".repeat(64) }, tradeDate: "2024-01-02",
  })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  const other = await client(503, "HOST_STOPPING").startDataDraft!().catch(error => error);
  expect(other.message).toBe("fixture failure"); expect(other.code).toBeUndefined();
});

test("observation jobs retain only definitive method-specific status and code pairs", async () => {
  const connection = { token: "fixture-token", instanceId: "fixture-instance", workspaceId: "fixture-workspace" };
  const client = (status: number, code: string) => createHostClient({ baseUrl: "http://127.0.0.1:1", connection,
    fetch: async () => Response.json({ ok: false, error: { code, message: "fixture failure" } }, { status }) });
  const request = { dataset: "daily", symbol: "600000.SH", startTime: 1, endTime: 2, adjustment: "none" } as const;
  for (const [status, code] of [[400, "INPUT_INVALID"], [409, "OBSERVATION_BUSY"]] as const)
    await expect(client(status, code).startObservationJob!(request)).rejects.toMatchObject({ code });
  for (const method of ["readObservationJob", "cancelObservationJob"] as const)
    await expect(client(404, "OBSERVATION_JOB_NOT_FOUND")[method]!("fixture")).rejects.toMatchObject({ code: "OBSERVATION_JOB_NOT_FOUND" });
  for (const [status, code] of [[409, "INPUT_INVALID"], [400, "OBSERVATION_BUSY"], [503, "INPUT_INVALID"], [404, "OBSERVATION_JOB_NOT_FOUND"], [400, "UNKNOWN"]] as const) {
    const error = await client(status, code).startObservationJob!(request).catch(error => error);
    expect(error.code).toBeUndefined();
  }
  const wrongMethod = await client(400, "INPUT_INVALID").startDataDraft!().catch(error => error);
  expect(wrongMethod.code).toBeUndefined();
  const malformed = createHostClient({ baseUrl: "http://127.0.0.1:1", connection,
    fetch: async () => Response.json({ ok: true, error: { code: "INPUT_INVALID" } }, { status: 400 }) });
  expect((await malformed.startObservationJob!(request).catch(error => error)).code).toBeUndefined();
  const missingMessage = createHostClient({ baseUrl: "http://127.0.0.1:1", connection,
    fetch: async () => Response.json({ ok: false, error: { code: "INPUT_INVALID" } }, { status: 400 }) });
  expect((await missingMessage.startObservationJob!(request).catch(error => error)).code).toBeUndefined();
  const disconnected = createHostClient({ baseUrl: "http://127.0.0.1:1", connection, fetch: async () => { throw new Error("transport"); } });
  const error = await disconnected.startObservationJob!(request).catch(error => error);
  expect(error.code).toBeUndefined();
});

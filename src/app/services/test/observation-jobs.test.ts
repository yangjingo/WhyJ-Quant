import { expect, test } from "bun:test";
import { createObservationJobs, observationJobRequest } from "../observation-jobs.ts";
import type { ObservationCollectionReceipt, TradingDateCollectionReceipt } from "../../../runtime/data/observation-collection.ts";

const daily = { dataset: "daily", symbol: "600000.SH", startTime: 1_700_000_000_000, endTime: 1_700_000_001_000, adjustment: "none" } as const;
const receipt: ObservationCollectionReceipt = { status: "archived", source: "tickflow", endpoint: "/v1/klines", observedAt: "2025-01-01T00:00:00Z", rowCount: 1, ref: { version: 1, revision: "a".repeat(64) } };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const dated = { dataset: "daily", timeMode: "trading-date", symbol: "600000.SH", startDate: "2024-01-02", endDate: "2024-01-03", adjustment: "none" } as const;
const datedReceipt: TradingDateCollectionReceipt = { status: "archived", source: "tushare", endpoint: "daily", observedAt: "2024-01-05T00:00:00Z", rowCount: 1, ref: { version: 2, revision: "b".repeat(64) } };

test("validates the complete bounded request before starting work", () => {
  const invalids = [{ ...daily, key: "secret" }, { ...daily, symbol: "../a" }, { ...daily, startTime: 0 },
    { ...daily, endTime: daily.startTime + 367 * 86_400_000 }, { ...daily, dataset: "minute", interval: "1d" },
    { ...daily, dataset: "factor" }, { ...daily, dataset: "unknown" }];
  const jobs = createObservationJobs(async () => receipt);
  for (const input of invalids) expect(() => jobs.start(input)).toThrow();
  expect(observationJobRequest({ dataset: "factor", symbol: "600000.SH", startTime: daily.startTime, endTime: daily.endTime }).dataset).toBe("factor");
});

test("validates date-keyed daily jobs before starting and refuses extra credentials", () => {
  const invalids = [{ ...dated, key: "secret" }, { ...dated, symbol: "../x" }, { ...dated, startDate: "2024-02-30" },
    { ...dated, startDate: "2024-01-04" }, { ...dated, endDate: "2025-01-03" }, { ...dated, adjustment: "unknown" },
    { ...dated, startTime: 1 }, { ...dated, startDate: 123 }];
  const jobs = createObservationJobs(async () => receipt, async () => datedReceipt);
  for (const input of invalids) expect(() => jobs.start(input)).toThrow();
  expect(observationJobRequest(dated)).toEqual(dated);
});

test("date-keyed jobs return committed v2 receipts after cancellation, preserving old calls", async () => {
  let done!: (value: TradingDateCollectionReceipt) => void; let input: unknown; let captured: AbortSignal | undefined;
  const jobs = createObservationJobs(async () => receipt, async (request, options) => {
    input = request; captured = options?.signal; return new Promise(resolve => { done = resolve; });
  });
  const started = jobs.start(dated); await tick();
  expect(input).toEqual({ timeMode: "trading-date", symbol: dated.symbol, assetType: "stock", interval: "1d", adjustment: "none", startDate: dated.startDate, endDate: dated.endDate });
  jobs.cancel(started.id); expect(captured?.aborted).toBe(true); done(datedReceipt); await tick();
  expect(jobs.read(started.id)).toMatchObject({ status: "archived", cancelRequested: true, receipt: { source: "tushare", ref: datedReceipt.ref } });
  const legacy = jobs.start(daily); await tick(); expect(jobs.read(legacy.id)).toMatchObject({ status: "archived", receipt: { ref: receipt.ref } });
  await jobs.close();
});

test("limits concurrent jobs, cancels only the specified job and reports the actual committed result", async () => {
  let done!: (value: ObservationCollectionReceipt) => void; let captured: AbortSignal | undefined;
  const jobs = createObservationJobs(async (_request, options) => { captured = options?.signal; return new Promise(resolve => { done = resolve; }); });
  const started = jobs.start(daily); await tick();
  expect(() => jobs.start(daily)).toThrow("已有采集任务");
  expect(() => jobs.cancel("00000000-0000-0000-0000-000000000000")).toThrow();
  expect(captured?.aborted).toBe(false);
  expect(jobs.cancel(started.id)).toMatchObject({ status: "running", cancelRequested: true });
  expect(captured?.aborted).toBe(true);
  done(receipt); await tick();
  expect(jobs.read(started.id)).toMatchObject({ status: "archived", cancelRequested: true, receipt: { ref: receipt.ref, rowCount: 1 } });
  expect(jobs.cancel(started.id).status).toBe("archived");
  await jobs.close();
});

test("sanitizes failures and drains cancelled work before closing", async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const jobs = createObservationJobs(async (_request, options) => {
    entered(); await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("key=secret path=C:/private");
  });
  const started = jobs.start(daily); await ready;
  const closing = jobs.close(); await closing;
  expect(() => jobs.read(started.id)).toThrow();
  const failed = createObservationJobs(async () => { throw new Error("key=secret path=C:/private"); });
  const item = failed.start(daily); await tick();
  expect(failed.read(item.id)).toMatchObject({ status: "failed", error: "COLLECTION_FAILED", receipt: null });
  expect(JSON.stringify(failed.read(item.id))).not.toContain("secret");
  await failed.close();
});

test("retains a bounded number of completed empty receipts", async () => {
  const jobs = createObservationJobs(async () => ({ status: "empty", source: "tickflow", endpoint: "/v1/klines", observedAt: "2025-01-01T00:00:00Z", rowCount: 0, ref: null }));
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) { ids.push(jobs.start(daily).id); await tick(); }
  expect(() => jobs.read(ids[0])).toThrow();
  expect(jobs.read(ids[20])).toMatchObject({ status: "empty", receipt: { rowCount: 0, ref: null } });
  await jobs.close();
});

test("distinguishes an abort rejection from another failure after cancellation", async () => {
  for (const genuineAbort of [true, false]) {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const jobs = createObservationJobs(async (_request, options) => {
      started(); await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      if (genuineAbort) options!.signal!.throwIfAborted();
      throw new Error("unrelated failure");
    });
    const job = jobs.start(daily); await ready; jobs.cancel(job.id); await tick();
    expect(jobs.read(job.id)).toMatchObject({ status: genuineAbort ? "cancelled" : "failed", error: genuineAbort ? null : "COLLECTION_FAILED" });
    await jobs.close();
  }
});

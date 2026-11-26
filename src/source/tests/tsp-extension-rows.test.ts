import { expect, spyOn, test } from "bun:test";
import { fetchTspExtensionIntradaySeries, fetchTspExtensionPage, type TspExtensionRowsRequest } from "../index.ts";

const date = "2025-06-18";
const request = { datasetId: "flow_demo", selection: { mode: "timeseries", date },
  columns: ["category", "flow", "symbol"], offset: 0, limit: 2,
} satisfies TspExtensionRowsRequest;
const token = "tsp_extension_fixture";
const connection = { baseUrl: "https://tsp.example.test/", apiKey: token };
const payload = {
  id: "flow_demo", label: "Flow", mode: "timeseries", date, total: 3, offset: 0, limit: 2,
  fields: [
    { name: "category", dtype: "string", label: "Category" },
    { name: "flow", dtype: "float", label: "Flow" },
    { name: "other", dtype: "int", label: "Other" },
  ],
  rows: [{ category: "A/B", flow: 0, symbol: "600001.SH", other: 5 }, { category: "A", flow: null }],
};

test("reads the explicit Bearer-authenticated projection and retains a versioned single-page receipt", async () => {
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(payload)).mockResolvedValueOnce(Response.json(payload));
  try {
    const page = await fetchTspExtensionPage(request, connection);
    const [target, init] = provider.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.origin).toBe("https://tsp.example.test");
    expect(url.pathname).toBe("/api/ext-data/flow_demo/rows");
    expect([...url.searchParams.entries()]).toEqual([
      ["columns", "category,flow,symbol"], ["offset", "0"], ["limit", "2"], ["date", date],
    ]);
    expect(init).toMatchObject({ redirect: "error", headers: { authorization: "Bearer " + token } });
    expect(page).toMatchObject({
      source: "tsp", origin: url.origin, originalPublisher: "unknown", sourceAsOf: null, request, partitionDate: date,
      snapshotSyncLocal: null, coverage: "partial", totalRows: 3, omittedFields: ["symbol"],
      fields: [{ name: "category", dtype: "string" }, { name: "flow", dtype: "float" }, { name: "symbol", dtype: "string" }],
      rows: [{ category: "A/B", flow: 0, symbol: "600001.SH" }, { category: "A", flow: null }],
    });
    expect(page.rows[0]).not.toHaveProperty("other");
    expect(page.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(page.schemaRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(Date.parse(page.observedAt))).toBe(true);
    expect(JSON.stringify(page)).not.toContain(token);
    expect((await fetchTspExtensionPage(request, connection)).revision).toBe(page.revision);
    provider.mockResolvedValueOnce(Response.json({ ...payload,
      rows: [{ ...payload.rows[0], flow: 1 }, payload.rows[1]],
    }));
    const revised = await fetchTspExtensionPage(request, connection);
    expect(revised.revision).not.toBe(page.revision);
    expect(revised.schemaRevision).toBe(page.schemaRevision);
  } finally { provider.mockRestore(); }
});

test("keeps the latest snapshot sync wall time and absent dated partition separate", async () => {
  const snapshotSyncLocal = "2025-06-18 16:00:10";
  const provider = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    ...payload, mode: "snapshot", date: snapshotSyncLocal, total: 1, rows: [payload.rows[0]],
  })).mockResolvedValueOnce(Response.json({ ...payload, date: null, total: 0, rows: [] }));
  try {
    const snapshot = await fetchTspExtensionPage({ ...request, selection: { mode: "snapshot" } }, connection);
    expect(snapshot).toMatchObject({ snapshotSyncLocal, partitionDate: null, sourceAsOf: null, coverage: "complete", totalRows: 1 });
    expect(new URL(String(provider.mock.calls[0]?.[0])).searchParams.has("date")).toBe(false);
    expect(await fetchTspExtensionPage(request, connection)).toMatchObject({
      request, partitionDate: null, snapshotSyncLocal: null, sourceAsOf: null, rows: [], totalRows: 0,
    });
  } finally { provider.mockRestore(); }
});

test("reads a final page at the requested offset from the configured TSP origin", async () => {
  const pageRequest = { ...request, offset: 2 };
  let received: { method: string; path: string; authorization: string | null; offset: string | null } | undefined;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(incoming) {
    const url = new URL(incoming.url);
    received = { method: incoming.method, path: url.pathname, authorization: incoming.headers.get("authorization"),
      offset: url.searchParams.get("offset") };
    return Response.json({ ...payload, offset: pageRequest.offset, rows: [payload.rows[0]] });
  } });
  try {
    const page = await fetchTspExtensionPage(pageRequest, { env: {
      WHYJ_QUANT_TSP_BASE_URL: provider.url.origin, WHYJ_QUANT_TSP_READ_EXT_TOKEN: token,
    } });
    expect(received).toEqual({ method: "GET", path: "/api/ext-data/flow_demo/rows", authorization: "Bearer " + token, offset: "2" });
    expect(page).toMatchObject({ origin: provider.url.origin, request: pageRequest, coverage: "partial", totalRows: 3,
      rows: [{ category: "A/B", flow: 0, symbol: "600001.SH" }] });
  } finally { await provider.stop(true); }
});

test("rejects mismatched scopes, malformed cells and reflected secrets without leaking the request", async () => {
  const provider = spyOn(globalThis, "fetch");
  try {
    for (const body of [
      { ...payload, id: "other" }, { ...payload, mode: "snapshot" }, { ...payload, date: "2025-06-19" },
      { ...payload, offset: 1 }, { ...payload, limit: 3 },
      { ...payload, total: 5, rows: [payload.rows[0]] },
      { ...payload, rows: [{ ...payload.rows[0], flow: "10" }, payload.rows[1]] },
      { ...payload, fields: [] },
      { ...payload, label: token },
    ]) {
      provider.mockResolvedValueOnce(Response.json(body));
      await expect(fetchTspExtensionPage(request, connection)).rejects.toMatchObject({ code: "provider-failure" });
    }
    provider.mockRejectedValueOnce(new Error(token));
    await expect(fetchTspExtensionPage(request, connection)).rejects.toThrow("TSP extension rows request failed");
    provider.mockClear();
    await expect(fetchTspExtensionPage({ ...request, columns: ["x,y"] }, connection)).rejects.toThrow("Invalid TSP extension");
    await expect(fetchTspExtensionPage(request, { ...connection, baseUrl: "http://tsp.example.test" })).rejects.toThrow("Invalid TSP base");
    await expect(fetchTspExtensionPage(request, connection, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(provider).not.toHaveBeenCalled();
  } finally { provider.mockRestore(); }
});

test("reads an exact intraday extension series and preserves native wall times, zero and signed values", async () => {
  const observed = "600001.SH", missing = "600002.SH", empty = "000001.SZ";
  const request = { datasetId: "auction_demo", field: "竞价未匹配量", date, symbols: [missing, observed, empty] };
  const requests: URL[] = [];
  let redirect = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    requests.push(url);
    if (req.headers.get("authorization") !== "Bearer " + token) return new Response(null, { status: 403 });
    if (redirect) return new Response(null, { status: 302, headers: { location: "/unexpected-target" } });
    return Response.json({ config_id: request.datasetId, field: request.field, date, granularity: "intraday",
      items: { [observed]: [["09:15", 0], ["09:16:00", -7], ["09:16:00", 18]], [empty]: [] } });
  } });
  try {
    const connection = { baseUrl: provider.url.origin, apiKey: token };
    const result = await fetchTspExtensionIntradaySeries(request, connection);
    expect(requests[0]!.pathname).toBe("/api/ext-data/auction_demo/series");
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      date, field: request.field, symbols: request.symbols.join(","), granularity: "intraday",
    });
    expect(result).toMatchObject({ source: "tsp", originalPublisher: "unknown", sourceAsOf: null, request,
      timeBasis: "provider-wall-clock", valueUnit: "unknown", series: [
        { symbol: missing, points: null },
        { symbol: observed, points: [{ time: "09:15", value: 0 }, { time: "09:16:00", value: -7 }, { time: "09:16:00", value: 18 }] },
        { symbol: empty, points: [] },
      ] });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(token);
    expect((await fetchTspExtensionIntradaySeries(request, connection)).revision).toBe(result.revision);
    redirect = true;
    await expect(fetchTspExtensionIntradaySeries(request, connection)).rejects.toThrow("TSP extension series request failed");
    expect(requests).toHaveLength(3);
    expect(requests.every(url => url.pathname === "/api/ext-data/auction_demo/series")).toBe(true);
  } finally { await provider.stop(true); }
});

test("rejects mismatched extension series scope, invalid labels and nonnumeric observations", async () => {
  const request = { datasetId: "auction_demo", field: "qty", date, symbols: ["600000.SH"] };
  const payload = { config_id: request.datasetId, field: request.field, date, granularity: "intraday", items: {} };
  const fetcher = spyOn(globalThis, "fetch");
  try {
    for (const invalid of [
      { ...request, datasetId: "../escape" }, { ...request, date: "2025-02-30" }, { ...request, field: "a,b" },
      { ...request, date: "0000-01-01" }, { ...request, symbols: new Array<string>(1) },
      { ...request, symbols: [] }, { ...request, symbols: ["600001.SH", "600001.SH"] }, { ...request, symbols: ["x,y"] },
    ]) await expect(fetchTspExtensionIntradaySeries(invalid, connection)).rejects.toThrow("Invalid TSP extension intraday series request");
    expect(fetcher).not.toHaveBeenCalled();
    for (const body of [
      { ...payload, config_id: "stale_id" }, { ...payload, date: "2025-06-17" }, { ...payload, field: "other" },
      { ...payload, granularity: "daily" }, { ...payload, items: { "600001.SH": [["09:30", 0]] } },
      { ...payload, items: { "600000.SH": [["25:00", 0]] } }, { ...payload, items: { "600000.SH": [["09:30", null]] } },
      { ...payload, items: { "600000.SH": [["09:30", token]] } },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(body));
      await expect(fetchTspExtensionIntradaySeries(request, connection)).rejects.toMatchObject({ code: "provider-failure" });
    }
    fetcher.mockResolvedValueOnce(Response.json(payload));
    expect((await fetchTspExtensionIntradaySeries(request, connection)).series).toEqual([{ symbol: "600000.SH", points: null }]);
  } finally { fetcher.mockRestore(); }
});

test("distinguishes a source timeout from an explicit cancellation", async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const stalled = ((...[_target, options]: Parameters<typeof fetch>) => new Promise<Response>((_, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    started();
  })) as typeof fetch;
  const provider = spyOn(globalThis, "fetch").mockImplementation(stalled);
  try {
    const controller = new AbortController();
    const pending = fetchTspExtensionPage(request, connection, { signal: controller.signal });
    await startedPromise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(fetchTspExtensionPage(request, connection, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  } finally { provider.mockRestore(); }
});

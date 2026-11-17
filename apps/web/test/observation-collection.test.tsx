import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ObservationCollection, observationRequest, type CollectionFields } from "../src/components/ObservationCollection";
import type { WorkbenchClient } from "../src/client/contract";

const base: CollectionFields = { dataset: "daily", symbol: "600000.SH", start: "2026-11-12", end: "2026-11-12", adjustment: "none", interval: "1m" };
test("uses Shanghai days and builds exact Host requests", () => {
  const startTime = Date.parse("2026-11-12T00:00:00+08:00"), endTime = Date.parse("2026-11-12T23:59:59.999+08:00");
  expect(observationRequest(base)).toEqual({ dataset: "daily", symbol: "600000.SH", startTime, endTime, adjustment: "none" });
  expect(observationRequest({ ...base, dataset: "minute", interval: "5m", adjustment: "forward" })).toEqual({ dataset: "minute", symbol: "600000.SH", startTime, endTime, adjustment: "forward", interval: "5m" });
  expect(observationRequest({ ...base, dataset: "factor" })).toEqual({ dataset: "factor", symbol: "600000.SH", startTime, endTime });
});
test("rejects invalid dates, symbol, inverted and oversized windows", () => {
  for (const change of [{ symbol: "600000" }, { start: "2026-02-30" }, { start: "2026-11-13" }, { dataset: "minute" as const, start: "2026-10-01" }]) expect(observationRequest({ ...base, ...change })).toBeNull();
});
test("reports unsupported host without exposing collection controls", () => {
  const html = renderToStaticMarkup(<ObservationCollection client={{ mode: "host" } as WorkbenchClient} />);
  expect(html).toContain("当前连接不支持行情采集"); expect(html).not.toContain("开始采集");
});

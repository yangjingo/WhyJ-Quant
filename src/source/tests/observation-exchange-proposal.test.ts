import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Compile } from "typebox/compile";

// Proposal checks illustrate required receiver behavior; they are not a production validator.
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../docs/quant-harness/${name}`, import.meta.url), "utf8"));
const schema = read("observation-exchange-proposed.schema.json");
const examples = read("observation-exchange-proposed.examples.json") as Array<any>;
const check = Compile(schema);
function compare(a: string, b: string): number {
  const [ai, af = ""] = a.split("."), [bi, bf = ""] = b.split(".");
  const scale = Math.max(af!.length, bf!.length);
  const x = BigInt(ai! + af!.padEnd(scale, "0")), y = BigInt(bi! + bf!.padEnd(scale, "0"));
  return x < y ? -1 : x > y ? 1 : 0;
}
function validDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function validInstant(s: string): boolean {
  return validDate(s.slice(0, 10)) && Number(s.slice(11, 13)) < 24 && Number(s.slice(14, 16)) < 60
    && Number(s.slice(17, 19)) < 60 && Number.isFinite(Date.parse(s));
}
function validZone(s: string): boolean { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } }
function valid(value: any): boolean {
  if (!check.Check(value)) return false;
  const batch = value as any;
  const { request, response } = batch, range = request.range;
  const isDate = range.mode === "trading-date";
  if (isDate ? !validDate(range.start) || !validDate(range.end) || range.start > range.end || !validZone(range.timeZone)
    : !validInstant(range.start) || !validInstant(range.end) || Date.parse(range.start) >= Date.parse(range.end)) return false;
  if (!validInstant(response.observedAt) || response.records.length > request.limit) return false;
  if (response.status !== "failed" && (response.actualSource !== request.source || response.endpoint === null)) return false;
  if (response.status === "failed" && response.coverage === "complete") return false;
  const seen = new Set<string>();
  for (const row of response.records) {
    if (row.kind !== request.dataset || !request.symbols.includes(row.identity.symbol)
      || (row.sourceAsOf !== null && !validInstant(row.sourceAsOf))) return false;
    if (row.kind !== "adjustment_factor") {
      if (row.interval !== request.interval || row.adjustment !== request.adjustment) return false;
      const v = row.values;
      if ([v.open, v.high, v.low, v.close].some((x: string) => compare(x, "0") <= 0)
        || compare(v.high, v.open) < 0 || compare(v.high, v.close) < 0 || compare(v.high, v.low) < 0
        || compare(v.low, v.open) > 0 || compare(v.low, v.close) > 0) return false;
    } else if (compare(row.factor, "0") <= 0) return false;
    const time = row.kind === "adjustment_factor" ? row.effectiveTime
      : row.kind === "daily_bar" && row.timeMode === "trading-date" ? { mode: "trading-date", date: row.tradeDate, timeZone: row.calendarTimeZone }
        : { mode: "instant", timestamp: row.timestamp };
    if (time.mode !== range.mode) return false;
    if (isDate ? !validDate(time.date) || !validZone(time.timeZone) || time.timeZone !== range.timeZone || time.date < range.start || time.date > range.end
      : !validInstant(time.timestamp) || Date.parse(time.timestamp) < Date.parse(range.start) || Date.parse(time.timestamp) >= Date.parse(range.end)) return false;
    if (row.sourceTimestamp !== undefined && row.sourceTimestamp !== null) {
      if (!validInstant(row.sourceTimestamp)) return false;
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: time.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(row.sourceTimestamp)).map(part => [part.type, part.value]));
      if (`${parts.year}-${parts.month}-${parts.day}` !== time.date) return false;
    }
    const key = `${row.identity.symbol}:${isDate ? time.date : time.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
const changed = (i: number, edit: (x: any) => void) => { const x = structuredClone(examples[i]); edit(x); return x; };

test("proposal examples cover date and timestamp daily, minute and factor observations", () => {
  expect(examples).toHaveLength(6);
  expect(examples.every(valid)).toBe(true);
  expect(examples[0].response.records[0].sourceTimestamp).toBeNull();
  expect(examples[0].response.records[0].values.amount).toBeNull();
  expect(examples[4].response.records[0].values.amount).toBe("0");
  expect(examples[5].response.error.code).toBe("entitlement");
});
test("rejects malformed and contradictory examples without pretending the schema checks everything", () => {
  for (const x of [changed(0, x => { x.schemaVersion = "proposed-2"; }),
    changed(0, x => { x.response.records[0].values.volume = 0; }),
    changed(0, x => { x.response.records[0].values.close = "13"; }),
    changed(0, x => { x.response.records[0].tradeDate = "2024-02-30"; }),
    changed(4, x => { x.response.records[0].sourceTimestamp = "2024-01-01T15:59:59Z"; }),
    changed(0, x => { x.response.records[0].identity.symbol = "600001.SH"; }),
    changed(0, x => { x.response.actualSource = "tushare"; }),
    changed(0, x => { x.response.endpoint = "/v1/klines?token=secret"; }),
    changed(0, x => { x.request.apiKey = "secret"; }),
    changed(0, x => { x.request.adjustment = null; x.response.records = []; }),
    changed(0, x => { x.response.records.push(structuredClone(x.response.records[0])); }),
    changed(0, x => { x.request.dataset = "minute_bar"; x.request.interval = "1m"; }),
    changed(1, x => { x.response.records[0].timestamp = x.request.range.end; }),
    changed(2, x => { x.response.nextCursor = null; }),
    changed(3, x => { x.response.records[0].factor = "0"; }),
    changed(3, x => { x.response.status = "failed"; x.response.error = null; })]) expect(valid(x)).toBe(false);
});

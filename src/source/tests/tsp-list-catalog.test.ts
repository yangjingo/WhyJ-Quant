import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TSP_LIST_CATALOG_REVISION, TSP_LIST_CATALOG_VERSION, TSP_LIST_COLUMNS } from "../index.ts";

test("pinned TSP list catalog includes visible and hidden declarations without duplicates", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/tsp-list-columns-f9cb383.json", import.meta.url), "utf8"));
  const declarations = TSP_LIST_COLUMNS.map(({ panel, key, label, defaultVisible }) => ({ panel, key, label, defaultVisible }));
  expect(TSP_LIST_CATALOG_VERSION).toBe(1);
  expect(TSP_LIST_CATALOG_REVISION).toBe("f9cb383c5918c6a88a412f3ce43d59fe81b94ccc");
  expect(declarations).toEqual(fixture);
  expect(new Set(declarations.map(({ panel, key }) => `${panel}:${key}`)).size).toBe(114);
  expect(new Set(declarations.map(({ key }) => key)).size).toBe(64);
  expect(declarations.filter(row => row.panel === "watchlist" && !row.defaultVisible)).toHaveLength(50);
  expect(declarations.filter(row => row.panel === "screener" && !row.defaultVisible)).toHaveLength(44);
});

test("renderer references preserve renamed fields and leave contextual mappings unresolved", () => {
  const column = (key: string) => TSP_LIST_COLUMNS.find(row => row.panel === "watchlist" && row.key === key)!;
  expect(column("rsi14").rendererFields).toEqual(["rsi_14"]);
  expect(column("atr14").rendererFields).toEqual(["atr_14"]);
  expect(column("annual_vol").rendererFields).toEqual(["annual_vol_20d"]);
  expect(column("float_val").rendererFields).toEqual(["float_shares", "close"]);
  expect(column("candle").rendererMapping).toBe("unresolved");
  expect(TSP_LIST_COLUMNS.every(row => row.rendererMapping === (row.rendererFields.length ? "shared-renderer" : "unresolved"))).toBe(true);
});

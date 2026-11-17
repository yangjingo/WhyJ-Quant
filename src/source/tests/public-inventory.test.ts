import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("Source inventory lists each named public export exactly once", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("index.ts", entry, ts.ScriptTarget.Latest, true);
  const exported: string[] = [];
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) throw new Error("Inventory check needs updating for default Source exports");
    if (!ts.isExportDeclaration(statement)) {
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        throw new Error("Inventory check needs updating for local Source exports");
      }
      continue;
    }
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      throw new Error("Inventory check needs updating for non-named Source exports");
    }
    for (const item of statement.exportClause.elements) exported.push(item.name.text);
  }
  const inventory = readFileSync(new URL("../../../docs/quant-harness/source-public-inventory.md", import.meta.url), "utf8");
  const listed = [...inventory.matchAll(/^\| `([^`]+)` \| (?:value|type) \|/gm)].map(match => match[1]!);
  expect(listed.length).toBe(new Set(listed).size);
  expect(listed.sort()).toEqual(exported.sort());
});

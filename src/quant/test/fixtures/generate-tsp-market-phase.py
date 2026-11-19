"""Run the pinned classifier against deterministic synthetic series without Polars."""
import ast
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

REVISION = "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc"
FIELDS = {
    "height": "max_consecutive", "firstBoardCount": "first_board", "twoOrMoreCount": "ge2_count",
    "promotionFraction": "promo_rate", "sealFraction": "seal_rate",
}

class Series:
    def __init__(self, name, values, dtype=None):
        self.name, self.values = name, values

    def to_list(self):
        return self.values

    def alias(self, name):
        return Series(name, self.values)

class Frame:
    def __init__(self, rows):
        self.rows = rows
        self.height = len(rows)
        self.columns = list(rows[0])

    def sort(self, column):
        return Frame(sorted(self.rows, key=lambda row: row[column]))

    def __getitem__(self, column):
        return Series(column, [row[column] for row in self.rows])

    def with_columns(self, series):
        return Frame([{**row, series.name: value} for row, value in zip(self.rows, series.values)])

source = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
definitions = [node for node in source.body if (
    isinstance(node, ast.ImportFrom) and node.module == "__future__"
) or (
    isinstance(node, ast.Assign) and not any(isinstance(target, ast.Name) and target.id == "logger" for target in node.targets)
) or isinstance(node, ast.FunctionDef) and node.name in {"_ema", "classify_phase_series"}]
runtime = {"pl": SimpleNamespace(DataFrame=Frame, Series=Series, Utf8=str)}
exec(compile(ast.Module(body=definitions, type_ignores=[]), "market_phase.py", "exec"), runtime)

start = date(2025, 1, 2)

def fixture(values):
    canonical = [{"tradingDate": str(start + timedelta(days=index)), "state": state,
                  **dict(zip(FIELDS, drivers))} for index, (drivers, state) in enumerate(values)]
    upstream = [{"date": row["tradingDate"], "state": row["state"],
                 **{name: row[key] for key, name in FIELDS.items()}} for row in canonical]
    phases = runtime["classify_phase_series"](Frame(upstream))["phase"].to_list()
    return {"input": canonical, "phases": phases}

blocks = [
    (6, (3, 14, 4, 0.10, 0.50), "range"),
    (6, (6, 36, 12, 0.27, 0.66), "lean_strong"),
    (7, (8, 75, 26, 0.38, 0.74), "strong"),
    (2, (8, 75, 26, 0.38, 0.74), "weak"),
    (7, (12, 260, 70, 0.65, 0.90), "strong"),
    (10, (6, 40, 8, 0.02, 0.45), "lean_weak"),
    (9, (5, 35, 9, 0.17, 0.63), "range"),
]
complete = fixture([(drivers, state) for count, drivers, state in blocks for _ in range(count)])
leading = fixture([
    ((8, 65, 25, None, 0.7), "strong"),
    ((8, 65, 25, None, 0.7), "strong"),
    ((8, 65, 25, 0.3, 0.7), "strong"),
    ((8, 65, 25, None, 0.7), "strong"),
])
if set(complete["phases"]) != {"ice", "ignite", "rally", "climax", "ebb", "repair"}:
    raise RuntimeError(f"Incomplete phase fixture: {set(complete['phases'])}")
print(json.dumps({"revision": REVISION, "complete": complete, "leading": leading}, ensure_ascii=False, indent=2))

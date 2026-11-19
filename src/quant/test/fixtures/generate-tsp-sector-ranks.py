"""Generate the pinned TSP dimension ranks with synthetic quotes and membership rows."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import market_overview_builder as overview


day = "2026-01-05"
stocks = [f"{600001 + i}.SH" for i in range(12)]
returns = [-0.02, 0, -0.04, 0.03, 0.09, 0.06, -0.07, 0.08, -0.08, 0.02, -0.05, 0.01]
quotes = [{"symbol": symbol, "name": f"Fixture {i}", "change_pct": returns[i], "amount": i * 100}
          for i, symbol in enumerate(stocks)]
repo = SimpleNamespace(store=SimpleNamespace(data_dir=Path(".")))
groupings = [
    [[0, 1], [3, 4], [4, 5], [6], [7, 9], [8, 10], [2, 11]],
    [[0, 1], [3, 4, 9], [5, 9], [2, 6], [4, 7], [8], [11]],
]
cases = []

for kind, grouping in zip(("industry", "concept"), groupings):
    config = SimpleNamespace(id=f"fixture-{kind}", fields=[SimpleNamespace(name=kind, label=kind)], symbol_map={}, code_map={})
    provider_rows, members = [], []
    for i, group in enumerate(grouping):
        for index in group:
            symbol, name = stocks[index], f"Group{i + 1}"
            raw_name = f"Parent-{name}-Example" if kind == "industry" else name
            provider_rows.append({"symbol": symbol, kind: raw_name})
            members.append({"groupId": f"{kind}-{i + 1}", "groupName": name, "symbol": symbol,
                            "effectiveFrom": day, "effectiveUntil": None, "knownOn": day})
    with (patch.object(overview, "ExtConfigStore") as store,
          patch.object(overview, "_read_ext_rows", return_value=provider_rows)):
        store.return_value.load_all.return_value = [config]
        expected = overview._dimension_rank(quotes, repo, kind, level=2 if kind == "industry" else None)
    cases.append({"kind": kind, "members": members, "expected": expected})

print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "date": day, "quotes": quotes, "cases": cases},
                 separators=(",", ":"), allow_nan=False))

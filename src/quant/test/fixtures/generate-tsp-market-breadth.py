"""Run with the pinned TSP backend on PYTHONPATH and Polars 1.44.1."""
from datetime import date
import json
from unittest.mock import patch

import polars as pl
from app.services import market_overview_builder as overview, preferences


trading_date = date(2026, 1, 5)
changes = [-0.07, -0.05, -0.03, -0.01, 0, 0.01, 0.03, 0.05, 0.08, 0.03, -0.03, 0.02, 0]
rows = []
for index, change in enumerate(changes):
    rows.append({
        "symbol": f"{600001 + index}.SH", "name": f"Fixture {index}", "close": 10,
        "change_pct": change, "volume": 0 if index in (2, len(changes) - 1) else (index + 1) * 100,
        "amount": index * 1000, "turnover_rate": index % 8, "vol_ratio_5d": index / 4,
        "ma5": 9 + index % 3, "ma20": 10, "ma60": 11 - index % 4,
        "high_60d": 10 if index % 5 == 0 else 12, "low_60d": 10 if index % 3 == 0 else 8,
        "signal_n_day_high": index == 9, "signal_n_day_low": index == 8,
    })

with (
    patch.object(overview, "ScreenerService") as service,
    patch.object(overview, "_index_quotes", return_value=[]),
    patch.object(overview, "_dimension_rank", return_value={"leading": [], "lagging": []}),
    patch.object(preferences, "get_emotion_score_config", return_value=None),
):
    service.return_value._load_enriched_for_date.return_value = pl.DataFrame(rows)
    result = overview.build_market_overview(None, as_of=trading_date)

expected = {key: result[key] for key in ("breadth", "amount", "distribution", "trend", "activity")}
for key in ("top_gainers", "top_losers", "turnover_leaders", "active_leaders"):
    expected[key] = [row["symbol"] for row in result[key]]

print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__,
                  "tradingDate": trading_date.isoformat(), "rows": rows, "expected": expected},
                 separators=(",", ":"), allow_nan=False))

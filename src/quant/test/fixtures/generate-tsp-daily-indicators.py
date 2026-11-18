"""Run with the pinned TSP backend environment to regenerate the synthetic fixture."""
from datetime import date, timedelta
import json
import math
import polars as pl
from app.indicators.pipeline import _ALL_INDICATOR_COLS, compute_indicators


fields = sorted(field for field in _ALL_INDICATOR_COLS if not field.startswith("_"))
cases = []
for name, count in (("mixed", 68), ("zero_range_and_volume", 33)):
    bars = []
    for i in range(count):
        mixed = name == "mixed"
        close = 20 + (i % 7) * 0.4 + i * 0.02 if mixed else 20
        width = 1 + (i % 4) * 0.3 if mixed else (0 if 3 <= i < 19 else 1)
        volume = 100 + (i % 5) * 20 if mixed or i >= 12 else 0
        bars.append({"date": (date(2024, 1, 1) + timedelta(days=i)).isoformat(),
                     "open": close, "high": close + width, "low": close - width,
                     "close": close, "volume": volume})
    frame = pl.DataFrame([{**bar, "symbol": "600000.SH"} for bar in bars])
    output = compute_indicators(frame, needed=set(fields)).select(fields)
    expected = [[None if v is not None and not math.isfinite(v) else v for v in row] for row in output.iter_rows()]
    cases.append({"name": name, "bars": bars, "expected": expected})

print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc",
                  "polars": pl.__version__, "fields": fields, "cases": cases},
                 separators=(",", ":"), allow_nan=False))

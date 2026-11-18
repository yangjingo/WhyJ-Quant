"""Regenerate using the pinned TSP backend environment and Polars 1.44.1."""
from datetime import date, timedelta
import json

import polars as pl
from app.indicators.levels import compute_levels
from app.indicators.pipeline import compute_indicators


def calculate(bars):
    if not bars:
        return compute_levels(pl.DataFrame())
    frame = pl.DataFrame([{"symbol": "600000.SH", **bar} for bar in bars])
    if "turnoverPct" in frame.columns:
        frame = frame.rename({"turnoverPct": "turnover_rate"})
    return compute_levels(compute_indicators(frame))


bars = []
for i in range(260):
    regime = 7 if i >= 256 else 3 if 195 <= i < 230 else 0
    close = 10 + i * 0.035 + i % 15 * 0.16 + regime
    bars.append({"date": (date(2024, 1, 1) + timedelta(days=i)).isoformat(),
                 "open": close - 0.03, "high": close + 0.22, "low": close - 0.18, "close": close,
                 "volume": 100 + i % 17 * 30, "turnoverPct": 0.7 + i % 13 / 11})

history = [{"count": n, "expected": calculate(bars[:n])}
           for n in (0, 1, 19, 20, 59, 60, 119, 120, 249, 250, 255, 260)]
no_turnover = calculate([{k: v for k, v in bar.items() if k != "turnoverPct"} for bar in bars])
partial_turnover = calculate([{**bar, "turnoverPct": None} if i % 3 == 0 else bar
                              for i, bar in enumerate(bars)])
single = []
for price in (0.125, 8.6, 10, 19.5, 20, 97.3, 100, 493.3, 500, 7643.2):
    bar = {"date": "2024-01-01", "open": price, "high": price, "low": price, "close": price, "volume": 0}
    single.append({"bar": bar, "expected": calculate([bar])})

print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__,
                  "bars": bars, "history": history, "noTurnover": no_turnover, "partialTurnover": partial_turnover,
                  "single": single}, ensure_ascii=False, separators=(",", ":"), allow_nan=False))

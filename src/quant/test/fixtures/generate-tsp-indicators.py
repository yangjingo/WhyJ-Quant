"""Regenerate using the pinned TSP checkout and its Polars environment.

Run from TSP backend: .venv/Scripts/python.exe <this file> > tsp-indicators.json
The output is synthetic and contains no market data.
"""
from datetime import date, timedelta
import json
import polars as pl
from app.indicators.pipeline import compute_indicators

cases = {}
for name in ("flat", "flat_zero_range", "rising", "falling", "mixed", "varying_range"):
    bars = []
    for i in range(32):
        close = {"flat": 20, "flat_zero_range": 20, "rising": 20 + i * 0.3, "falling": 20 - i * 0.3,
                 "mixed": 20 + (i % 7) * 0.4 + i * 0.02, "varying_range": 20}[name]
        width = 1 + i * 0.05 if name == "varying_range" else (0 if name == "flat_zero_range" else 1)
        bars.append({"date": (date(2024, 1, 1) + timedelta(days=i)).isoformat(), "open": close,
                     "high": close + width, "low": close - width, "close": close, "volume": 100 + i})
    df = pl.DataFrame([{**bar, "symbol": "600000.SH"} for bar in bars])
    out = compute_indicators(df, needed={"rsi_6", "rsi_14", "rsi_24", "atr_14"})
    cases[name] = {"bars": bars, "expected": out.select("rsi_6", "rsi_14", "rsi_24", "atr_14").to_dicts()}
print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__, "cases": cases}, indent=2, allow_nan=False))

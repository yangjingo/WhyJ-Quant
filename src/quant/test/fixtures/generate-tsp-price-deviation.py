"""Run with the pinned TSP backend on PYTHONPATH and Polars 1.44.1."""
from datetime import date, timedelta
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import polars as pl
from app.indicators import pipeline


stocks = {"600000.SH": "SH", "688001.SH": "STAR", "000001.SZ": "SZ", "300001.SZ": "GEM", "920001.BJ": "BJ"}
dates = [date(2026, 1, 5) + timedelta(days=i) for i in range(60)]
dates = [d for d in dates if d.weekday() < 5]


def series(symbols, base, step):
    return [{"symbol": symbol, "date": d, "close": base + j * 3 + i * step + (i % (j + 3)) * step}
            for j, symbol in enumerate(symbols) for i, d in enumerate(dates)]


stock = pl.DataFrame(series(stocks, 12, 0.1))
index = pl.DataFrame(series(sorted(pipeline.BENCHMARK_INDEX_SYMBOLS), 50, 0.16))
with TemporaryDirectory() as root:
    with patch.object(pipeline, "scan_daily_parquet", return_value=index.lazy()):
        output = pipeline.attach_deviation_columns(stock, Path(root)).sort(["symbol", "date"])

result = []
for symbol, board in stocks.items():
    preferred = pipeline._BENCHMARK_PREFERENCE[board][0]
    select = lambda frame, target: frame.filter(pl.col("symbol") == target)
    result.append({
        "symbol": symbol, "board": board, "candidates": pipeline._BENCHMARK_PREFERENCE[board],
        "stock": select(stock, symbol).select("date", "close").to_dicts(),
        "benchmark": {"symbol": preferred, "levels": select(index, preferred).select("date", "close").to_dicts()},
        "expected": select(output, symbol).select("deviate_3d", "deviate_10d", "deviate_30d").to_dicts(),
    })

print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__,
                  "dates": dates, "series": result}, separators=(",", ":"), allow_nan=False, default=str))

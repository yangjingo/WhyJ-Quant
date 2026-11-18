"""Run with the pinned TSP backend on PYTHONPATH and Polars 1.44.1."""
from datetime import datetime, timedelta
import json

import polars as pl
from app.strategy.custom_signals import apply_intraday_edges, build_intraday_expressions, intraday_column_name
from app.strategy.intraday_features import INTRADAY_FEATURES, build_feature_frame
from app.strategy.intraday_signals import INTRADAY_SIGNAL_LABELS, _legacy_builtin_definitions


features = list(INTRADAY_FEATURES)
signals = list(INTRADAY_SIGNAL_LABELS)
previous_closes = {"2026-01-05": 10, "2026-01-06": 11}
bars, expected = [], []

for day, previous_close in previous_closes.items():
    raw = []
    for i in range(132):
        afternoon = i >= 120
        offset = i - 120 if afternoon else i
        timestamp = datetime.fromisoformat(f"{day}T{'13:00' if afternoon else '09:30'}") + timedelta(minutes=offset)
        close = previous_close + [-0.50, 0.45, 0.15, -0.25, -0.35, 0.55][i % 6]
        volume = 2 + i % 9
        row = {"open": close - 0.025, "high": close + 0.15, "low": close - 0.10,
               "close": close, "volume": volume, "amount": (close + 0.01) * volume * 100}
        raw.append({"symbol": "600000.SH", "datetime": timestamp, **row})
        bars.append([day, timestamp.strftime("%H:%M"), row["open"], row["high"], row["low"],
                     close, volume * 100, row["amount"]])
    frame = build_feature_frame(pl.DataFrame(raw), prev_close={"600000.SH": previous_close})
    frame = apply_intraday_edges(frame, build_intraday_expressions(_legacy_builtin_definitions()))
    expected.extend([list(row) for row in frame.select(features + [intraday_column_name(key) for key in signals]).iter_rows()])

print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__,
                  "features": features, "signals": signals, "previousCloses": previous_closes,
                  "bars": bars, "expected": expected}, separators=(",", ":"), allow_nan=False))

"""Regenerate with the pinned TSP backend environment and Polars."""
from datetime import date, timedelta
import json
import math

import polars as pl
from app.indicators.pipeline import compute_indicators
from app.strategy.custom_signals import build_expressions
from app.strategy.signal_seeds import SEED_SIGNALS


bars = []
for i in range(180):
    shift = 7 if i in (61, 101) else -6 if i in (80, 140) else 0
    close = 20 + 0.016 * i + math.sin(i / 9) * (2 + i % 9 / 20) + shift
    opening = close - 0.2 if i % 13 in (0, 3, 5) else close + 0.1
    high, low = max(close, opening) + 0.3, min(close, opening) - 0.25
    upper = close if i % 13 == 0 else high if i % 13 == 1 else high + 0.4
    lower = close if i % 13 == 2 else low if i % 13 == 3 else low - 0.3
    bars.append({"date": (date(2024, 1, 1) + timedelta(days=i)).isoformat(),
                 "open": opening, "high": high, "low": low, "close": close,
                 "volume": 620 if i % 17 == 3 else 100 + i % 13,
                 "raw_close": close, "raw_high": high, "raw_low": low,
                 "limit_up_price": upper, "limit_down_price": lower})

frame = compute_indicators(pl.DataFrame([{"symbol": "600000.SH", **bar} for bar in bars]))
expressions = build_expressions(SEED_SIGNALS)
expected = frame.with_columns([expression.alias(name) for name, expression in expressions.items()]).to_dicts()


def available(condition, current):
    right = condition["right"]
    operands = [(condition["left"], condition["leftDays"])]
    if right.startswith("field:"):
        operands.append((right.removeprefix("field:"), condition["rightDays"]))
    for name, days in operands:
        if current < days:
            return False
        value = expected[current - days][name]
        if value is None or not math.isfinite(value):
            return False
    return True


rows = [[entry[rule["column"]] if all(available(condition, index) for condition in rule["conditions"]) else None
         for rule in SEED_SIGNALS] for index, entry in enumerate(expected)]
print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__,
                  "fields": [rule["column"] for rule in SEED_SIGNALS], "bars": bars, "rows": rows},
                 separators=(",", ":"), allow_nan=False))

"""Regenerate with the pinned TSP backend environment and Polars 1.44.1."""
from datetime import date, timedelta
import json
import math

import polars as pl
from app.backtest.fundamentals import FUNDAMENTAL_FACTORS, attach_fundamental_factors
from app.factors.registry import _CATALOG
from app.indicators.pipeline import compute_indicators
from app.strategy.scoring import materialize_scoring_columns


start = date(2024, 1, 1)
bars = []
for i in range(245):
    close = 20 + (i * 13 % 25) * 0.08 + i * 0.013
    opening = close + (i % 5 - 2) * 0.08
    volume = 100 + (i * 17 % 29) * 7 + i
    bars.append({"date": (start + timedelta(days=i)).isoformat(),
                 "open": opening, "high": max(opening, close) + 0.3 + i % 4 * 0.03,
                 "low": min(opening, close) - 0.2, "close": close, "volume": volume,
                 "amountCny": volume * 100 * (opening + close) / 2,
                 "turnoverPct": 0.4 + (i * 11 % 23) / 15,
                 "consecutiveLimitUps": i % 17 if i % 17 <= 3 else 0})

reports = [
    {"announcementDate": bars[0]["date"], "bps": 5, "roe": 10, "grossMargin": 20,
     "netMargin": 9, "revenueYoy": 11, "netIncomeYoy": 12, "debtRatio": 25},
    {"announcementDate": bars[150]["date"], "bps": -1, "roe": 0, "grossMargin": 19,
     "netMargin": -4, "revenueYoy": 2, "netIncomeYoy": -7, "debtRatio": 30},
]
symbol = "600000.SH"
frame = pl.DataFrame([{
    "date": date.fromisoformat(bar["date"]), "symbol": symbol,
    **{name: bar[name] for name in ("open", "high", "low", "close", "volume")},
    "amount": bar["amountCny"], "turnover_rate": bar["turnoverPct"],
    "consecutive_limit_ups": bar["consecutiveLimitUps"],
} for bar in bars])
fields = [spec.id for spec in _CATALOG]
frame = materialize_scoring_columns(compute_indicators(frame), fields)
snapshot = pl.DataFrame([{
    "symbol": symbol, "_announce": date.fromisoformat(report["announcementDate"]), "bps": report["bps"],
    "roe": report["roe"], "gross_margin": report["grossMargin"], "net_margin": report["netMargin"],
    "revenue_yoy": report["revenueYoy"], "net_income_yoy": report["netIncomeYoy"],
    "debt_to_asset_ratio": report["debtRatio"],
} for report in reports])
frame = attach_fundamental_factors(frame, snapshot, list(FUNDAMENTAL_FACTORS))

expected = [[None if v is not None and not math.isfinite(v) else v for v in row]
            for row in frame.select(fields).iter_rows()]
print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "polars": pl.__version__,
                  "fields": fields, "bars": bars, "reports": reports, "expected": expected},
                 separators=(",", ":"), allow_nan=False))

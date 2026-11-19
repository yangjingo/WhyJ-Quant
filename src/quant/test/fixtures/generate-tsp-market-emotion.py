"""Generate upstream sentiment scores from the pinned TSP implementation."""
import json
import random

from app.services.emotion_score import compute, DEFAULT_CONFIG


all_terms = {item["key"]: item for dimension in DEFAULT_CONFIG["dimensions"].values() for item in dimension["terms"]}


def to_upstream(config):
    if not config:
        return None
    return {**config, "dimensions": {key: {**dim, "terms": [{"key": name, **term}
            for name, term in dim.get("terms", {}).items()]} for key, dim in config.get("dimensions", {}).items()}}


middle = {key: (item["low"] + item["high"]) / 2 for key, item in all_terms.items()}
cases = [
    (middle, {}),
    ({**middle, "avg_index_pct": 2.5, "limit_up": 100, "seal_rate": 80, "up_pct": 90}, {}),
    ({"up_pct": 68, "avg_pct": None, "strong_down_pct": 12}, {}),
    (middle, {"dimensions": {"profit": {"weight": 3.6, "terms": {"up_pct": {"weight": 2.2}, "median_pct": {"weight": 0.75}}}},
              "thresholds": {"strong": 53, "warm": 72, "neutral": 31, "cold": 120}}),
    ({**middle, "avg_index_pct": 0.125}, {"dimensions": {"index": {"terms": {"avg_index_pct": {"low": 0, "high": 5}}}}}),
    ({**middle, "strong_down_pct": 3, "down_pct": 65}, {"dimensions": {key: {"weight": 0} for key in DEFAULT_CONFIG["dimensions"]}}),
    ({**middle, "down_pct": 28}, {"dimensions": {"resilience": {"weight": 3, "terms": {"strong_down_pct": {"weight": -1}}}}}),
]
rng = random.Random(385)
for i in range(40):
    metrics = {key: round(rng.uniform(item["low"], item["high"]), 5) for key, item in all_terms.items()}
    cases.append((metrics, {} if i % 2 else {"dimensions": {"money": {"weight": 2}, "profit": {"weight": 4}}}))

output = [{"metrics": metrics, "overrides": config, "expected": compute(metrics, to_upstream(config))} for metrics, config in cases]
print(json.dumps({"revision": "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc", "cases": output},
                 separators=(",", ":"), allow_nan=False))

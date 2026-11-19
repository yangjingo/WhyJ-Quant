"""Generate parity samples with a local copy of the pinned TSP regime builder."""
import ast
import json
import math
import random
import sys
from pathlib import Path

REVISION = "f9cb383c5918c6a88a412f3ce43d59fe81b94ccc"
ASSIGNMENTS = {"WEIGHTS", "STATE_STRONG", "STATE_LEAN_STRONG", "STATE_RANGE", "STATE_LEAN_WEAK"}
FUNCTIONS = {"_score", "_compute_subscores", "classify_state"}

parsed = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
definitions = [node for node in parsed.body if (
    isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in ASSIGNMENTS for target in node.targets)
) or isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
runtime = {"math": math}
exec(compile(ast.Module(body=definitions, type_ignores=[]), "regime_builder.py", "exec"), runtime)

def sample(metrics):
    upstream = {
        "up_pct": metrics["upFraction"] * 100,
        "avg_pct": metrics["averageFraction"],
        "median_pct": metrics["medianFraction"],
        "strong_diff_pct": metrics["strongDifferenceFraction"] * 100,
        "limit_up": metrics["limitUpCount"],
        "seal_rate": metrics["sealFraction"],
        "max_consecutive": metrics["maxStreak"],
        "strong_down_pct": metrics["strongDownFraction"] * 100,
        "index_pct": metrics["indexChangeFraction"],
        "above_ma20_pct": metrics["aboveMa20Fraction"],
    }
    state, score = runtime["classify_state"](upstream)
    subscores = runtime["_compute_subscores"](upstream)
    raw_score = subscores.pop("score")
    return {"metrics": metrics, "state": state, "score": score, "rawScore": raw_score, "dimensions": subscores}

rng = random.Random(431)
targets = {29, 30, 44, 45, 54, 55, 69, 70}
cases = []
rounding_targets = {0, 1}
for _ in range(10_000):
    out = sample({
        "upFraction": rng.randrange(10, 90) / 100,
        "averageFraction": rng.randrange(-35, 35) / 1000,
        "medianFraction": rng.randrange(-35, 35) / 1000,
        "strongDifferenceFraction": rng.randrange(-25, 25) / 100,
        "limitUpCount": rng.randrange(0, 150),
        "sealFraction": rng.randrange(0, 101) / 100,
        "maxStreak": rng.randrange(0, 15),
        "strongDownFraction": rng.randrange(0, 30) / 100,
        "indexChangeFraction": rng.randrange(-30, 30) / 1000,
        "aboveMa20Fraction": rng.randrange(0, 101) / 100,
    })
    if out["score"] in targets:
        cases.append(out)
        targets.remove(out["score"])
    raw = out["rawScore"]
    if raw % 1 == 0.5 and math.floor(raw) % 2 in rounding_targets:
        cases.append(out)
        rounding_targets.remove(math.floor(raw) % 2)
    if not targets and not rounding_targets:
        break
if targets or rounding_targets:
    raise RuntimeError(f"Missing thresholds {sorted(targets)} or ties {sorted(rounding_targets)}")

cases.append(sample({key: 0 for key in cases[0]["metrics"]}))
print(json.dumps({"revision": REVISION, "cases": cases}, ensure_ascii=False, indent=2))

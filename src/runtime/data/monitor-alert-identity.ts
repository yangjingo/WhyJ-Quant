import { createHash } from "node:crypto";
import type { TspMonitorAlertRule } from "../../quant/index.ts";

export function digestMonitorEvidence(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function digestMonitorRule(rule: TspMonitorAlertRule) {
  const { scope } = rule;
  const identity = scope.kind === "all" ? ["all"]
    : [scope.kind, [...scope.symbols].sort(), scope.kind === "watchlist_group" ? scope.membershipRevision : null];
  return digestMonitorEvidence([rule.id, rule.revision, rule.type, rule.assetType, rule.logic, rule.cooldownMs, rule.severity,
    identity, rule.conditions.map(condition => condition.op === "truth" ? [condition.field, condition.op]
      : [condition.field, condition.op, condition.value, condition.unit])]);
}

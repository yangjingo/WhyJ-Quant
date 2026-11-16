export type TspObservationTool = "get_recent_alerts" | "get_kline";
export interface TspObservation {
  readonly tool: TspObservationTool;
  readonly parameters: Readonly<Record<string, string | number>>;
  readonly retrievedAt: string;
  readonly sourceUrl: string;
  readonly status: "available" | "unavailable";
  readonly content: string | null;
  readonly sha256: string | null;
  readonly reason: string | null;
}
export interface TspObservations {
  readonly version: 1;
  readonly server: "tsp";
  readonly symbol: string;
  /** Configuration declarations, not proof of the gateway token's effective permissions. */
  readonly configuredScopes: readonly ["read:market", "read:analysis"];
  readonly observations: readonly TspObservation[];
}

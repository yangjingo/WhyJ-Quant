import { validateThesisReview } from "../../research/thesis-review.ts";
import { artifactReference, loadArtifactSnapshot } from "../../storage/index.ts";
import type { ArtifactRequest, SessionSnapshot } from "../../types/workbench.ts";
import type { ThesisArchive, ThesisBaselineArchive } from "../../types/thesis-archive.ts";
import type { ThesisReviewInput } from "../../types/thesis-review.ts";
import type { ThesisView } from "../../types/thesis-workbench.ts";
import { WorkbenchError } from "../workbench/errors.ts";

const unavailable = () => new WorkbenchError("THESIS_UNAVAILABLE", "基线或复核的固定版本无法读取或验证，原记录已保留。", 409);

export function fixed(ref: ArtifactRequest, snapshot: SessionSnapshot) {
  if (ref.workspaceId !== snapshot.identity.workspaceId || ref.sessionId !== snapshot.identity.sessionId) throw unavailable();
  const artifact = snapshot.output.artifacts.find(item => item.id === ref.artifactId && item.sha256 === ref.sha256);
  if (!artifact) throw unavailable();
  const saved = loadArtifactSnapshot(`${artifact.id}@${artifact.sha256}`);
  if (!saved || artifactReference(saved.meta) !== `${artifact.id}@${artifact.sha256}`) throw unavailable();
  return { artifact, saved };
}
export function owned(saved: NonNullable<ReturnType<typeof loadArtifactSnapshot>>, snapshot: SessionSnapshot): ThesisArchive {
  const record = saved.privateResearch;
  if (!record || record.workspaceId !== snapshot.identity.workspaceId || record.sessionId !== snapshot.identity.sessionId) throw unavailable();
  return record;
}
export function baselineInput(record: ThesisBaselineArchive, artifactId: string, revision: string): ThesisReviewInput["baseline"] {
  return { artifactId, revision, ...record.assumption };
}
export function validateBaseline(record: ThesisBaselineArchive) {
  if (record.assumption?.asOf !== record.recordedAt) throw unavailable();
  const input = validateThesisReview({ version: 1, id: record.requestId, groupId: record.groupId, symbol: record.symbol, cutoff: record.recordedAt,
    baseline: baselineInput(record, record.source.artifactId, record.source.revision), event: { id: "setup", kind: "wording", occurredAt: record.recordedAt, sourceUrl: "https://example.invalid/manual-baseline", summary: "Explicit baseline setup" }, evidence: [], parameters: {}, decision: null });
  return { ...record, assumption: { asOf: input.baseline.asOf, assumptionId: input.baseline.assumptionId, statement: input.baseline.statement, metric: input.baseline.metric, threshold: input.baseline.threshold } };
}

/** Baseline validation is shared by manual reviews and optional source observation reads. */
export function readThesisBaseline(ref: ArtifactRequest, snapshot: SessionSnapshot): Extract<ThesisView, { kind: "baseline" }> {
  try {
    const { artifact, saved } = fixed(ref, snapshot), record = owned(saved, snapshot);
    if (record.kind !== "baseline") throw unavailable();
    const value = validateBaseline(record), source = { workspaceId: ref.workspaceId, sessionId: ref.sessionId, artifactId: value.source.artifactId, sha256: value.source.revision };
    fixed(source, snapshot);
    return { kind: "baseline", artifact, recordedAt: value.recordedAt, source, groupId: value.groupId, symbol: value.symbol, assumption: value.assumption };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw unavailable(); }
}

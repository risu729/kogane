// The SQL the change lifecycle owns. Two rules hold everywhere here:
//
// 1. Expected revisions are never verified by a preceding SELECT alone. The
//    expression below is a condition of the *writing* statement, inside the
//    same D1 batch, so a revision that moved between plan and commit writes
//    nothing at all (addendum 10 §5).
// 2. A subject reference is a typed string, not a table name. The prefix
//    decides which table answers "what revision is this subject at now".
import type { ChangeKind, ChangePayload, ExpectedRevisions } from "../command/contract.ts";
import type {
  IdentityAssignPayload,
  IdentityReleasePayload,
  RelationPayload,
} from "../command/contract.ts";

export function identitySubjectRef(subject: "account" | "instrument", referenceId: string): string {
  return `${subject === "account" ? "account_mapping" : "instrument_mapping"}:${referenceId}`;
}

export function relationSubjectRef(payload: RelationPayload): string {
  return `relation:${payload.relationKind}|${payload.fromRef}|${payload.toRef}`;
}

/** The one subject every change kind of this lifecycle acts on. */
export function subjectRefOf(kind: ChangeKind, payload: ChangePayload): string {
  if (kind === "identity.assign" || kind === "identity.release-override")
    return identitySubjectRef(
      (payload as IdentityReleasePayload).subject,
      (payload as IdentityReleasePayload).referenceId,
    );
  return relationSubjectRef(payload as RelationPayload);
}

export function assignPayload(payload: ChangePayload): IdentityAssignPayload {
  return payload as IdentityAssignPayload;
}
export function releasePayload(payload: ChangePayload): IdentityReleasePayload {
  return payload as IdentityReleasePayload;
}
export function relationPayload(payload: ChangePayload): RelationPayload {
  return payload as RelationPayload;
}

// The SQL fragments themselves moved to packages/storage-d1 (unified plan
// U05): the revision guard is CORE state, and the App and the Processor must
// state it once. Re-exported here so the lifecycle keeps its import path.
export {
  CURRENT_REVISIONS_SQL,
  currentRevisionsSql,
  expectedRevisionsSql,
  type RevisionRow,
} from "../../../storage-d1/src/core/operations.ts";

import type { RevisionRow } from "../../../storage-d1/src/core/operations.ts";

export function revisionsFrom(rows: readonly RevisionRow[]): ExpectedRevisions {
  const revisions: ExpectedRevisions = {};
  for (const row of rows) revisions[row.subject_ref] = row.revision;
  return revisions;
}

/** Canonical JSON of an expected-revision map: keys sorted, values integers. */
export function expectedRevisionsJson(revisions: ExpectedRevisions): string {
  const sorted: ExpectedRevisions = {};
  for (const key of Object.keys(revisions).sort()) sorted[key] = revisions[key]!;
  return JSON.stringify(sorted);
}

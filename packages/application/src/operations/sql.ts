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

/**
 * "Every subject in this JSON object is still at the revision the plan
 * recorded." A mapping subject answers with its highest mapping revision; a
 * relation subject with the number of relation rows the triple already has.
 * A subject with no history answers 0, so a first-ever assignment plans
 * against revision 0 and conflicts if someone else got there first.
 *
 * `param` is the placeholder the caller binds `expected_revisions_json` to, so
 * this fragment can be spliced into a numbered statement without renumbering.
 */
const REVISION_OF = `coalesce(
 (SELECT max(m.revision) FROM account_mappings m WHERE 'account_mapping:'||m.source_account_id=e.key),
 (SELECT max(m.revision) FROM instrument_mappings m WHERE 'instrument_mapping:'||m.identifier_id=e.key),
 CASE WHEN e.key LIKE 'relation:%' THEN
  (SELECT count(*) FROM entity_relations r WHERE 'relation:'||r.kind||'|'||r.from_ref||'|'||r.to_ref=e.key) END,
 0)`;

export function expectedRevisionsSql(param: string): string {
  return `NOT EXISTS(SELECT 1 FROM json_each(${param}) e WHERE e.value<>${REVISION_OF})`;
}

/** The same check as a read, for planning and for the staleness display. */
export function currentRevisionsSql(param: string): string {
  return `SELECT e.key AS subject_ref,${REVISION_OF} AS revision FROM json_each(${param}) e`;
}

export const CURRENT_REVISIONS_SQL = currentRevisionsSql("?");

export interface RevisionRow {
  subject_ref: string;
  revision: number;
}

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

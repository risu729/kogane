// Operation records: the CORE tables the change lifecycle writes
// (`change_plans`, `approvals`, `operation_receipts`, `decision_revisions`,
// `decision_outbox`; migrations 0029 and 0031) and the revision expression
// every commit re-verifies.
//
// Two rules hold here and in `../atomic/decision-commit.ts`:
//
// 1. Expected revisions are never verified by a preceding SELECT alone. The
//    expression below is a condition of the *writing* statement, inside the
//    same D1 batch, so a revision that moved between plan and commit writes
//    nothing at all (unified plan 09 §2, addendum 10 §5; G2-14, G2-15).
// 2. A subject reference is a typed string, not a table name. The prefix
//    decides which table answers "what revision is this subject at now".
//
// Moved here from `packages/application/src/operations/sql.ts` by U05 so the
// App and the Processor state the guard once. The SQL text is unchanged.
import type { D1Like } from "../d1.ts";

/** One statement of a guarded batch: text plus its positional binds. */
export interface SqlWrite {
  sql: string;
  binds: readonly unknown[];
}

/**
 * "Every subject in this JSON object is still at the revision the plan
 * recorded." A mapping subject answers with its highest mapping revision; a
 * relation subject with the number of relation rows the triple already has.
 * A subject with no history answers 0, so a first-ever assignment plans
 * against revision 0 and conflicts if someone else got there first.
 */
const REVISION_OF = `coalesce(
 (SELECT max(m.revision) FROM account_mappings m WHERE 'account_mapping:'||m.source_account_id=e.key),
 (SELECT max(m.revision) FROM instrument_mappings m WHERE 'instrument_mapping:'||m.identifier_id=e.key),
 CASE WHEN e.key LIKE 'relation:%' THEN
  (SELECT count(*) FROM entity_relations r WHERE 'relation:'||r.kind||'|'||r.from_ref||'|'||r.to_ref=e.key) END,
 0)`;

/**
 * The in-batch guard. `param` is the placeholder the caller binds
 * `expected_revisions_json` to, so this fragment can be spliced into a
 * numbered statement without renumbering.
 */
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

/** Current revisions of the named subjects, read straight off a D1 binding. */
export async function readCurrentRevisions(
  db: D1Like,
  expectedRevisionsJson: string,
): Promise<RevisionRow[]> {
  const result = await db
    .prepare(CURRENT_REVISIONS_SQL)
    .bind(expectedRevisionsJson)
    .all<RevisionRow>();
  return result.results;
}

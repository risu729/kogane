// The second statement of `publishBatch` (src/atomic/publication.ts),
// "supersede older successes", exactly as it shipped before it carried the
// live-lease fence the batch's other statements carry. Frozen as text so the
// tests can prove the fenced statement answers exactly as this one did for a
// writer that holds the lease, and see this one write for a writer that does
// not. Verbatim, binds included; never edit it by hand, and never import it
// outside tests.
import type { D1Like, D1StatementLike } from "../src/d1.ts";

export function legacySupersedeOlderSuccesses(
  db: D1Like,
  parseId: number,
  artifactId: number,
  parserName: string,
): D1StatementLike {
  return db
    .prepare(
      `UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE fetch_artifact_id=? AND parser_name=? AND id<>? AND status='ok' AND superseded_by_parse_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM parse_run_candidates c WHERE c.parse_run_id=parse_runs.id) AND EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=? AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL)`, // gate:writer
    )
    .bind(parseId, artifactId, parserName, parseId, parseId);
}

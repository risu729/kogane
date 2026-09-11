// The Drizzle half of `../core/artifacts.ts` (unified plan 09 §2, pilot).
//
// Only the catalogue read is here. Writing an artifact is one D1 batch whose
// child statements select their parent by `(run, artifact_key)` so that
// nothing is recorded unless the artifact row was; that shape is the guard,
// and it stays native SQL.
import { asc, eq } from "drizzle-orm";
import { coreDrizzle } from "./client.ts";
import { fetchArtifacts } from "./schema/core.ts";
import type { D1Like } from "../d1.ts";

/**
 * The run's whole catalogue, in the order a seal inventory must declare it.
 * `artifact_key` is a TEXT column with no `COLLATE` clause, so its ordering
 * is SQLite's BINARY collation — which is what the native statement spells
 * out as `ORDER BY artifact_key COLLATE BINARY`. The equivalence test
 * compares the two orders on keys that differ only in case, where a
 * case-insensitive collation would disagree.
 */
export async function readRunCatalogue(
  db: D1Like,
  runId: number,
): Promise<{ artifact_key: string; sha256: string; descriptor_sha256: string }[]> {
  return await coreDrizzle(db)
    .select({
      artifact_key: fetchArtifacts.artifactKey,
      sha256: fetchArtifacts.sha256,
      descriptor_sha256: fetchArtifacts.descriptorSha256,
    })
    .from(fetchArtifacts)
    .where(eq(fetchArtifacts.fetchRunId, runId))
    .orderBy(asc(fetchArtifacts.artifactKey));
}

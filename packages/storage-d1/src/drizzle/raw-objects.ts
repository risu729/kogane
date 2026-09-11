// The Drizzle half of `../core/raw-objects.ts` (unified plan 09 §2, pilot).
//
// Every function here answers exactly what its native twin answers — same
// column names, same order, same NULLs — so a call site switches by changing
// one import. `test/drizzle-equivalence.test.ts` runs both against the same
// synthetic rows and compares the results and the query plans; nothing is
// switched over until that test passes for the function in question.
//
// The conditional insert `insertRawObjectIfAbsent` is deliberately *not*
// here: `INSERT ... SELECT ... WHERE NOT EXISTS` is a guard, and a guard
// belongs to the writing statement.
import { and, desc, eq, gte } from "drizzle-orm";
import { coreDrizzle } from "./client.ts";
import { rawObjectVerificationEvents, rawObjects } from "./schema/core.ts";
import type { D1Like } from "../d1.ts";
import type { VerificationEvent } from "../core/raw-objects.ts";

/** The recorded object, for the read-back comparison after an insert. */
export async function readRawObjectRecord(
  db: D1Like,
  sha256: string,
): Promise<{ sha256: string; byte_size: number; blob_key: string } | null> {
  const rows = await coreDrizzle(db)
    .select({
      sha256: rawObjects.sha256,
      byte_size: rawObjects.byteSize,
      blob_key: rawObjects.blobKey,
    })
    .from(rawObjects)
    .where(eq(rawObjects.sha256, sha256))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The most recent verification this client made inside the reuse window.
 * The ordering is the whole answer — "most recent" — so it is asserted
 * against the native statement rather than assumed.
 */
export async function readRecentVerification(
  db: D1Like,
  sha256: string,
  clientId: string,
  since: number,
): Promise<{ id: number; result: string } | null> {
  const rows = await coreDrizzle(db)
    .select({
      id: rawObjectVerificationEvents.id,
      result: rawObjectVerificationEvents.result,
    })
    .from(rawObjectVerificationEvents)
    .where(
      and(
        eq(rawObjectVerificationEvents.sha256, sha256),
        eq(rawObjectVerificationEvents.checkedByClientId, clientId),
        gte(rawObjectVerificationEvents.checkedAtMs, since),
      ),
    )
    .orderBy(desc(rawObjectVerificationEvents.checkedAtMs), desc(rawObjectVerificationEvents.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Appends the verification outcome and reports the row id. The table is
 * append-only by trigger and its CHECK constraints decide which measurements
 * a result may carry; neither is restated here, because both are enforced by
 * the database for an ORM statement exactly as for a native one (G2-16).
 */
export async function insertVerificationEvent(
  db: D1Like,
  event: VerificationEvent,
): Promise<{ id: number } | null> {
  const rows = await coreDrizzle(db)
    .insert(rawObjectVerificationEvents)
    .values({
      sha256: event.sha256,
      checkedAtMs: event.now,
      result: event.result,
      observedSize: event.observedSize,
      observedSha256: event.observedSha256,
      detailCode: event.detailCode,
      checkedByClientId: event.clientId,
      recordedAtMs: event.now,
    })
    .returning({ id: rawObjectVerificationEvents.id });
  return rows[0] ?? null;
}

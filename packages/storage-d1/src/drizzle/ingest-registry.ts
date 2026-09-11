// The Drizzle half of `../core/ingest-registry.ts` (unified plan 09 §2, pilot).
//
// `active` is a `0`/`1` column read through the boolean codec, so the filter
// below compares against the two values the schema allows rather than against
// whatever JavaScript thinks is truthy (`../columns.ts`).
import { and, eq } from "drizzle-orm";
import { coreDrizzle } from "./client.ts";
import { fetchRuns, ingestClients } from "./schema/core.ts";
import type { D1Like } from "../d1.ts";
import type { FetchRunRow } from "../core/ingest-registry.ts";

/** Whether the client id exists and is active. Revocation is a row, not a key. */
export async function ingestClientActive(db: D1Like, clientId: string): Promise<boolean> {
  const rows = await coreDrizzle(db)
    .select({ id: ingestClients.id })
    .from(ingestClients)
    .where(and(eq(ingestClients.id, clientId), eq(ingestClients.active, true)))
    .limit(1);
  return rows.length > 0;
}

/** The run a request names, with the route pair the caller must be allowed on. */
export async function readFetchRun(db: D1Like, runId: number): Promise<FetchRunRow | null> {
  const rows = await coreDrizzle(db)
    .select({
      id: fetchRuns.id,
      producer_id: fetchRuns.producerId,
      source_id: fetchRuns.sourceId,
    })
    .from(fetchRuns)
    .where(eq(fetchRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

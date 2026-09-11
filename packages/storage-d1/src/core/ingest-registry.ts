// The ingest registry: which client may record for which producer and source
// (migrations 0002, 0003). Authentication itself is the adapter's job — the
// bearer token never reaches this package — but "is this client still active"
// and "is this route still active" are CORE facts, and both the legacy ingest
// Worker and the Processor must answer them from the same rows.
//
// Extracted from `services/raw-evidence/src/http.ts` by U05; SQL unchanged.
import type { D1Like } from "../d1.ts";

export interface FetchRunRow {
  id: number;
  producer_id: string;
  source_id: string;
}

/** Whether the client id exists and is active. Revocation is a row, not a key. */
export async function ingestClientActive(db: D1Like, clientId: string): Promise<boolean> {
  const active = await db
    .prepare("SELECT 1 AS ok FROM ingest_clients WHERE id = ? AND active = 1")
    .bind(clientId)
    .first<{ ok: number }>();
  return active !== null;
}

/** Whether this client may record for this (producer, source) pair right now. */
export async function ingestRouteActive(
  db: D1Like,
  clientId: string,
  producerId: string,
  sourceId: string,
): Promise<boolean> {
  const route = await db
    .prepare(
      `
    SELECT 1 AS ok FROM active_ingest_routes
    WHERE ingest_client_id = ? AND producer_id = ? AND source_id = ?
  `,
    )
    .bind(clientId, producerId, sourceId)
    .first<{ ok: number }>();
  return route !== null;
}

/** The run a request names, with the route pair the caller must be allowed on. */
export async function readFetchRun(db: D1Like, runId: number): Promise<FetchRunRow | null> {
  return await db
    .prepare(
      `
    SELECT id, producer_id, source_id FROM fetch_runs WHERE id = ?
  `,
    )
    .bind(runId)
    .first<FetchRunRow>();
}

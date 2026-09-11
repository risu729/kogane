// Who may record what. Authentication — proving the caller holds a client's
// secret — stays in the adapter, because the credential shape belongs to the
// transport. Authorization is a CORE fact and lives here, so the Processor
// registering a run directly makes exactly the checks the legacy HTTP path
// makes (unified plan 02 §3).
import {
  ingestRouteActive,
  type FetchRunRow,
} from "../../../storage-d1/src/core/ingest-registry.ts";
// Two of the three reads below are the Drizzle pilot's (unified plan 09 §2,
// decision D11): single-table lookups whose rows, ordering and query plan the
// equivalence test proves identical to the native statements they replaced
// (packages/storage-d1/test/drizzle-equivalence.test.ts, G2-17). The route
// check stays native: `active_ingest_routes` is a view.
import {
  ingestClientActive,
  readFetchRun,
} from "../../../storage-d1/src/drizzle/ingest-registry.ts";
import { IngestError, type IngestEnv } from "./contract.ts";

/** A client whose row was deactivated cannot record, whatever key it holds. */
export async function requireActiveClient(env: IngestEnv, clientId: string): Promise<void> {
  if (!(await ingestClientActive(env.DB, clientId)))
    throw new IngestError(403, "inactive_ingest_client");
}

/** The route is checked per request, never cached: revocation takes effect now. */
export async function requireRoute(
  env: IngestEnv,
  clientId: string,
  producerId: string,
  sourceId: string,
): Promise<void> {
  if (!(await ingestRouteActive(env.DB, clientId, producerId, sourceId)))
    throw new IngestError(403, "inactive_ingest_route");
}

/** The run this request names, once the caller is allowed on its route. */
export async function loadRun(
  env: IngestEnv,
  clientId: string,
  runId: number,
): Promise<FetchRunRow> {
  const run = await readFetchRun(env.DB, runId);
  if (!run) throw new IngestError(404, "run_not_found");
  await requireRoute(env, clientId, run.producer_id, run.source_id);
  return run;
}

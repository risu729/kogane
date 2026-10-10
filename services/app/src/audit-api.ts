// `GET /api/v2/audit`: the operator's read of the common audit record (ADR
// 0064, "Reading"; docs/audit-log.md).
//
// The whole store, newest first, 50 records a page, filtered by closed values
// only (operation, path, principal kind, result, a UTC day range). The filter
// is in the SQL `WHERE` before the `LIMIT`, no total is computed, and the
// cursor binds the filters it was issued under. Reading the log is itself a
// page load and is not recorded. The agents' read (`audit.read`, scoped by
// source) is a later slice; no agent route serves this.
import {
  auditPageFilters,
  d1CommandStore,
  principalCan,
  readAuditPage,
} from "../../../packages/application/src/index";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export const AUDIT_PATH = "/api/v2/audit";
const KEYS = ["operation", "path", "principalKind", "result", "from", "to", "cursor"];

export async function auditApi(
  env: Env,
  url: URL,
  /** The subject `authenticate` proved; never a body or header claim. */
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== AUDIT_PATH) return null;
  // The operator only: who did what is the operator's record.
  if (!principalCan(principalFor(env, subject), "interpretation.accept"))
    throw new HttpError(403, "operator_required");
  const values: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    if (!KEYS.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new HttpError(400, "invalid_query");
    values[key] = url.searchParams.get(key)!;
  }
  const { cursor = null, ...rest } = values;
  const filters = auditPageFilters(rest);
  if (filters === null) throw new HttpError(400, "invalid_query");
  const page = await readAuditPage(d1CommandStore(env.DB), filters, cursor);
  if (!page.ok) throw new HttpError(page.code === "stale_context" ? 409 : 400, page.code);
  return json({
    schemaVersion: "kogane-audit-page-v1",
    records: page.records,
    cursor: page.cursor,
  });
}

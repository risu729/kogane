import type { CommandStore } from "../command/contract.ts";
import { type Grant, grantAllows } from "../grants.ts";
import { type AuditRow, AUDIT_COLUMNS } from "./record.ts";
import {
  type AuditPageFilters,
  type AuditRecordView,
  type AuditReadPerimeter,
  readAuditPage,
  auditRecordView,
} from "./store.ts";
import { AUDIT_ID } from "./vocabulary.ts";

type Refusal = "unauthorized" | "evidence_restricted" | "invalid_query" | "stale_context";
function perimeter(grant: Grant): AuditReadPerimeter | null {
  if (!grantAllows(grant, "audit.read") || grant.scopes.accounts !== "*") return null;
  return {
    sources: grant.scopes.sources,
    scheduleSources: grant.scopes.scheduleSources ?? [],
    unscoped: grant.scopes.sources === "*" && grant.scopes.scheduleSources === "*",
  };
}
async function pseudonym(subject: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return (
    "subj_" +
    Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16)
  );
}
async function redact(row: AuditRecordView, grant: Grant): Promise<AuditRecordView> {
  const own = grant.principal.startsWith("mcp-client:")
    ? grant.principal.slice(11)
    : grant.principal;
  if (row.subject === null || row.subject === own) return row;
  const subject = await pseudonym(row.subject);
  return {
    ...row,
    subject,
    principal: row.principal.startsWith("mcp-client:") ? `mcp-client:${subject}` : subject,
  };
}
export async function readAuditForGrant(input: {
  store: CommandStore;
  grant: Grant;
  filters: AuditPageFilters;
  cursor: string | null;
}): Promise<
  { ok: true; records: AuditRecordView[]; cursor: string | null } | { ok: false; code: Refusal }
> {
  const p = perimeter(input.grant);
  if (!p)
    return {
      ok: false,
      code: grantAllows(input.grant, "audit.read") ? "evidence_restricted" : "unauthorized",
    };
  const result = await readAuditPage(
    input.store,
    input.filters,
    input.cursor,
    Math.min(50, input.grant.budget.maxRows),
    p,
  );
  if (!result.ok) return result;
  return {
    ...result,
    records: await Promise.all(result.records.map((r) => redact(r, input.grant))),
  };
}
export async function readAuditRecordForGrant(input: {
  store: CommandStore;
  grant: Grant;
  auditId: unknown;
}): Promise<{ ok: true; record: AuditRecordView } | { ok: false; code: Refusal }> {
  const p = perimeter(input.grant);
  if (!p)
    return {
      ok: false,
      code: grantAllows(input.grant, "audit.read") ? "evidence_restricted" : "unauthorized",
    };
  if (typeof input.auditId !== "string" || !AUDIT_ID.test(input.auditId))
    return { ok: false, code: "invalid_query" };
  const clauses: string[] = [],
    binds: unknown[] = [input.auditId];
  for (const [namespace, sources] of [
    ["core-source", p.sources],
    ["schedule-source", p.scheduleSources],
  ] as const) {
    if (sources === "*") {
      clauses.push("(scope_namespace=?)");
      binds.push(namespace);
    } else if (sources.length) {
      clauses.push("(scope_namespace=? AND scope_source IN (SELECT value FROM json_each(?)))");
      binds.push(namespace, JSON.stringify(sources));
    }
  }
  if (p.unscoped) clauses.push("scope_namespace IS NULL");
  const row = await input.store.first<AuditRow>(
    `SELECT ${AUDIT_COLUMNS.join(",")} FROM audit_records WHERE audit_id=? AND (${clauses.join(" OR ") || "0"})`,
    binds,
  );
  if (!row) return { ok: false, code: "evidence_restricted" };
  return { ok: true, record: await redact(auditRecordView(row), input.grant) };
}

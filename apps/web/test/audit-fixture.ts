// A synthetic audit store for the 監査ログ page's tests: the real CORE schema
// (bun:sqlite with every migration), records built by the real builder, and
// pages read by the real `readAuditPage` with the server's own filter parser.
// Every subject, source, reference and code here is synthetic.
import type { Database } from "bun:sqlite";
import {
  auditPageFilters,
  buildAuditRecord,
  readAuditPage,
  type AuditActor,
  type AuditFacts,
  type AuditRow,
} from "../../../packages/application/src/index.ts";
import { auditInsertWrite } from "../../../packages/application/src/audit/record.ts";
import {
  migratedDatabase,
  sqliteCommandStore,
} from "../../../packages/application/test/sqlite-store.ts";

const OPERATOR = "operator@synthetic.test";
const AGENT = "agent@synthetic.test";
const HEX = (digit: string) => digit.repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const auditId = (n: number) => `aud_${uuid(n)}`;

const OPERATOR_UI: Omit<AuditActor, "correlationId"> = {
  path: "ui",
  subject: OPERATOR,
  principal: OPERATOR,
  principalKind: "human",
};
const AGENT_HTTP: Omit<AuditActor, "correlationId"> = {
  path: "agent-http",
  subject: AGENT,
  principal: AGENT,
  principalKind: "agent",
};
const AGENT_MCP: Omit<AuditActor, "correlationId"> = {
  path: "mcp",
  subject: AGENT,
  principal: `mcp-client:${AGENT}`,
  principalKind: "agent",
};
const DELEGATED: Omit<AuditActor, "correlationId"> = {
  ...AGENT_MCP,
  principalKind: "delegated",
  delegationRef: `dlg_${HEX("d")}`,
};

/** The distinct records, newest last; each kind of diff and pairing appears once. */
const SPECIAL: [Omit<AuditActor, "correlationId">, AuditFacts][] = [
  [
    OPERATOR_UI,
    {
      operation: "command.commit",
      riskClass: "R2",
      targetRef: `plan:${HEX("a")}`,
      result: "applied",
      idempotencyKey: "synthetic-commit-1",
      payloadDigest: HEX("b"),
      refs: [`approval:ap_${HEX("c")}`, "operation:synthetic-commit-1"],
      diff: {
        kind: "decision",
        decisionRevisions: 2,
        commitSeq: null,
        counts: { targets: 2, relationsBefore: 0, relationsAfter: 1 },
      },
    },
  ],
  [
    OPERATOR_UI,
    {
      operation: "schedules.job.update",
      riskClass: "R2",
      scope: { namespace: "schedule-source", source: "synthetic-bank" },
      targetRef: "schedule:synthetic-bank",
      result: "applied",
      refs: ["schedule:synthetic-bank@4"],
      diff: { kind: "revision", from: 3, to: 4, fields: ["enabled", "pattern"] },
    },
  ],
  [
    OPERATOR_UI,
    {
      operation: "ops.collection.request",
      riskClass: "R2",
      scope: { namespace: "core-source", source: "synthetic-bank" },
      targetRef: `op_${HEX("e")}`,
      result: "accepted",
      idempotencyKey: "synthetic-collection-1",
      diff: { kind: "request", status: "accepted" },
    },
  ],
  [
    AGENT_MCP,
    {
      operation: "mcp.request",
      riskClass: "R0",
      result: "refused",
      resultCode: "actor_not_supported",
      diff: { kind: "none" },
    },
  ],
  [
    OPERATOR_UI,
    {
      operation: "command.plan",
      riskClass: "R1",
      result: "failed",
      resultCode: "upstream_unavailable",
      diff: { kind: "none" },
    },
  ],
  [
    OPERATOR_UI,
    {
      operation: "schedules.lease.release",
      riskClass: "R3",
      scope: { namespace: "schedule-source", source: "synthetic-bank" },
      targetRef: "collection-lease:synthetic-bank",
      result: "applied",
      diff: { kind: "release", released: true },
    },
  ],
  [
    AGENT_HTTP,
    {
      operation: "audit.overflow",
      riskClass: "R0",
      result: "overflow",
      diff: { kind: "overflow", of: "read", count: 37, cap: 2000 },
    },
  ],
  [
    OPERATOR_UI,
    {
      operation: "command.plan",
      riskClass: "R1",
      targetRef: `plan:${HEX("a")}`,
      result: "replayed",
      reasonCode: "same-payload",
      diff: { kind: "none" },
    },
  ],
];

/** Readers on the first day, then the distinct records, then a preparation and its confirmation. */
export const FILLER_READS = 60;

export interface AuditFixture {
  db: Database;
  rows: AuditRow[];
  /** What the route answers for a query string: `{status, body}` exactly as `services/app` maps it. */
  answer(search: URLSearchParams): Promise<{ status: number; body: unknown }>;
}

export async function auditFixture(): Promise<AuditFixture> {
  const db = migratedDatabase();
  const store = sqliteCommandStore(db);
  const rows: AuditRow[] = [];
  let n = 0;
  const at = (day: string, second: number) =>
    new Date(Date.parse(`${day}T09:00:00.000Z`) + second * 1000).toISOString();
  const add = (actor: Omit<AuditActor, "correlationId">, facts: AuditFacts, recordedAt: string) => {
    n += 1;
    rows.push(
      buildAuditRecord({ ...actor, correlationId: uuid(n) }, facts, recordedAt, auditId(n)),
    );
    return auditId(n);
  };
  for (let index = 0; index < FILLER_READS; index++)
    add(
      AGENT_HTTP,
      {
        operation: "financial.query",
        riskClass: "R0",
        result: "read",
        diff: { kind: "read", rows: index, truncated: index % 7 === 0 },
      },
      at("2026-10-08", index),
    );
  SPECIAL.forEach(([actor, facts], index) => add(actor, facts, at("2026-10-09", index)));
  const preparedAt = at("2026-10-09", 100);
  const prepared = add(
    DELEGATED,
    {
      operation: "schedules.maintenance.update",
      riskClass: "R2",
      step: "prepare",
      scope: { namespace: "schedule-source", source: "synthetic-bank" },
      targetRef: "maintenance-rule:synthetic-bank",
      result: "prepared",
      idempotencyKey: "synthetic-maintenance-1",
      payloadDigest: HEX("f"),
      confirmationDigest: `cfm_${HEX("9")}`,
      confirmExpiresAt: new Date(Date.parse(preparedAt) + 300_000).toISOString(),
      diff: { kind: "none" },
    },
    preparedAt,
  );
  add(
    DELEGATED,
    {
      operation: "schedules.maintenance.update",
      riskClass: "R2",
      step: "confirm",
      confirmsAuditId: prepared,
      scope: { namespace: "schedule-source", source: "synthetic-bank" },
      targetRef: "maintenance-rule:synthetic-bank",
      result: "applied",
      reasonCode: "operator-edit",
      refs: ["maintenance-rule:synthetic-bank@2"],
      diff: { kind: "revision", from: 1, to: 2, fields: ["pattern"] },
    },
    at("2026-10-09", 160),
  );
  await store.batch(rows.map(auditInsertWrite));
  return {
    db,
    rows,
    async answer(search) {
      const values: Record<string, string> = {};
      for (const key of new Set(search.keys())) {
        const all = search.getAll(key);
        if (all.length !== 1) return { status: 400, body: { error: "invalid_query" } };
        values[key] = all[0]!;
      }
      const { cursor = null, ...rest } = values;
      const filters = auditPageFilters(rest);
      if (filters === null) return { status: 400, body: { error: "invalid_query" } };
      const page = await readAuditPage(store, filters, cursor);
      if (!page.ok)
        return {
          status: page.code === "stale_context" ? 409 : 400,
          body: { error: page.code },
        };
      return {
        status: 200,
        body: {
          schemaVersion: "kogane-audit-page-v1",
          records: page.records,
          cursor: page.cursor,
        },
      };
    },
  };
}

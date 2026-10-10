import { canonicalJson } from "../../domain/src/context.ts";
import type { InstrumentTemporalRequest } from "../../domain/src/instrument-temporal.ts";
import type { CommandStore } from "../src/core/command-store.ts";
import type { SqlWrite } from "../src/core/operations.ts";
import {
  loadInstrumentTemporalSnapshot,
  prepareInstrumentTemporalAppend,
  type InstrumentTemporalDraft,
} from "../src/core/instrument-temporal.ts";
import {
  receiptReservationWrite,
  receiptExistsGuard,
  approvalConsumptionWrite,
  planCommittedWrite,
  outboxWrite,
} from "../src/atomic/decision-commit.ts";
export const TIME = "2099-01-01T00:00:00.000Z";
export const request: InstrumentTemporalRequest = {
  identifierIds: ["identifier:synthetic"],
  knowledge: { mode: "current" },
  effective: {
    role: "trade",
    confirmed: true,
    time: { kind: "local-date", value: "2099-01-01", zone: "Asia/Tokyo", basis: "provider" },
  },
  contract: {
    version: "synthetic-v1",
    endpoints: "half-open",
    basis: "business-date",
    zone: "Asia/Tokyo",
    openEnded: "allowed",
    referenceRole: "trade",
  },
};
export function draft(id: string, supersedes: string | null = null): InstrumentTemporalDraft {
  return {
    versionId: id,
    series: { kind: "mapping", identifierId: "identifier:synthetic" },
    supersedes,
    supersedesLegacy: [],
    contractVersion: "synthetic-v1",
    zone: "Asia/Tokyo",
    validity: {
      kind: "periods",
      periods: [
        {
          from: "2099-01-01",
          end: { kind: "open-ended" },
          evidenceRefs: ["synthetic:evidence"],
          reasonCode: "owner_stated",
          assertion: { targetRef: "instrument:synthetic" },
        },
      ],
    },
    evidenceRefs: ["synthetic:evidence"],
    reasonCode: "owner_stated",
  };
}
export function relation(id: string, supersedes: string | null = null): InstrumentTemporalDraft {
  return {
    ...draft(id, supersedes),
    series: { kind: "listed_as", fromRef: "instrument:synthetic", toRef: "identifier:synthetic" },
    validity: { kind: "periods", periods: [] },
  };
}
export async function seedPlan(store: CommandStore, key: string) {
  const planId = key.padEnd(64, "0");
  await store.batch([
    {
      sql: "INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status) VALUES(?,'identity.assign','{}','synthetic-storage-only','{}','{}','operator',?,'2199-01-01T00:00:00.000Z','approved')",
      binds: [planId, TIME],
    },
    {
      sql: "INSERT INTO approvals(approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at) VALUES(?,?,?,'operator','server','[]','2199-01-01T00:00:00.000Z',1,?)",
      binds: [`ap-${key}`, planId, planId, TIME],
    },
  ]);
  return planId;
}
export async function prepare(
  store: CommandStore,
  key: string,
  versions: InstrumentTemporalDraft[],
  now = TIME,
) {
  const loaded = await loadInstrumentTemporalSnapshot(store, 15000);
  if (!loaded.ok) throw new Error(loaded.reason);
  return prepareInstrumentTemporalAppend(store, {
    expectedHead: loaded.head,
    versions,
    request,
    operationId: `op-${key}`,
    principal: "operator",
    decisionRevisionId: `d-${key}`,
    now,
    maxRows: 15000,
  });
}
export type Prepared = Extract<Awaited<ReturnType<typeof prepare>>, { ok: true }>;
/** Real shared reservation/approval/outbox statements, not a dummy true guard. */
export function commitWrites(key: string, prepared: Prepared): SqlWrite[] {
  const op = `op-${key}`,
    decision = `d-${key}`;
  const guard = receiptExistsGuard(op, "operator");
  return [
    receiptReservationWrite({
      operationId: op,
      principal: "operator",
      operationKind: "identity.assign",
      payloadDigest: "a".repeat(64),
      planId: key.padEnd(64, "0"),
      receiptJson: "{}",
      now: TIME,
      approvalId: `ap-${key}`,
      expectedRevisionsJson: "{}",
      precondition: prepared.precondition,
    }),
    {
      sql: `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at) SELECT ?,'operator','server','synthetic-storage-test',?,'{}',? WHERE ${guard.sql} AND NOT EXISTS(SELECT 1 FROM decision_operations WHERE operation_id=?)`,
      binds: [op, "a".repeat(64), TIME, ...guard.binds, op],
    },
    {
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,created_at) SELECT ?,'relation',?,1,'accept','manual','operator',?,'synthetic','[]',? WHERE ${guard.sql} AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
      binds: [decision, `temporal:${op}`, op, TIME, ...guard.binds, decision],
    },
    ...prepared.writes,
    approvalConsumptionWrite(`ap-${key}`, op, "operator"),
    planCommittedWrite(key.padEnd(64, "0"), op, "operator"),
    outboxWrite(decision, "operator", op, "identity-projection", TIME),
  ];
}
export async function state(store: CommandStore) {
  const tables = [
    "instrument_temporal_acceptances",
    "instrument_temporal_versions",
    "decision_operations",
    "decision_revisions",
    "operation_receipts",
    "decision_outbox",
    "approvals",
    "change_plans",
    "core_source_revision",
  ];
  return canonicalJson(
    await Promise.all(tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`))),
  );
}

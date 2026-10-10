import { beforeAll, expect, test } from "bun:test";
import type { Grant } from "../src/grants.ts";
import { buildAuditRecord, auditInsertWrite } from "../src/audit/record.ts";
import { readAuditForGrant, readAuditRecordForGrant } from "../src/audit/read.ts";
import { scopedAuditPageSql } from "../src/audit/store.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";
beforeAll(() => migratedDatabase().close(), 60000);
const CORRELATION = "11111111-2222-4333-8444-555555555555";
const grant: Grant = {
  principal: "mcp-client:synthetic-owner",
  scopes: { sources: ["sony-bank"], accounts: "*", scheduleSources: ["sony-bank"] },
  capabilities: ["audit.read"],
  budget: { maxRows: 2, maxExplainDepth: 2, maxProposalTargets: 1 },
};
const actor = {
  path: "ui" as const,
  subject: "other-owner",
  principal: "other-owner",
  principalKind: "human" as const,
  correlationId: CORRELATION,
};
test("scope precedes the window; 600 denied records change no count, digest or cursor", async () => {
  const db = migratedDatabase(),
    store = sqliteCommandStore(db);
  for (let i = 0; i < 5; i++)
    await store.batch([
      auditInsertWrite(
        buildAuditRecord(
          actor,
          {
            operation: "financial.query",
            riskClass: "R0",
            result: "read",
            scope: { namespace: "core-source", source: "sony-bank" },
            targetRef: "source:sony-bank",
            diff: { kind: "read", rows: i, truncated: false },
          },
          new Date(Date.UTC(2026, 9, 9, 0, 0, i)).toISOString(),
        ),
      ),
    ]);
  const before = await readAuditForGrant({ store, grant, filters: {}, cursor: null });
  for (let i = 0; i < 600; i++)
    await store.batch([
      auditInsertWrite(
        buildAuditRecord(
          { ...actor, subject: "denied-identity", principal: "denied-identity" },
          {
            operation: "financial.query",
            riskClass: "R0",
            result: "read",
            scope: { namespace: "core-source", source: "denied-source" },
            targetRef: "source:denied-source",
            diff: { kind: "read", rows: 999, truncated: false },
          },
          new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString(),
        ),
      ),
    ]);
  const after = await readAuditForGrant({ store, grant, filters: {}, cursor: null });
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toMatch(/denied|other-owner/u);
  if (!after.ok) throw Error("expected page");
  expect(after.records).toHaveLength(2);
  expect(after.records[0]!.subject).toMatch(/^subj_[0-9a-f]{16}$/u);
  const next = await readAuditForGrant({ store, grant, filters: {}, cursor: after.cursor });
  expect(next.ok && next.records).toHaveLength(2);
  expect(
    await readAuditForGrant({
      store,
      grant: { ...grant, scopes: { ...grant.scopes, sources: ["another-source"] } },
      filters: {},
      cursor: after.cursor,
    }),
  ).toMatchObject({ ok: false, code: "stale_context" });
  const denied = (await store.first<{ audit_id: string }>(
    "SELECT audit_id FROM audit_records WHERE scope_source='denied-source'",
  ))!.audit_id;
  expect(await readAuditRecordForGrant({ store, grant, auditId: denied })).toEqual(
    await readAuditRecordForGrant({
      store,
      grant,
      auditId: "aud_11111111-2222-4333-8444-555555555555",
    }),
  );
  expect(
    await readAuditRecordForGrant({ store, grant, auditId: after.records[0]!.auditId }),
  ).toEqual({ ok: true, record: after.records[0]! });
  db.close();
});
test("account-listed and ungranted readers are refused before reading; schedule axis is separate", async () => {
  const db = migratedDatabase(),
    store = sqliteCommandStore(db);
  const never = {
    ...store,
    all: async () => {
      throw Error("out-of-scope query");
    },
    first: async () => {
      throw Error("out-of-scope query");
    },
  };
  expect(
    await readAuditForGrant({
      store: never,
      grant: { ...grant, capabilities: [] },
      filters: {},
      cursor: null,
    }),
  ).toEqual({ ok: false, code: "unauthorized" });
  expect(
    await readAuditForGrant({
      store: never,
      grant: { ...grant, scopes: { ...grant.scopes, accounts: ["one-account"] } },
      filters: {},
      cursor: null,
    }),
  ).toEqual({ ok: false, code: "evidence_restricted" });
  const own = {
    ...actor,
    path: "mcp" as const,
    subject: "synthetic-owner",
    principal: grant.principal,
    principalKind: "agent" as const,
  };
  const row = buildAuditRecord(
    own,
    {
      operation: "financial.query",
      riskClass: "R0",
      result: "read",
      scope: { namespace: "schedule-source", source: "sony-bank" },
      diff: { kind: "none" },
    },
    new Date().toISOString(),
  );
  await store.batch([auditInsertWrite(row)]);
  expect(
    await readAuditRecordForGrant({
      store,
      grant: { ...grant, scopes: { sources: "*", accounts: "*" } },
      auditId: row.audit_id,
    }),
  ).toEqual({ ok: false, code: "evidence_restricted" });
  const visible = await readAuditRecordForGrant({ store, grant, auditId: row.audit_id });
  expect(visible.ok && visible.record.subject).toBe("synthetic-owner");
  const global = buildAuditRecord(
    own,
    { operation: "financial.query", riskClass: "R0", result: "read", diff: { kind: "none" } },
    new Date().toISOString(),
  );
  await store.batch([auditInsertWrite(global)]);
  expect(await readAuditRecordForGrant({ store, grant, auditId: global.audit_id })).toEqual({
    ok: false,
    code: "evidence_restricted",
  });
  expect(
    (
      await readAuditRecordForGrant({
        store,
        grant: { ...grant, scopes: { sources: "*", accounts: "*", scheduleSources: "*" } },
        auditId: global.audit_id,
      })
    ).ok,
  ).toBe(true);
  db.close();
});
test("scoped SQL seeks the scope index without statistics; bounded parameter count at maximum grant size", () => {
  const db = migratedDatabase();
  const p = { sources: ["sony-bank"], scheduleSources: [], unscoped: false };
  const { sql, scopeBinds } = scopedAuditPageSql(p);
  const plan = db
    .query("EXPLAIN QUERY PLAN " + sql)
    .all(null, null, null, null, null, null, null, null, 3, ...(scopeBinds as string[])) as {
    detail: string;
  }[];
  expect(
    plan.some(
      (r) =>
        r.detail.includes("audit_records_by_scope") &&
        r.detail.includes("scope_namespace=? AND scope_source=?"),
    ),
  ).toBe(true);
  expect(
    scopedAuditPageSql({
      sources: Array.from({ length: 64 }, (_, i) => "core-" + i),
      scheduleSources: Array.from({ length: 64 }, (_, i) => "schedule-" + i),
      unscoped: false,
    }).scopeBinds,
  ).toHaveLength(4);
  db.close();
});

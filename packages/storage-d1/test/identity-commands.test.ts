// Identity commands over the real CORE schema (`bun:sqlite`, every migration
// and trigger). Synthetic rows only: one invented source, one source account,
// three invented accounts.
//
// A command's batch can reach the database twice: a resend that read the
// ledger before the first batch committed, or a change-lifecycle commit
// replayed under its receipt guard, which holds on a replay as well. Every
// statement of the batch must then write nothing new, however the subject
// moved in between.
import type { Database } from "bun:sqlite";
import { beforeAll, beforeEach, expect, test } from "bun:test";
import {
  executeIdentityCommand,
  prepareIdentityCommand,
  type IdentityCommand,
} from "../src/core/identity-commands.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const SOURCE = "identity-source";
const PRODUCER = "identity-producer";
const SOURCE_ACCOUNT = "sa_identity_synthetic";
const POLICY_VERSION = 1;

let db: Database;

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

beforeEach(() => {
  db = fullCoreDatabase();
  db.exec(`
INSERT INTO sources(id,provider,display_name) VALUES('${SOURCE}','synthetic','Identity source');
INSERT INTO producers(id,kind,display_name) VALUES('${PRODUCER}','collector','Identity producer');
INSERT INTO source_accounts(id,source_id,producer_id,reference_json)
 VALUES('${SOURCE_ACCOUNT}','${SOURCE}','${PRODUCER}','["synthetic-account"]');
INSERT INTO accounts(id,label,role,status) VALUES
 ('acct-rule','Rule account','deposit','provider-local'),
 ('acct-manual-a','Manual account A','deposit','identified'),
 ('acct-manual-b','Manual account B','deposit','identified');
INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
 VALUES('am_rule_1','${SOURCE_ACCOUNT}',1,'acct-rule','rule','synthetic-rule',1,'2026-01-01T00:00:00.000Z','Rule account','provider-local');`);
});

function command(patch: Partial<IdentityCommand> & Pick<IdentityCommand, "operationId">) {
  return {
    actorId: "operator-synthetic",
    actorVerification: "server" as const,
    action: "assign" as const,
    kind: "account" as const,
    referenceId: SOURCE_ACCOUNT,
    expectedRevision: 1,
    targetId: "acct-manual-a",
    reason: "synthetic manual decision",
    ...patch,
  };
}

function activeOverrides(): string[] {
  return (
    db
      .query(
        "SELECT operation_id FROM active_manual_overrides WHERE subject_ref=? ORDER BY operation_id",
      )
      .all(SOURCE_ACCOUNT) as { operation_id: string }[]
  ).map((row) => row.operation_id);
}

test("a release-override batch delivered twice never releases an override made after it", async () => {
  const d1 = sqliteD1(db);
  expect(
    await executeIdentityCommand(d1, command({ operationId: "op-assign-a" }), POLICY_VERSION),
  ).toMatchObject({ ok: true, replayed: false });
  expect(activeOverrides()).toEqual(["op-assign-a"]);

  // The release is prepared once and its batch delivered twice; the second
  // delivery read the ledger before the first one committed.
  const release = command({
    operationId: "op-release",
    action: "release-override",
    expectedRevision: 2,
    targetId: null,
    reason: "automatic policy may apply again",
  });
  const prepared = await prepareIdentityCommand(d1, release, POLICY_VERSION);
  if ("error" in prepared) throw new Error(prepared.error);
  const deliver = () =>
    d1.batch(prepared.writes.map((write) => d1.prepare(write.sql).bind(...write.binds)));
  await deliver();
  expect(activeOverrides()).toEqual([]);

  // Someone assigns again after the release: a new active override.
  expect(
    await executeIdentityCommand(
      d1,
      command({ operationId: "op-assign-b", expectedRevision: 2, targetId: "acct-manual-b" }),
      POLICY_VERSION,
    ),
  ).toMatchObject({ ok: true, replayed: false });
  expect(activeOverrides()).toEqual(["op-assign-b"]);

  const before = db.query("SELECT count(*) AS n FROM decision_revisions").get() as { n: number };
  await deliver();
  // The late delivery writes nothing: the override made after the release is
  // still in force, and no decision row changed.
  expect(activeOverrides()).toEqual(["op-assign-b"]);
  expect(db.query("SELECT count(*) AS n FROM decision_revisions").get()).toEqual(before);
  expect(
    db
      .query("SELECT count(*) AS n FROM decision_revisions WHERE superseded_by=?")
      .get(prepared.receipt.decisionRevisionId),
  ).toEqual({ n: 1 });
});

test("a release supersedes exactly the overrides its decision cites", async () => {
  const d1 = sqliteD1(db);
  const assign = await executeIdentityCommand(
    d1,
    command({ operationId: "op-assign-a" }),
    POLICY_VERSION,
  );
  if (!assign.ok) throw new Error(assign.error);
  const release = await executeIdentityCommand(
    d1,
    command({
      operationId: "op-release",
      action: "release-override",
      expectedRevision: 2,
      targetId: null,
    }),
    POLICY_VERSION,
  );
  if (!release.ok) throw new Error(release.error);
  const decision = db
    .query("SELECT evidence_refs_json FROM decision_revisions WHERE id=?")
    .get(release.receipt.decisionRevisionId) as { evidence_refs_json: string };
  expect(JSON.parse(decision.evidence_refs_json)).toEqual([
    `decision_revision:${assign.receipt.decisionRevisionId}`,
  ]);
  expect(
    db
      .query("SELECT superseded_by FROM decision_revisions WHERE id=?")
      .get(assign.receipt.decisionRevisionId),
  ).toEqual({ superseded_by: release.receipt.decisionRevisionId });
  expect(activeOverrides()).toEqual([]);
});

// G2-14 and G2-15 over the real CORE schema: when the expected-revision guard
// of a commit matches nothing, the batch must leave no receipt, no decision
// revision, no spent approval, no closed plan and no outbox row — not "mostly
// nothing". G2-16: the immutability triggers still refuse a rewrite of what
// the commit wrote.
//
// The statements under test are the ones the App and the Processor share
// (`src/atomic/decision-commit.ts`, extracted by U05); this test runs them
// against `bun:sqlite` with every CORE migration applied, so the guards are
// checked against the same CHECK constraints and triggers production has.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  approvalConsumptionWrite,
  outboxWrite,
  planCommittedWrite,
  planStaleWrite,
  receiptExistsGuard,
  receiptReservationWrite,
} from "../src/atomic/decision-commit.ts";
import { expectedRevisionsSql, type SqlWrite } from "../src/core/operations.ts";
import { d1CommandStore } from "../src/core/command-store.ts";
import { coreDatabase, sqliteD1 } from "./sqlite.ts";

const PLAN_ID = "a".repeat(64);
const PAYLOAD_DIGEST = "b".repeat(64);
const APPROVAL_ID = "approval-1";
const OPERATION_ID = "op-1";
const PRINCIPAL = "human:tester";
const SUBJECT = "account_mapping:synthetic-account";
const NOW = "2026-09-11T00:00:00.000Z";
const DECISION_ID = "decision-1";

let db: Database;

/** The identity rows a mapping decision needs, all synthetic. */
const IDENTITY_FIXTURE = `INSERT INTO sources(id,provider) VALUES('synthetic-card','synthetic');
INSERT INTO producers(id) VALUES('synthetic-producer');
INSERT INTO source_accounts(id,source_id,producer_id,reference_json)
  VALUES('synthetic-account','synthetic-card','synthetic-producer','{"ref":"synthetic"}');
INSERT INTO accounts(id,label,role,status) VALUES('acct-1','Synthetic','owner','identified');`;

/** A plan and its approval, both live, with one expected revision. */
function seed(expectedRevisions: Record<string, number>): void {
  db.exec(IDENTITY_FIXTURE);
  db.exec(`INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
    VALUES('${PLAN_ID}','identity.assign','{}','ctx-1','${JSON.stringify(expectedRevisions)}','{}','${PRINCIPAL}','${NOW}','2999-01-01T00:00:00Z','planned');
INSERT INTO approvals(approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at)
    VALUES('${APPROVAL_ID}','${PLAN_ID}','${PLAN_ID}','${PRINCIPAL}','server','[]','2999-01-01T00:00:00Z',1,'${NOW}');`);
}

/** The mutation a planner contributes: the mapping revision and the decision
 * that explains it, each guarded on the receipt the first statement reserves,
 * exactly as the identity command writes them. */
function mutationWrites(payloadDigest: string): SqlWrite[] {
  const guard = receiptExistsGuard({
    operationId: OPERATION_ID,
    principal: PRINCIPAL,
    payloadDigest,
  });
  return [
    {
      sql: `INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
      SELECT 'am-1','synthetic-account',1,'acct-1','manual','synthetic',1,?,'Synthetic','identified'
      WHERE ${guard.sql} AND NOT EXISTS(SELECT 1 FROM account_mappings WHERE id='am-1')`,
      binds: [NOW, ...guard.binds],
    },
    {
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
      SELECT ?,'account_mapping','synthetic-account',1,'assign','manual',?,'synthetic','[]',?
      WHERE ${guard.sql} AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
      binds: [DECISION_ID, PRINCIPAL, NOW, ...guard.binds, DECISION_ID],
    },
  ];
}

function commitWrites(
  expectedRevisions: Record<string, number>,
  precondition?: SqlWrite,
  payloadDigest = PAYLOAD_DIGEST,
): SqlWrite[] {
  const receipt = { operationId: OPERATION_ID, principal: PRINCIPAL, payloadDigest };
  return [
    receiptReservationWrite({
      operationId: OPERATION_ID,
      principal: PRINCIPAL,
      operationKind: "identity.assign",
      payloadDigest,
      planId: PLAN_ID,
      receiptJson: JSON.stringify({ operationId: OPERATION_ID }),
      now: NOW,
      approvalId: APPROVAL_ID,
      expectedRevisionsJson: JSON.stringify(expectedRevisions),
      ...(precondition ? { precondition } : {}),
    }),
    ...mutationWrites(payloadDigest),
    approvalConsumptionWrite(APPROVAL_ID, receipt),
    planCommittedWrite(PLAN_ID, receipt),
    outboxWrite(DECISION_ID, receipt, "identity-projection", NOW),
  ];
}

function counts(): Record<string, number> {
  const one = (sql: string): number => (db.query(sql).get() as { n: number }).n;
  return {
    receipts: one("SELECT count(*) AS n FROM operation_receipts"),
    decisions: one("SELECT count(*) AS n FROM decision_revisions"),
    mappings: one("SELECT count(*) AS n FROM account_mappings"),
    outbox: one("SELECT count(*) AS n FROM decision_outbox"),
    approvalUses: one(
      `SELECT uses_remaining AS n FROM approvals WHERE approval_id='${APPROVAL_ID}'`,
    ),
    committedPlans: one("SELECT count(*) AS n FROM change_plans WHERE status='committed'"),
  };
}

beforeEach(() => {
  db = coreDatabase();
});

describe("the decision + receipt + outbox commit (G2-14, G2-15, G2-16)", () => {
  test("a guard that matches nothing writes nothing at all, not a partial receipt", async () => {
    // The plan expects revision 0; a concurrent commit has since written
    // revision 1 for the same subject, which is what G2-15 describes.
    seed({ [SUBJECT]: 0 });
    db.exec(`INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
      VALUES('am-concurrent','synthetic-account',1,'acct-1','manual','synthetic',1,'${NOW}','Synthetic','identified');
INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
      VALUES('concurrent','account_mapping','synthetic-account',1,'assign','manual','someone-else','synthetic','[]','${NOW}');`);
    const before = counts();

    const results = await d1CommandStore(sqliteD1(db)).batch(commitWrites({ [SUBJECT]: 0 }));

    // Every statement matched nothing: the reservation because the revision
    // moved, the rest because the reservation did not write.
    expect(results.map((result) => result.changes)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(counts()).toEqual(before);
    expect(before.receipts).toBe(0);
    expect(before.outbox).toBe(0);
  });

  test("domain eligibility is rechecked inside reservation and consumes nothing on failure", async () => {
    seed({ [SUBJECT]: 0 });
    const before = counts();
    const store = d1CommandStore(sqliteD1(db));
    // Simulate a source becoming ineligible after planning, while the target
    // decision revision itself remains unchanged. Two anonymous parameters
    // exercise the offset after the reservation's nine numbered parameters.
    const precondition = {
      sql: "EXISTS(SELECT 1 FROM accounts WHERE id=? AND status=?)",
      binds: ["acct-1", "unresolved"],
    };
    const refused = await store.batch(commitWrites({ [SUBJECT]: 0 }, precondition));
    expect(refused.every((result) => result.changes === 0)).toBe(true);
    expect(counts()).toEqual(before);
    const accepted = await store.batch(
      commitWrites(
        { [SUBJECT]: 0 },
        {
          ...precondition,
          binds: ["acct-1", "identified"],
        },
      ),
    );
    expect(accepted[0]?.changes).toBe(1);
    expect(counts()).toMatchObject({
      receipts: 1,
      decisions: 1,
      approvalUses: 0,
      committedPlans: 1,
    });
  });

  test("the same batch with the revision the plan expected writes all of it", async () => {
    seed({ [SUBJECT]: 0 });

    const results = await d1CommandStore(sqliteD1(db)).batch(commitWrites({ [SUBJECT]: 0 }));

    // Every statement wrote. The decision and the mapping report two rows
    // each: their own, and the CORE revision bump migration 0038's trigger
    // writes in the same transaction — D1 counts rows written by triggers, so
    // a count that has to mean "rows this statement wrote" reads a RETURNING
    // clause instead (docs/projection-input.md).
    expect(results.map((result) => result.changes)).toEqual([1, 2, 2, 1, 1, 1]);
    expect(counts()).toEqual({
      receipts: 1,
      decisions: 1,
      mappings: 1,
      outbox: 1,
      approvalUses: 0,
      committedPlans: 1,
    });
  });

  test("replaying the batch changes nothing: the operation key is already reserved", async () => {
    seed({ [SUBJECT]: 0 });
    const store = d1CommandStore(sqliteD1(db));
    await store.batch(commitWrites({ [SUBJECT]: 0 }));
    const after = counts();

    const replay = await store.batch(commitWrites({ [SUBJECT]: 0 }));

    expect(replay.map((result) => result.changes)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(counts()).toEqual(after);
  });

  test("another payload's receipt under the same key and principal admits no statement", async () => {
    // A command of the same principal took this key between this command's
    // reads and its batch: its receipt names another payload (and plan).
    seed({ [SUBJECT]: 0 });
    const otherPlan = "d".repeat(64);
    db.exec(`INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
    VALUES('${otherPlan}','relation.accept','{}','ctx-1','{}','{}','${PRINCIPAL}','${NOW}','2999-01-01T00:00:00Z','committed');
INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at)
    VALUES('${OPERATION_ID}','${PRINCIPAL}','relation.accept','${"c".repeat(64)}','${otherPlan}','accepted','{}','${NOW}');`);
    const before = counts();

    const results = await d1CommandStore(sqliteD1(db)).batch(commitWrites({ [SUBJECT]: 0 }));

    // The reservation finds the key taken; every later statement finds no
    // receipt of this payload. The plan stays open and the approval unspent.
    expect(results.map((result) => result.changes)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(counts()).toEqual(before);
    expect(before).toMatchObject({ approvalUses: 1, committedPlans: 1, decisions: 0 });
  });

  test("a decision ledger row under the key with no receipt admits no statement", async () => {
    // A route that keeps no receipt (the direct identity command) wrote its
    // ledger row under this key; its decision ids derive from the same key.
    seed({ [SUBJECT]: 0 });
    db.exec(`INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
    VALUES('${OPERATION_ID}','${PRINCIPAL}','server','assign','${"c".repeat(64)}','{}','${NOW}');`);
    const before = counts();

    const results = await d1CommandStore(sqliteD1(db)).batch(commitWrites({ [SUBJECT]: 0 }));

    expect(results.map((result) => result.changes)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(counts()).toEqual(before);
    expect(before).toMatchObject({ receipts: 0, approvalUses: 1, committedPlans: 0 });
  });

  test("without table statistics the reservation finds a ledger row by its key and scans neither key table", () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const [reservation] = commitWrites({ [SUBJECT]: 0 });
    const plan = (
      db
        .query(`EXPLAIN QUERY PLAN ${reservation!.sql}`)
        .all(...(reservation!.binds as never[])) as {
        detail: string;
      }[]
    ).map((row) => row.detail);
    // The ledger condition is one primary-key probe, read from the index alone.
    expect(plan).toContain(
      "SEARCH decision_operations USING COVERING INDEX sqlite_autoindex_decision_operations_1 (operation_id=?)",
    );
    expect(plan).toContain(
      "SEARCH operation_receipts USING COVERING INDEX sqlite_autoindex_operation_receipts_1 (operation_id=?)",
    );
    expect(
      plan.filter((detail) => /^SCAN (decision_operations|operation_receipts)\b/u.test(detail)),
    ).toEqual([]);
  });

  test("the revision expression answers 0 for a subject with no history", async () => {
    seed({ [SUBJECT]: 0 });
    const guard = db
      .query(`SELECT ${expectedRevisionsSql("?")} AS ok`)
      .get(JSON.stringify({ [SUBJECT]: 0 })) as { ok: number };
    expect(guard.ok).toBe(1);
    const moved = db
      .query(`SELECT ${expectedRevisionsSql("?")} AS ok`)
      .get(JSON.stringify({ [SUBJECT]: 1 })) as { ok: number };
    expect(moved.ok).toBe(0);
  });

  test("what the commit wrote cannot be rewritten or deleted (G2-16)", async () => {
    seed({ [SUBJECT]: 0 });
    await d1CommandStore(sqliteD1(db)).batch(commitWrites({ [SUBJECT]: 0 }));

    expect(() =>
      db.exec(`UPDATE decision_revisions SET reason='rewritten' WHERE id='${DECISION_ID}'`),
    ).toThrow();
    expect(() => db.exec(`DELETE FROM decision_revisions WHERE id='${DECISION_ID}'`)).toThrow();
    expect(() =>
      db.exec(`UPDATE operation_receipts SET payload_digest='${"c".repeat(64)}'`),
    ).toThrow();
    expect(() => db.exec("DELETE FROM decision_outbox")).toThrow();
    // The one permitted receipt change: accepted → published.
    db.exec(`UPDATE operation_receipts SET status='published',published_at='${NOW}'`);
    expect(
      (db.query("SELECT status FROM operation_receipts").get() as { status: string }).status,
    ).toBe("published");
  });

  test("marking a plan stale leaves the plan itself untouched", async () => {
    seed({ [SUBJECT]: 0 });
    await d1CommandStore(sqliteD1(db)).batch([planStaleWrite(PLAN_ID)]);
    const plan = db.query("SELECT status,expected_revisions_json FROM change_plans").get() as {
      status: string;
      expected_revisions_json: string;
    };
    expect(plan.status).toBe("stale");
    expect(JSON.parse(plan.expected_revisions_json)).toEqual({ [SUBJECT]: 0 });
  });
});

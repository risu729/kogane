// The commit's receipt guard names the command's own receipt (key, principal
// and payload digest), not any receipt under the key. This proves the change
// the way the repository proves a query rewrite (docs/read-model.md#cost):
//
//   * on random and scaled stores where no other payload of the same principal
//     holds the key, every guarded statement answers exactly as the frozen
//     text (test/decision-commit-legacy-sql.ts) did: the same changes and the
//     same rows afterwards. The one exception is the approval consumption of
//     a replay (the command's own receipt exists and the approval's plan is
//     already closed), which the frozen text spent and the shipped statement
//     does not;
//   * where one does (the race between a command's reads and its batch), the
//     frozen text writes and the guarded statement writes nothing;
//   * without table statistics, every statement still searches
//     `operation_receipts` by key the way the frozen text did, and scans no
//     table.
//
// Synthetic rows only.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  approvalConsumptionWrite,
  outboxWrite,
  planCommittedWrite,
  receiptExistsGuard,
  type ReceiptKey,
} from "../src/atomic/decision-commit.ts";
import type { SqlWrite } from "../src/core/operations.ts";
import {
  legacyApprovalConsumptionWrite,
  legacyOutboxWrite,
  legacyPlanCommittedWrite,
  legacyReceiptExistsGuard,
} from "./decision-commit-legacy-sql.ts";
import { coreDatabase } from "./sqlite.ts";

const NOW = "2026-09-11T00:00:00.000Z";
const PRINCIPALS = ["human:synthetic-a", "human:synthetic-b"];
const DIGESTS = ["a", "b", "c"].map((c) => c.repeat(64));
const OPERATIONS = ["op-0", "op-1", "op-2", "op-3"];
const PLANS = ["0", "1", "2", "3"].map((c) => c.repeat(64));
const APPROVALS = ["ap-0", "ap-1", "ap-2", "ap-3"];
const DECISIONS = ["dr-0", "dr-1", "dr-missing"];
const TARGETS = ["identity-projection", "balance-projection"];
const PLAN_STATUSES = ["planned", "approved", "committed", "stale"];

/** A deterministic generator, so a failing store can be rebuilt. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let migrated: Uint8Array | undefined;
const pick = <T>(next: () => number, values: readonly T[]): T =>
  values[Math.floor(next() * values.length)]!;

/**
 * A store of plans, approvals, decisions, receipts and outbox rows. `filler`
 * adds receipts under other keys (a scaled store); none of them is a key a
 * command below uses.
 */
function store(seed: number, filler = 0): Database {
  const next = random(seed);
  // CORE is migrated once; every store starts from a copy of that image.
  migrated ??= coreDatabase().serialize();
  const db = Database.deserialize(migrated);
  const insertPlan = db.prepare(
    `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
     VALUES(?,'relation.accept','{}','ctx-synthetic','{}','{}',?,?,'2999-01-01T00:00:00Z',?)`,
  );
  const insertApproval = db.prepare(
    `INSERT INTO approvals(approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at)
     VALUES(?,?,?,?,'server','[]','2999-01-01T00:00:00Z',?,?)`,
  );
  const insertReceipt = db.prepare(
    `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at)
     VALUES(?,?,'relation.accept',?,?,'accepted','{}',?)`,
  );
  for (const [index, plan] of PLANS.entries()) {
    insertPlan.run(plan, pick(next, PRINCIPALS), NOW, pick(next, PLAN_STATUSES));
    insertApproval.run(
      APPROVALS[index]!,
      plan,
      plan,
      pick(next, PRINCIPALS),
      Math.floor(next() * 3),
      NOW,
    );
  }
  for (const id of DECISIONS.slice(0, 2))
    db.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
       VALUES(?,'relation',?,1,'accept','manual',?,'synthetic','[]',?)`,
    ).run(id, `synthetic-${id}`, PRINCIPALS[0]!, NOW);
  for (const operation of OPERATIONS)
    if (next() < 0.7)
      insertReceipt.run(
        operation,
        pick(next, PRINCIPALS),
        pick(next, DIGESTS),
        pick(next, PLANS),
        NOW,
      );
  for (let index = 0; index < filler; index++)
    insertReceipt.run(
      `filler-${index}`,
      pick(next, PRINCIPALS),
      pick(next, DIGESTS),
      pick(next, PLANS),
      NOW,
    );
  for (const decision of DECISIONS.slice(0, 2))
    for (const target of TARGETS)
      if (next() < 0.3) {
        const operation = pick(next, OPERATIONS);
        db.prepare(
          `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at,available_at_ms)
           VALUES(?,?,?,?,?,0)`,
        ).run(decision, pick(next, PRINCIPALS), operation, target, NOW);
      }
  return db;
}

interface Command extends ReceiptKey {
  planId: string;
  approvalId: string;
  decisionRevisionId: string;
  target: string;
}

function command(next: () => number): Command {
  return {
    operationId: pick(next, OPERATIONS),
    principal: pick(next, PRINCIPALS),
    payloadDigest: pick(next, DIGESTS),
    planId: pick(next, PLANS),
    approvalId: pick(next, APPROVALS),
    decisionRevisionId: pick(next, DECISIONS),
    target: pick(next, TARGETS),
  };
}

/** The guarded statements of one command, shipped and frozen. */
function statements(c: Command): { name: string; shipped: SqlWrite; legacy: SqlWrite }[] {
  return [
    {
      name: "approval",
      shipped: approvalConsumptionWrite(c.approvalId, c),
      legacy: legacyApprovalConsumptionWrite(c.approvalId, c.operationId, c.principal),
    },
    {
      name: "plan",
      shipped: planCommittedWrite(c.planId, c),
      legacy: legacyPlanCommittedWrite(c.planId, c.operationId, c.principal),
    },
    {
      name: "outbox",
      shipped: outboxWrite(c.decisionRevisionId, c, c.target, NOW),
      legacy: legacyOutboxWrite(c.decisionRevisionId, c.principal, c.operationId, c.target, NOW),
    },
  ];
}

/** Another payload of the same principal holds the key: the raced store. */
function raced(db: Database, c: Command): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM operation_receipts WHERE operation_id=? AND principal=? AND payload_digest<>?",
      )
      .get(c.operationId, c.principal, c.payloadDigest) !== null
  );
}

/** The plan the approval is bound to can still be committed. */
function approvalPlanOpen(db: Database, approvalId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM approvals a JOIN change_plans p ON p.plan_id=a.plan_id
         WHERE a.approval_id=? AND p.status IN ('planned','approved')`,
      )
      .get(approvalId) !== null
  );
}

/** Every row a guarded statement can change. */
function snapshot(db: Database): string {
  return JSON.stringify([
    db.query("SELECT approval_id,uses_remaining FROM approvals ORDER BY approval_id").all(),
    db.query("SELECT plan_id,status FROM change_plans ORDER BY plan_id").all(),
    db
      .query(
        "SELECT decision_revision_id,principal,operation_id,target FROM decision_outbox ORDER BY id",
      )
      .all(),
  ]);
}

/** What a statement wrote, rolled back afterwards. */
function apply(db: Database, write: SqlWrite): { changes: number; after: string } {
  db.exec("SAVEPOINT probe");
  try {
    const { changes } = db.prepare(write.sql).run(...(write.binds as never[]));
    return { changes, after: snapshot(db) };
  } finally {
    db.exec("ROLLBACK TO probe");
    db.exec("RELEASE probe");
  }
}

function guardHolds(db: Database, guard: SqlWrite): number {
  return (db.query(`SELECT ${guard.sql} AS ok`).get(...(guard.binds as never[])) as { ok: number })
    .ok;
}

/**
 * Runs `commands` commands of each store against the shipped and frozen
 * statements and returns which outcomes it saw, so the caller can check the
 * stores reached every branch.
 */
function compare(seeds: readonly number[], commands: number, filler = 0): Set<string> {
  const seen = new Set<string>();
  for (const seed of seeds) {
    const db = store(seed, filler);
    const next = random(seed ^ 0x5eed);
    const before = snapshot(db);
    for (let index = 0; index < commands; index++) {
      const c = command(next);
      const race = raced(db, c);
      const shippedGuard = guardHolds(db, receiptExistsGuard(c));
      const legacyGuard = guardHolds(db, legacyReceiptExistsGuard(c.operationId, c.principal));
      if (race) {
        expect(legacyGuard).toBe(1);
        expect(shippedGuard).toBe(0);
      } else expect(shippedGuard).toBe(legacyGuard);
      seen.add(`${race ? "raced" : "clean"} guard ${shippedGuard}`);
      const replay = shippedGuard === 1 && !approvalPlanOpen(db, c.approvalId);
      for (const { name, shipped, legacy } of statements(c)) {
        const now = apply(db, shipped);
        const then = apply(db, legacy);
        if (race) {
          expect(now).toEqual({ changes: 0, after: before });
          if (then.changes > 0) seen.add(`raced ${name}: frozen text wrote`);
        } else if (name === "approval" && replay) {
          // The command's own receipt exists and its approval's plan is
          // closed: a replay, which spends no further use.
          expect(now).toEqual({ changes: 0, after: before });
          if (then.changes > 0) seen.add("replayed approval: frozen text wrote");
        } else {
          expect(now).toEqual(then);
          seen.add(`clean ${name} ${now.changes > 0 ? "wrote" : "held"}`);
        }
      }
      expect(snapshot(db)).toBe(before);
    }
    db.close();
  }
  return seen;
}

const EVERY_OUTCOME = [
  "clean guard 0",
  "clean guard 1",
  "raced guard 0",
  "replayed approval: frozen text wrote",
  ...["approval", "plan", "outbox"].flatMap((name) => [
    `clean ${name} wrote`,
    `clean ${name} held`,
    `raced ${name}: frozen text wrote`,
  ]),
];

describe("the receipt guard against its frozen text", () => {
  test("random stores: equal wherever no other payload holds the key, silent where one does", () => {
    const seen = compare(
      Array.from({ length: 60 }, (_, index) => index + 1),
      40,
    );
    for (const outcome of EVERY_OUTCOME) expect(seen).toContain(outcome);
  }, 60_000);

  test("scaled stores: thousands of receipts under other keys change no answer", () => {
    const seen = compare([101, 102, 103, 104], 80, 5000);
    expect(seen).toContain("clean guard 1");
    expect(seen).toContain("raced guard 0");
  }, 60_000);

  test("without table statistics every statement searches the receipt by key and scans nothing", () => {
    const db = store(7, 2000);
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const c: Command = {
      operationId: OPERATIONS[0]!,
      principal: PRINCIPALS[0]!,
      payloadDigest: DIGESTS[0]!,
      planId: PLANS[0]!,
      approvalId: APPROVALS[0]!,
      decisionRevisionId: DECISIONS[0]!,
      target: TARGETS[0]!,
    };
    const explain = (write: SqlWrite): string[] =>
      (
        db.query(`EXPLAIN QUERY PLAN ${write.sql}`).all(...(write.binds as never[])) as {
          detail: string;
        }[]
      ).map((row) => row.detail);
    const asQuery = (guard: SqlWrite): SqlWrite => ({
      sql: `SELECT ${guard.sql} AS ok`,
      binds: guard.binds,
    });
    const pairs = [
      {
        shipped: asQuery(receiptExistsGuard(c)),
        legacy: asQuery(legacyReceiptExistsGuard(c.operationId, c.principal)),
      },
      ...statements(c),
    ];
    for (const { shipped, legacy } of pairs) {
      // The approval consumption's open-plan condition is the one lookup the
      // frozen text did not make: the plan by its key, correlated with the
      // single approval row the key search found.
      const added = shipped.sql.includes("plan_id=approvals.plan_id")
        ? [
            "CORRELATED SCALAR SUBQUERY 2",
            "SEARCH change_plans USING INDEX sqlite_autoindex_change_plans_1 (plan_id=?)",
          ]
        : [];
      const plan = explain(shipped).filter((detail) => !added.includes(detail));
      expect(explain(shipped).filter((detail) => added.includes(detail))).toEqual(added);
      // A SELECT with no FROM reads its one constant row; no table is scanned.
      expect(
        plan.filter((detail) => detail.startsWith("SCAN") && detail !== "SCAN CONSTANT ROW"),
      ).toEqual([]);
      // The receipt is found through a unique key on (principal, operation_id)
      // or operation_id, and the digest is checked on that one row.
      expect(
        plan.some((detail) =>
          /^SEARCH operation_receipts (EXISTS )?USING INDEX .*operation_id=\?\)$/u.test(detail),
        ),
      ).toBe(true);
      // The digest changes no access path: the plan is the frozen text's,
      // except that the frozen guard's lookup was covered by the unique index
      // and this one reads the single row that index finds, for its digest.
      const uncovered = (details: string[]) =>
        details.map((detail) =>
          detail.replace(/^(SEARCH operation_receipts (?:EXISTS )?USING )COVERING /u, "$1"),
        );
      expect(plan).toEqual(uncovered(explain(legacy)));
    }
    db.close();
  });
});

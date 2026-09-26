// The card purchase review kinds exist in the schema (CORE 0051) and the
// payload contract, but no planner is registered yet (ADR 0017). Planning one
// is refused before anything is stored, and a plan row that reached the table
// by any other path still commits nothing. Real migrations, synthetic ids.
import { describe, expect, test } from "bun:test";
import {
  approve,
  CARD_REVIEW_KINDS,
  type CardReviewKind,
  commit,
  createPlan,
  type Principal,
  REVIEW_PLANNERS,
  resolveAndSimulate,
} from "../src/index.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

const hex = (digit: string) => digit.repeat(64);
const reason = "Reviewed the statement row";
const PAYLOADS: Record<CardReviewKind, Record<string, unknown>> = {
  "card-purchase.exclude": { eventId: `purchase_${hex("a")}`, reasonCode: "other", reason },
  "card-purchase.restore": { eventId: `purchase_${hex("a")}`, reason },
  "card-refund.allocate": {
    refundEventId: `refund_${hex("b")}`,
    purchaseEventId: `purchase_${hex("a")}`,
    reason,
  },
  "card-refund.withdraw": { allocationId: `ra_${hex("d")}`, reason },
  "card-installment.link": {
    obligationId: `obl_cp_${hex("c")}`,
    portionRefs: ["transaction:2@parse_run:1"],
    reason,
  },
  "card-installment.unlink": {
    obligationId: `obl_cp_${hex("c")}`,
    portionKeys: [JSON.stringify(["myjcb", "producer", null, "card", "row-2"])],
    reason,
  },
};
const human: Principal = {
  id: "operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const agent: Principal = {
  ...human,
  id: "agent",
  kind: "agent",
  capabilities: ["interpretation.propose"],
};
const now = "2026-09-26T00:00:00.000Z";
const COUNTED = [
  "change_plans",
  "approvals",
  "operation_receipts",
  "decision_outbox",
  "decision_revisions",
];

function counts(db: ReturnType<typeof migratedDatabase>) {
  return Object.fromEntries(
    COUNTED.map((table) => [
      table,
      (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}

describe("card purchase review kinds are not plannable yet", () => {
  test("no planner is registered for any review kind", () => {
    expect(Object.keys(REVIEW_PLANNERS)).toEqual([]);
  });

  test("planning each kind is refused with unsupported_semantics and writes no row", async () => {
    const db = migratedDatabase();
    try {
      const store = sqliteCommandStore(db);
      const before = counts(db);
      for (const kind of CARD_REVIEW_KINDS) {
        for (const actor of [human, agent]) {
          const result = await createPlan(
            kind,
            PAYLOADS[kind],
            { actor, baseContextId: "context", now, ttlSeconds: 900 },
            store,
          );
          expect(result).toEqual({ ok: false, error: "unsupported_semantics", refs: [kind] });
        }
        // A malformed payload is refused as such, before the missing planner.
        const malformed = await createPlan(
          kind,
          { ...PAYLOADS[kind], amount: "1" },
          { actor: human, baseContextId: "context", now, ttlSeconds: 900 },
          store,
        );
        expect(malformed).toMatchObject({ ok: false, error: "invalid_command" });
        expect(await resolveAndSimulate(store, kind, PAYLOADS[kind] as never)).toEqual({
          ok: false,
          error: "unsupported_semantics",
          refs: [kind],
        });
      }
      expect(counts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("a stored plan of a review kind commits nothing while its writer is empty", async () => {
    const db = migratedDatabase();
    try {
      const store = sqliteCommandStore(db);
      for (const [index, kind] of CARD_REVIEW_KINDS.entries()) {
        // The schema admits the kind (0051); the lifecycle still refuses it.
        const planId = index.toString(16).padStart(64, "0");
        db.run(`INSERT INTO change_plans VALUES(?,?,?,'context','{}',?,'operator',?,?,'planned')`, [
          planId,
          kind,
          JSON.stringify(PAYLOADS[kind]),
          JSON.stringify({ kind, targets: [], outboxTargets: ["agent-notify"] }),
          now,
          "2026-09-26T01:00:00.000Z",
        ]);
        const approval = await approve(store, {
          planId,
          planDigest: planId,
          actor: human,
          scope: [],
          ttlSeconds: 600,
          now,
        });
        if (!approval.ok) throw new Error(approval.error);
        const before = counts(db);
        const result = await commit(store, {
          operationId: `op-${index}`,
          principal: human,
          planId,
          approvalId: approval.approval.approvalId,
          planners: { [kind]: async () => null },
          now,
        });
        expect(result).toEqual({ ok: false, error: "unsupported_semantics", refs: [kind] });
        // Without a slot at all the commit is refused the same way.
        expect(
          await commit(store, {
            operationId: `op-${index}-b`,
            principal: human,
            planId,
            approvalId: approval.approval.approvalId,
            planners: {},
            now,
          }),
        ).toEqual({ ok: false, error: "unsupported_semantics", refs: [kind] });
        expect(counts(db)).toEqual(before);
        const stored = db.query("SELECT status FROM change_plans WHERE plan_id=?").get(planId) as {
          status: string;
        };
        expect(stored.status).toBe("approved");
        const uses = db
          .query("SELECT uses_remaining FROM approvals WHERE approval_id=?")
          .get(approval.approval.approvalId) as { uses_remaining: number };
        expect(uses.uses_remaining).toBe(approval.approval.usesRemaining);
      }
    } finally {
      db.close();
    }
  });
});

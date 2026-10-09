// The economic-event command kinds exist in the schema (CORE 0071) and the
// payload contract, but no planner is registered (ADR 0054, G2: vocabulary
// only). No principal, human or agent, can plan, simulate, approve or commit
// one: each step answers `unsupported_semantics` (or `approval_required` for
// an agent at approve and commit) and writes no row. Real migrations,
// synthetic ids and keys, no amount.
import { beforeAll, describe, expect, test } from "bun:test";
import { IDENTITY_RESOLUTION_KIND } from "../../domain/src/economic-contract.ts";
import {
  approve,
  CHANGE_KINDS,
  commit,
  createPlan,
  ECONOMIC_EVENT_COMMAND_KINDS,
  ECONOMIC_EVENT_PLANNERS,
  type EconomicEventCommandKind,
  isChangeKind,
  loadPlan,
  type Principal,
  resolveAndSimulate,
  simulate,
  validPayload,
} from "../src/index.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget, not inside whichever test first asks for a copy
// (see ./sqlite-store.ts).
beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const reason = "Reviewed both rows";
const key = (row: string) => [
  "synthetic-bank",
  "synthetic-producer",
  null,
  "synthetic-account",
  row,
];
const claim = (row: string) => ({ book: "cash-movement", key: key(row) });
const revision = (rows: string[]) => ({
  kind: "transfer",
  state: "debited",
  unknownReason: null,
  legs: rows.map((_, index) => ({
    legIndex: index,
    subjectRef: `account:acct_synthetic_${index}`,
    role: index === 0 ? "decrease" : "increase",
    basis: "cash-movement",
    source: { kind: "transaction", id: String(index + 1), revision: "parse_run:1" },
  })),
  claims: rows.map(claim),
});
const PAYLOADS: Record<EconomicEventCommandKind, Record<string, unknown>> = {
  "economic-event.adopt": { family: "bank-movement", proposalId: "proposal-synthetic-1", reason },
  "economic-event.correct": {
    family: "bank-movement",
    eventId: "transfer-synthetic-1",
    priorRevision: 1,
    revision: revision(["row-1", "row-2"]),
    releasedClaims: [claim("row-3")],
    reason,
  },
  "economic-event.withdraw": {
    family: "bank-movement",
    eventId: "transfer-synthetic-1",
    revision: 2,
    decisionRevisionId: "decision-synthetic-adopting",
    reason,
  },
  "economic-event.move": {
    family: "bank-movement",
    claim: claim("row-2"),
    from: { eventId: "transfer-synthetic-1", priorRevision: 1, revision: revision(["row-1"]) },
    to: { eventId: "transfer-synthetic-2", priorRevision: 1, revision: revision(["row-2"]) },
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
/** An agent that somehow carries the accepting capability is still an agent. */
const overGrantedAgent: Principal = {
  ...agent,
  id: "agent-over-granted",
  capabilities: human.capabilities,
};
const PRINCIPALS = [human, agent, overGrantedAgent];
const now = "2026-10-09T00:00:00.000Z";
const later = "2026-10-09T01:00:00.000Z";
const COUNTED = [
  "change_plans",
  "approvals",
  "operation_receipts",
  "decision_outbox",
  "decision_revisions",
  "economic_event_revisions",
  "economic_claims",
  "economic_revision_seals",
  "economic_commit_log",
];
function counts(db: ReturnType<typeof migratedDatabase>) {
  return Object.fromEntries(
    COUNTED.map((table) => [
      table,
      (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}
/**
 * A writer that would write: one well-formed decision revision. It is what
 * a writer slot filled before its planner would hand the commit (the review
 * probe); `commit` must refuse before it runs.
 */
const writingMutation = (id: string) => async () => ({
  writes: [
    {
      sql: `INSERT INTO decision_revisions VALUES(?1,'relation',?2,1,'accept','manual','operator',NULL,
        'synthetic probe','[]',NULL,NULL,?3)`,
      binds: [id, `relation-${id}`, now],
    },
  ],
  decisionRevisionId: id,
  result: {},
});
const unsupported = (kind: string) => ({
  ok: false as const,
  error: "unsupported_semantics" as const,
  refs: [kind],
});

describe("the economic-event kinds are vocabulary only", () => {
  test("they are change kinds, the reserved resolution kind is not, and no planner is registered", () => {
    expect(CHANGE_KINDS.slice(-4)).toEqual([...ECONOMIC_EVENT_COMMAND_KINDS]);
    for (const kind of ECONOMIC_EVENT_COMMAND_KINDS) expect(isChangeKind(kind)).toBe(true);
    expect(isChangeKind(IDENTITY_RESOLUTION_KIND)).toBe(false);
    expect(Object.keys(ECONOMIC_EVENT_PLANNERS)).toEqual([]);
    for (const kind of ECONOMIC_EVENT_COMMAND_KINDS)
      expect(validPayload(kind, PAYLOADS[kind])).toBe(true);
  });

  test("the probe writer's statement is valid: run on its own it writes its row", async () => {
    const db = migratedDatabase();
    try {
      const mutation = await writingMutation("decision-probe-valid")();
      await sqliteCommandStore(db).batch(mutation.writes);
      expect(
        db
          .query("SELECT count(*) AS n FROM decision_revisions WHERE id='decision-probe-valid'")
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  test("planning the reserved resolution kind is refused as an unknown kind", async () => {
    const db = migratedDatabase();
    try {
      const before = counts(db);
      for (const actor of PRINCIPALS)
        expect(
          await createPlan(
            IDENTITY_RESOLUTION_KIND,
            { family: "bank-movement", reason },
            { actor, baseContextId: "context", now, ttlSeconds: 900 },
            sqliteCommandStore(db),
          ),
        ).toEqual({ ok: false, error: "unsupported_semantics" });
      expect(counts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  for (const kind of ECONOMIC_EVENT_COMMAND_KINDS)
    test(`${kind}: no principal can plan it, and a malformed payload is still invalid_command`, async () => {
      const db = migratedDatabase();
      try {
        const store = sqliteCommandStore(db);
        const before = counts(db);
        for (const actor of PRINCIPALS) {
          expect(
            await createPlan(
              kind,
              PAYLOADS[kind],
              { actor, baseContextId: "context", now, ttlSeconds: 900 },
              store,
            ),
          ).toEqual(unsupported(kind));
          // A malformed payload is refused as such, before the missing planner.
          expect(
            await createPlan(
              kind,
              { ...PAYLOADS[kind], amount: "1" },
              { actor, baseContextId: "context", now, ttlSeconds: 900 },
              store,
            ),
          ).toMatchObject({ ok: false, error: "invalid_command" });
        }
        expect(await resolveAndSimulate(store, kind, PAYLOADS[kind] as never)).toEqual(
          unsupported(kind),
        );
        expect(counts(db)).toEqual(before);
      } finally {
        db.close();
      }
    });

  for (const [index, kind] of ECONOMIC_EVENT_COMMAND_KINDS.entries())
    test(`${kind}: a plan row that reached the table any other way is never approved or committed`, async () => {
      const db = migratedDatabase();
      try {
        const store = sqliteCommandStore(db);
        // The schema admits the kind (0071); the lifecycle still refuses it.
        const planId = (index + 1).toString(16).padStart(64, "0");
        db.run(`INSERT INTO change_plans VALUES(?,?,?,'context','{}',?,'operator',?,?,'planned')`, [
          planId,
          kind,
          JSON.stringify(PAYLOADS[kind]),
          JSON.stringify({ kind, targets: [], outboxTargets: ["agent-notify"] }),
          now,
          later,
        ]);
        const plan = await loadPlan(store, planId);
        if (!plan) throw new Error("plan not stored");
        const before = counts(db);
        expect(await simulate(plan, store)).toEqual(unsupported(kind));
        const approvalOf = (actor: Principal) =>
          approve(store, { planId, planDigest: planId, actor, scope: [], ttlSeconds: 600, now });
        expect(await approvalOf(human)).toEqual(unsupported(kind));
        for (const actor of [agent, overGrantedAgent])
          expect(await approvalOf(actor)).toEqual({ ok: false, error: "approval_required" });
        expect(counts(db)).toEqual(before);
        // Even with an approval row planted beside it, nothing commits.
        db.run(
          "INSERT INTO approvals VALUES('approval-planted',?,?,'operator','server','[]',?,1,?)",
          [planId, planId, later, now],
        );
        const planted = counts(db);
        // An empty slot, no slot, and a slot whose writer would write: the
        // commit checks the planner before any writer runs.
        for (const planners of [
          { [kind]: async () => null },
          {},
          { [kind]: writingMutation(`decision-probe-${index}`) },
        ])
          expect(
            await commit(store, {
              operationId: `op-${index}`,
              principal: human,
              planId,
              approvalId: "approval-planted",
              planners,
              now,
            }),
          ).toEqual(unsupported(kind));
        for (const actor of [agent, overGrantedAgent])
          expect(
            await commit(store, {
              operationId: `op-${index}-agent`,
              principal: actor,
              planId,
              approvalId: "approval-planted",
              planners: { [kind]: writingMutation(`decision-probe-agent-${index}`) },
              now,
            }),
          ).toEqual({ ok: false, error: "approval_required" });
        expect(counts(db)).toEqual(planted);
        expect(
          (
            db.query("SELECT status FROM change_plans WHERE plan_id=?").get(planId) as {
              status: string;
            }
          ).status,
        ).toBe("planned");
        expect(
          (
            db
              .query("SELECT uses_remaining FROM approvals WHERE approval_id='approval-planted'")
              .get() as {
              uses_remaining: number;
            }
          ).uses_remaining,
        ).toBe(1);
      } finally {
        db.close();
      }
    });
});

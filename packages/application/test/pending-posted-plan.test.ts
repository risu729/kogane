// Reviewing a pending-to-posted card usage link through the change lifecycle
// (src/operations/pending-posted-review.ts): plan, simulate, approve and
// commit of `relation.accept` / `relation.reject` with the
// `reconciliation-proposal:<id>` marker, on every CORE migration with the
// purchases written by the guarded recognition builder. Accepting merges the
// two events into one purchase; withdrawing splits them again. Synthetic
// values only.
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CardPurchaseCandidate } from "../../domain/src/card-purchase-view.ts";
import type { SourceFactRef } from "../../domain/src/events.ts";
import { pendingPostedMarker } from "../../domain/src/pending-posted-review.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import type {
  BatchOutcome,
  ChangeKind,
  CommandStore,
  MutationPlanners,
  PreparedWrite,
  Principal,
  RelationPayload,
} from "../src/command/contract.ts";
import { createPlan } from "../src/command/plan.ts";
import { simulate } from "../src/command/simulate.ts";
import { relationMutation } from "../src/operations/relation-writes.ts";
import { queryCardPurchases } from "../src/query/card-purchases.ts";
import { PurchaseWorld } from "./card-purchase-world.ts";
import { sqliteCommandStore } from "./sqlite-store.ts";

const OPERATOR: Principal = {
  id: "operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const AGENT: Principal = {
  id: "agent",
  kind: "agent",
  verification: "server",
  capabilities: ["interpretation.propose"],
};
const PLANNERS: MutationPlanners = {
  "relation.accept": relationMutation,
  "relation.reject": relationMutation,
};
const jpy = (amount: number) => exactQuantity("JPY", integerDecimal(amount), "decimal-v1");
const T0 = "2026-09-24T01:00:00.000Z";
const T1 = "2026-09-24T01:10:00.000Z";
const T2 = "2026-09-24T01:20:00.000Z";

const worlds: PurchaseWorld[] = [];
afterEach(() => {
  for (const created of worlds.splice(0)) created.close();
});

/** Rows of every table a review writes, pointers included. */
function snapshot(db: Database): Record<string, unknown> {
  return Object.fromEntries(
    [
      "decision_operations",
      "decision_revisions",
      "entity_relations",
      "reconciliation_proposals",
      "economic_event_revisions",
      "economic_legs",
      "card_purchase_recognitions",
      "card_purchase_recognition_keys",
      "operation_receipts",
      "decision_outbox",
    ].map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY 1`).all()]),
  );
}

const refOf = (fact: { observationId: number; parseRunId: number }): SourceFactRef => ({
  kind: "transaction",
  id: `transaction:${fact.observationId}`,
  revision: `parse_run:${fact.parseRunId}`,
});

let proposals = 0;
/** A stage-B candidate the way the matcher writes one (pending first), status `proposed`. */
function propose(w: PurchaseWorld, pending: SourceFactRef, posted: SourceFactRef): string {
  proposals += 1;
  const digest = proposals.toString(16).padStart(64, "0");
  const id = `rp_${digest}`;
  w.run(
    `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,
      rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
     VALUES(?,'pending_to_posted','B',?,'rule','reconciliation-rules-v1',?,?,?,'proposed',NULL,?,?)`,
    id,
    JSON.stringify([pending, posted]),
    JSON.stringify([
      "status_pending_to_posted",
      "same_identifier_namespace",
      "same_source_account",
      "no_provider_link_id",
      "same_statement_period",
    ]),
    JSON.stringify(["provider_link_absent", "amount_differs", "candidate_not_unique"]),
    JSON.stringify([pending.id, posted.id]),
    digest,
    T0,
  );
  return id;
}

interface Scenario {
  w: PurchaseWorld;
  pendingEvent: string;
  postedEvent: string;
  proposalId: string;
  pending: SourceFactRef;
  posted: SourceFactRef;
}

/**
 * A MyJCB pending authorisation of 1,200 that has left the provider's display
 * (retired), and the posted charge of 1,234, each its own recognised event. A
 * Vpass pending row is not recognised until the meaning of its payment-type
 * field (`bunkatsuYaku`) is verified, so the Vpass pending side is not
 * exercised here yet.
 */
async function scenario(options: { retirePending?: boolean } = {}): Promise<Scenario> {
  const w = new PurchaseWorld();
  worlds.push(w);
  const pendingFact = w.usage({
    source: "myjcb",
    externalId: "myjcb-credit-ledger:unconfirmed:row-p:0",
    status: "unconfirmed",
    amount: -1200,
    usageDate: "2026-08-20",
  });
  const postedFact = w.usage({
    source: "myjcb",
    externalId: "myjcb-credit-ledger:confirmed:row-q:0",
    status: "posted",
    amount: -1234,
    usageDate: "2026-08-21",
  });
  const pendingEvent = await w.recognise(pendingFact);
  if (options.retirePending ?? true) await w.retire(pendingEvent);
  const postedEvent = await w.recognise(postedFact);
  const pending = refOf(pendingFact);
  const posted = refOf(postedFact);
  return {
    w,
    pendingEvent,
    postedEvent,
    proposalId: propose(w, pending, posted),
    pending,
    posted,
  };
}

async function candidateOf(s: Scenario, eventId: string): Promise<CardPurchaseCandidate> {
  const page = await queryCardPurchases(s.w.sql, { eventId });
  const found = page.items[0]?.candidates.find((entry) => entry.proposalId === s.proposalId);
  if (!found) throw new Error("candidate not listed");
  return found;
}

function payloadOf(candidate: CardPurchaseCandidate, reason: string): RelationPayload {
  return { ...candidate.relation, reason };
}

async function planned(s: Scenario, kind: ChangeKind, payload: RelationPayload, now = T0) {
  const result = await createPlan(
    kind,
    payload,
    {
      actor: OPERATOR,
      baseContextId: `card-purchase-link:${s.proposalId}`,
      now,
      ttlSeconds: 3600,
    },
    sqliteCommandStore(s.w.db),
  );
  if (!result.ok) throw new Error(`plan refused: ${result.error}`);
  return result.plan;
}

async function approved(s: Scenario, planId: string, planDigest: string, now = T0) {
  const result = await approve(sqliteCommandStore(s.w.db), {
    planId,
    planDigest,
    actor: OPERATOR,
    scope: [],
    ttlSeconds: 3600,
    now,
  });
  if (!result.ok) throw new Error(`approval refused: ${result.error}`);
  return result.approval;
}

async function committed(s: Scenario, kind: ChangeKind, payload: RelationPayload, now: string) {
  const plan = await planned(s, kind, payload, now);
  const approval = await approved(s, plan.planId, plan.planDigest, now);
  const result = await commit(sqliteCommandStore(s.w.db), {
    operationId: `op-${kind}-${now}`,
    principal: OPERATOR,
    planId: plan.planId,
    approvalId: approval.approvalId,
    planners: PLANNERS,
    now,
  });
  return { plan, approval, result };
}

/** Captured and authorized JPY figures of the whole store, from the query's own summary. */
async function totals(s: Scenario) {
  const page = await queryCardPurchases(s.w.sql);
  const jpy = page.summary.units.find((unit) => unit.unitRef === "JPY");
  const text = (value: unknown) =>
    (value as { value: { status: string; value?: { coefficient: string } } }).value.value
      ?.coefficient ?? "0";
  return {
    captured: jpy ? text(jpy.captured) : "0",
    authorized: jpy ? text(jpy.authorized) : "0",
    unresolved: page.summary.unresolved,
    events: page.summary.events,
  };
}

function revisions(db: Database, eventId: string) {
  return db
    .query(
      `SELECT r.revision,r.state,r.unknown_reason,r.superseded_by,c.action,
        (SELECT group_concat(k.role,',') FROM card_purchase_recognition_keys k
          WHERE k.event_id=r.event_id AND k.revision=r.revision) AS roles,
        (SELECT group_concat(l.coefficient,',') FROM economic_legs l
          WHERE l.event_id=r.event_id AND l.revision=r.revision) AS legs
       FROM economic_event_revisions r JOIN card_purchase_recognitions c
         ON c.event_id=r.event_id AND c.revision=r.revision
       WHERE r.event_id=? ORDER BY r.revision`,
    )
    .all(eventId);
}

describe("pending-to-posted review", () => {
  test("the purchase view lists the candidate with the exact payload and pins to plan", async () => {
    const s = await scenario();
    for (const eventId of [s.pendingEvent, s.postedEvent]) {
      const page = await queryCardPurchases(s.w.sql, { eventId });
      const item = page.items[0]!;
      expect(item.explanationRefs).toContain(`proposal:${s.proposalId}`);
      expect(item.candidates).toEqual([
        {
          proposalId: s.proposalId,
          proposalStatus: "proposed",
          proposalRevision: 0,
          relationStatus: null,
          relationRevision: 0,
          providerLinked: false,
          rationaleCodes: [
            "status_pending_to_posted",
            "same_identifier_namespace",
            "same_source_account",
            "no_provider_link_id",
            "same_statement_period",
          ],
          rejectionConditions: ["provider_link_absent", "amount_differs", "candidate_not_unique"],
          pending: {
            ref: s.pending,
            eventId: s.pendingEvent,
            revision: 2,
            state: "unknown",
            displayedAmount: jpy(-1200),
            usageDate: "2026-08-20",
          },
          posted: {
            ref: s.posted,
            eventId: s.postedEvent,
            revision: 1,
            state: "captured",
            displayedAmount: jpy(-1234),
            usageDate: "2026-08-21",
          },
          actions: ["accept", "reject"],
          blockers: [],
          relation: {
            relationKind: "pending_to_posted",
            fromRef: s.pending.id,
            toRef: s.posted.id,
            validFrom: null,
            validTo: null,
            evidenceRefs: [
              pendingPostedMarker(s.proposalId),
              `${s.pending.id}@${s.pending.revision}`,
              `${s.posted.id}@${s.posted.revision}`,
            ],
          },
        },
      ]);
    }
  });

  test("accept merges one purchase authorized → captured; withdraw splits it, history kept", async () => {
    const s = await scenario();
    const before = await totals(s);
    expect(before).toEqual({ captured: "1234", authorized: "0", unresolved: 1, events: 2 });
    const candidate = await candidateOf(s, s.postedEvent);
    const accept = await committed(s, "relation.accept", payloadOf(candidate, "same purchase"), T0);
    // The plan pinned the proposal, the relation and both events.
    expect(accept.plan.expectedRevisions).toEqual({
      [`relation:pending_to_posted|${s.pending.id}|${s.posted.id}`]: 0,
      [`proposal:${s.proposalId}`]: 0,
      [`card-purchase:${s.pendingEvent}`]: 2,
      [`card-purchase:${s.postedEvent}`]: 1,
    });
    expect(accept.plan.simulation.invalidations).toContain("review:card-purchase-link");
    expect(accept.plan.simulation.targets.map((target) => target.subjectRef).sort()).toEqual(
      Object.keys(accept.plan.expectedRevisions).sort(),
    );
    expect(accept.result).toMatchObject({ ok: true, replayed: false });
    if (!accept.result.ok) throw new Error("unreachable");
    expect(accept.result.receipt.result).toMatchObject({
      proposalId: s.proposalId,
      review: "accept",
      eventRevisions: [`event:${s.pendingEvent}@3`],
    });

    // One purchase: the pending-origin event survives, captured, holding both keys.
    expect(revisions(s.w.db, s.pendingEvent)).toEqual([
      {
        revision: 1,
        state: "authorized",
        unknown_reason: null,
        superseded_by: `${s.pendingEvent}@2`,
        action: "recognize",
        roles: "pending",
        legs: "1200",
      },
      {
        revision: 2,
        state: "unknown",
        unknown_reason: "provider_status_absent",
        superseded_by: `${s.pendingEvent}@3`,
        action: "retire",
        roles: "pending",
        legs: null,
      },
      {
        revision: 3,
        state: "captured",
        unknown_reason: null,
        superseded_by: null,
        action: "merge",
        roles: expect.stringMatching(/^(posted,pending|pending,posted)$/u),
        legs: "1234",
      },
    ]);
    // The posted event's live revision is superseded across ids.
    expect(revisions(s.w.db, s.postedEvent)).toEqual([
      {
        revision: 1,
        state: "captured",
        unknown_reason: null,
        superseded_by: `${s.pendingEvent}@3`,
        action: "recognize",
        roles: "posted",
        legs: "1234",
      },
    ]);
    expect(await totals(s)).toEqual({
      captured: "1234",
      authorized: "0",
      unresolved: 0,
      events: 1,
    });
    // The judgement: a manual decision on the proposal, the proposal resolved by it.
    const proposal = s.w.db
      .query("SELECT status,decision_revision_id FROM reconciliation_proposals WHERE id=?")
      .get(s.proposalId) as { status: string; decision_revision_id: string };
    expect(proposal.status).toBe("accepted");
    expect(
      s.w.db
        .query(
          "SELECT subject_ref,revision,decision_kind,method,actor_id FROM decision_revisions WHERE id=?",
        )
        .get(proposal.decision_revision_id),
    ).toEqual({
      subject_ref: `proposal:${s.proposalId}`,
      revision: 1,
      decision_kind: "accept",
      method: "manual",
      actor_id: OPERATOR.id,
    });
    // The event decision is the operator's, keyed by the operation.
    expect(
      s.w.db
        .query(
          `SELECT d.method,d.actor_id,d.operation_id,d.decision_kind,d.reason FROM economic_event_revisions r
           JOIN decision_revisions d ON d.id=r.decision_revision_id WHERE r.event_id=? AND r.revision=3`,
        )
        .get(s.pendingEvent),
    ).toEqual({
      method: "manual",
      actor_id: OPERATOR.id,
      operation_id: `op-relation.accept-${T0}`,
      decision_kind: "supersede",
      reason: "card-purchase-recognition-v1:merge",
    });
    // Posted evidence first, then the pending row.
    const evidence = s.w.db
      .query(
        "SELECT evidence_support_json AS e FROM economic_event_revisions WHERE event_id=? AND revision=3",
      )
      .get(s.pendingEvent) as { e: string };
    expect(JSON.parse(evidence.e)).toEqual([s.posted, s.pending]);

    // A resend of the same commit is the same receipt and writes nothing.
    const frozen = snapshot(s.w.db);
    const resend = await commit(sqliteCommandStore(s.w.db), {
      operationId: `op-relation.accept-${T0}`,
      principal: OPERATOR,
      planId: accept.plan.planId,
      approvalId: accept.approval.approvalId,
      planners: PLANNERS,
      now: T1,
    });
    expect(resend).toMatchObject({ ok: true, replayed: true });
    expect(snapshot(s.w.db)).toEqual(frozen);

    // The merged event now offers the withdrawal.
    const linked = await candidateOf(s, s.pendingEvent);
    expect(linked).toMatchObject({
      proposalStatus: "accepted",
      proposalRevision: 1,
      relationStatus: "accepted",
      relationRevision: 1,
      actions: ["withdraw"],
      pending: { eventId: s.pendingEvent, revision: 3 },
      posted: { eventId: s.pendingEvent, revision: 3 },
    });
    const page = await queryCardPurchases(s.w.sql, { eventId: s.pendingEvent });
    expect(page.items[0]!.sourceRows.map((row) => row.role)).toEqual(["posted", "pending"]);

    const withdraw = await committed(
      s,
      "relation.reject",
      payloadOf(linked, "not the same purchase"),
      T1,
    );
    expect(withdraw.plan.expectedRevisions).toEqual({
      [`relation:pending_to_posted|${s.pending.id}|${s.posted.id}`]: 1,
      [`proposal:${s.proposalId}`]: 1,
      [`card-purchase:${s.pendingEvent}`]: 3,
      [`card-purchase:${s.postedEvent}`]: 0,
    });
    expect(withdraw.result).toMatchObject({ ok: true, replayed: false });
    // Two live single-key events again; every earlier revision kept.
    expect(revisions(s.w.db, s.pendingEvent).at(-1)).toEqual({
      revision: 4,
      state: "unknown",
      unknown_reason: "conflicting_evidence",
      superseded_by: null,
      action: "retire",
      roles: "pending",
      legs: null,
    });
    expect(revisions(s.w.db, s.pendingEvent)).toHaveLength(4);
    expect(revisions(s.w.db, s.postedEvent)).toEqual([
      {
        revision: 1,
        state: "captured",
        unknown_reason: null,
        superseded_by: `${s.pendingEvent}@3`,
        action: "recognize",
        roles: "posted",
        legs: "1234",
      },
      {
        revision: 2,
        state: "captured",
        unknown_reason: null,
        superseded_by: null,
        action: "split",
        roles: "posted",
        legs: "1234",
      },
    ]);
    expect(await totals(s)).toEqual({
      captured: "1234",
      authorized: "0",
      unresolved: 1,
      events: 2,
    });
    // The withdrawal supersedes the accepting decision; the proposal row stays resolved once.
    expect(
      s.w.db
        .query(
          "SELECT revision,decision_kind,superseded_by IS NOT NULL AS superseded FROM decision_revisions WHERE subject_ref=? ORDER BY revision",
        )
        .all(`proposal:${s.proposalId}`),
    ).toEqual([
      { revision: 1, decision_kind: "accept", superseded: 1 },
      { revision: 2, decision_kind: "supersede", superseded: 0 },
    ]);
    const closed = await candidateOf(s, s.postedEvent);
    expect(closed).toMatchObject({
      proposalStatus: "accepted",
      proposalRevision: 2,
      relationStatus: "rejected",
      relationRevision: 2,
      actions: [],
      blockers: ["proposal_closed"],
    });
  });

  test("a pending event still authorized merges authorized → captured", async () => {
    const s = await scenario({ retirePending: false });
    expect(await totals(s)).toEqual({
      captured: "1234",
      authorized: "1200",
      unresolved: 0,
      events: 2,
    });
    const { result } = await committed(
      s,
      "relation.accept",
      payloadOf(await candidateOf(s, s.pendingEvent), "same purchase"),
      T0,
    );
    expect(result).toMatchObject({ ok: true });
    expect(
      revisions(s.w.db, s.pendingEvent).map((row) => (row as { state: string }).state),
    ).toEqual(["authorized", "captured"]);
    // The authorisation became the capture: authorized no longer holds it apart.
    expect(await totals(s)).toEqual({
      captured: "1234",
      authorized: "0",
      unresolved: 0,
      events: 1,
    });
  });

  test("a reject plan names the holders, records the decision and moves no event", async () => {
    const s = await scenario();
    const candidate = await candidateOf(s, s.postedEvent);
    const events = revisions(s.w.db, s.pendingEvent).concat(revisions(s.w.db, s.postedEvent));
    const { plan, result } = await committed(
      s,
      "relation.reject",
      payloadOf(candidate, "different purchase"),
      T0,
    );
    expect(plan.expectedRevisions).toEqual({
      [`relation:pending_to_posted|${s.pending.id}|${s.posted.id}`]: 0,
      [`proposal:${s.proposalId}`]: 0,
      [`card-purchase:${s.pendingEvent}`]: 2,
      [`card-purchase:${s.postedEvent}`]: 1,
    });
    expect(plan.simulation.targets.map((target) => target.subjectRef).sort()).toEqual(
      Object.keys(plan.expectedRevisions).sort(),
    );
    expect(plan.simulation.invalidations).toContain("review:card-purchase-link");
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(revisions(s.w.db, s.pendingEvent).concat(revisions(s.w.db, s.postedEvent))).toEqual(
      events,
    );
    expect(
      s.w.db.query("SELECT status FROM reconciliation_proposals WHERE id=?").get(s.proposalId),
    ).toEqual({ status: "rejected" });
    expect(await candidateOf(s, s.postedEvent)).toMatchObject({
      proposalStatus: "rejected",
      relationStatus: "rejected",
      actions: [],
      blockers: ["proposal_closed"],
    });
  });

  test("a stale event revision or a proposal decided elsewhere writes nothing", async () => {
    const s = await scenario();
    const payload = payloadOf(await candidateOf(s, s.postedEvent), "same purchase");
    const plan = await planned(s, "relation.accept", payload);
    const approval = await approved(s, plan.planId, plan.planDigest);
    // The recognition lane revises the posted event (its row was corrected).
    await s.w.revise(
      s.postedEvent,
      s.w.usage({
        source: "myjcb",
        externalId: "myjcb-credit-ledger:confirmed:row-q:0",
        status: "posted",
        amount: -1300,
        usageDate: "2026-08-21",
      }),
    );
    const frozen = snapshot(s.w.db);
    const stale = await commit(sqliteCommandStore(s.w.db), {
      operationId: "op-stale-event",
      principal: OPERATOR,
      planId: plan.planId,
      approvalId: approval.approvalId,
      planners: PLANNERS,
      now: T1,
    });
    expect(stale).toMatchObject({ ok: false, error: "stale_context" });
    expect(snapshot(s.w.db)).toEqual(frozen);

    // A fresh plan pins the new revision; the proposal is then decided elsewhere.
    const fresh = await planned(s, "relation.accept", payload, T1);
    const freshApproval = await approved(s, fresh.planId, fresh.planDigest, T1);
    s.w.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr_elsewhere','relation',?,1,'reject','manual','someone',NULL,'x','[]',NULL,NULL,?)`,
      `proposal:${s.proposalId}`,
      T1,
    );
    s.w.run(
      "UPDATE reconciliation_proposals SET status='rejected',decision_revision_id='dr_elsewhere' WHERE id=?",
      s.proposalId,
    );
    const decided = snapshot(s.w.db);
    const refused = await commit(sqliteCommandStore(s.w.db), {
      operationId: "op-stale-proposal",
      principal: OPERATOR,
      planId: fresh.planId,
      approvalId: freshApproval.approvalId,
      planners: PLANNERS,
      now: T2,
    });
    expect(refused).toMatchObject({ ok: false, error: "stale_context" });
    expect(snapshot(s.w.db)).toEqual(decided);
  });

  test("approval moves with the pins: a revision that moved after planning is refused at approval", async () => {
    const s = await scenario();
    const plan = await planned(
      s,
      "relation.accept",
      payloadOf(await candidateOf(s, s.postedEvent), "same purchase"),
    );
    await s.w.retire(s.postedEvent);
    const report = await simulate(plan, sqliteCommandStore(s.w.db));
    // The candidate can no longer be accepted: re-simulation names why.
    expect(report).toMatchObject({ ok: false, error: "stale_context" });
    const refused = await approve(sqliteCommandStore(s.w.db), {
      planId: plan.planId,
      planDigest: plan.planDigest,
      actor: OPERATOR,
      scope: [],
      ttlSeconds: 600,
      now: T1,
    });
    expect(refused).toMatchObject({ ok: false, error: "stale_context" });
  });

  test("an agent can plan but never approve or commit a link review", async () => {
    const s = await scenario();
    const payload = payloadOf(await candidateOf(s, s.postedEvent), "same purchase");
    const store = sqliteCommandStore(s.w.db);
    const plan = await createPlan(
      "relation.accept",
      payload,
      {
        actor: AGENT,
        baseContextId: `card-purchase-link:${s.proposalId}`,
        now: T0,
        ttlSeconds: 900,
      },
      store,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(
      await approve(store, {
        planId: plan.plan.planId,
        planDigest: plan.plan.planDigest,
        actor: AGENT,
        scope: [],
        ttlSeconds: 600,
        now: T0,
      }),
    ).toMatchObject({ ok: false, error: "approval_required" });
    const approval = await approved(s, plan.plan.planId, plan.plan.planDigest);
    const frozen = snapshot(s.w.db);
    expect(
      await commit(store, {
        operationId: "op-agent",
        principal: AGENT,
        planId: plan.plan.planId,
        approvalId: approval.approvalId,
        planners: PLANNERS,
        now: T0,
      }),
    ).toMatchObject({ ok: false, error: "approval_required" });
    expect(snapshot(s.w.db)).toEqual(frozen);
  });

  test("a payload the proposal does not give is refused at planning", async () => {
    const s = await scenario();
    const candidate = await candidateOf(s, s.postedEvent);
    const store = sqliteCommandStore(s.w.db);
    const plan = (kind: ChangeKind, payload: RelationPayload) =>
      createPlan(
        kind,
        payload,
        { actor: OPERATOR, baseContextId: "x", now: T0, ttlSeconds: 900 },
        store,
      );
    const base = payloadOf(candidate, "same purchase");
    // No marker: a bare pending_to_posted relation would claim the link without the events.
    expect(
      await plan("relation.accept", { ...base, evidenceRefs: base.evidenceRefs.slice(1) }),
    ).toMatchObject({
      ok: false,
      error: "invalid_command",
    });
    // The historical double-prefixed end is not the proposal's.
    expect(
      await plan("relation.accept", { ...base, fromRef: `transaction:${s.pending.id}` }),
    ).toMatchObject({ ok: false, error: "invalid_command" });
    expect(
      await plan("relation.accept", { ...base, evidenceRefs: base.evidenceRefs.slice(0, 2) }),
    ).toMatchObject({ ok: false, error: "incomplete_evidence" });
    expect(
      await plan("relation.accept", {
        ...base,
        evidenceRefs: [pendingPostedMarker("rp_absent"), ...base.evidenceRefs.slice(1)],
      }),
    ).toMatchObject({ ok: false, error: "target_missing" });
    // The marker on another relation kind is refused.
    expect(await plan("relation.accept", { ...base, relationKind: "supersedes" })).toMatchObject({
      ok: false,
      error: "invalid_command",
    });
  });

  test("every event of a page lists its own candidates, however many another event has", async () => {
    const s = await scenario();
    // After the pair's proposal, a busy month pairs the pending row with 205
    // other posted rows: newer proposals than the pair's, all naming the
    // pending event, one of them with the date and the amount in common.
    const rows: [string, string, string, string][] = [];
    for (let index = 0; index < 205; index += 1) {
      const posted = {
        kind: "transaction",
        id: `transaction:${900_000 + index}`,
        revision: "parse_run:1",
      };
      const close = index === 150;
      rows.push([
        `rp_busy_${index}`,
        JSON.stringify([s.pending, posted]),
        JSON.stringify([
          "status_pending_to_posted",
          "same_identifier_namespace",
          "same_source_account",
          "no_provider_link_id",
          "same_statement_period",
          ...(close ? ["date_within_window", "amount_equal"] : []),
          "multiple_candidates",
        ]),
        (0xb000 + index).toString(16).padStart(64, "0"),
      ]);
    }
    for (const [id, targets, rationale, digest] of rows)
      s.w.run(
        `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,
          rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
         VALUES(?,'pending_to_posted','B',?,'rule','reconciliation-rules-v1',?,'[]','[]','proposed',NULL,?,?)`,
        id,
        targets,
        rationale,
        digest,
        T1,
      );
    const page = await queryCardPurchases(s.w.sql);
    const listed = (eventId: string) =>
      page.items
        .find((item) => item.eventId === eventId)!
        .candidates.map((entry) => entry.proposalId);
    // The posted event still lists the pair's own proposal.
    expect(listed(s.postedEvent)).toEqual([s.proposalId]);
    // The pending event lists 10, newest first, the likely pair of that tick first.
    const pending = listed(s.pendingEvent);
    expect(pending).toHaveLength(10);
    expect(pending[0]).toBe("rp_busy_150");
    expect(pending).not.toContain(s.proposalId);
  });

  test("concurrent commits: a resend of the operation writes nothing more, another operation nothing at all", async () => {
    const s = await scenario();
    const payload = payloadOf(await candidateOf(s, s.postedEvent), "same purchase");
    const plan = await planned(s, "relation.accept", payload);
    const approval = await approved(s, plan.planId, plan.planDigest);
    // Every commit reads, plans its merge and builds its batch before any of
    // them writes; the batches then run one after another, in a chosen order.
    const inner = sqliteCommandStore(s.w.db);
    const held = new Map<number, () => void>();
    // Each attempt's first batch (its commit batch) waits to be released.
    const attempt = (index: number, operationId: string) => {
      const store: CommandStore = {
        ...inner,
        batch: (writes: readonly PreparedWrite[]) =>
          held.has(index)
            ? inner.batch(writes)
            : new Promise<readonly BatchOutcome[]>((resolve, reject) => {
                expect(writes[0]!.binds[0]).toBe(operationId);
                held.set(index, () => void inner.batch(writes).then(resolve, reject));
              }),
      };
      return commit(store, {
        operationId,
        principal: OPERATOR,
        planId: plan.planId,
        approvalId: approval.approvalId,
        planners: PLANNERS,
        now: T1,
      });
    };
    const results = [attempt(0, "op-race"), attempt(1, "op-race"), attempt(2, "op-race-other")];
    while (held.size < 3) await new Promise((resolve) => setTimeout(resolve, 1));
    const release = (index: number) => {
      held.get(index)!();
      return results[index]!;
    };
    expect(await release(0)).toMatchObject({ ok: true, replayed: false });
    const once = snapshot(s.w.db);
    expect(revisions(s.w.db, s.pendingEvent)).toHaveLength(3);
    // The same operation's batch finds its own rows (every id is keyed by the
    // operation) and replays the receipt; another operation's batch finds the
    // plan committed and writes nothing, whatever its own statements are.
    expect(await release(1)).toMatchObject({ ok: true, replayed: true });
    expect(await release(2)).toMatchObject({ ok: false });
    expect(snapshot(s.w.db)).toEqual(once);
    expect(revisions(s.w.db, s.pendingEvent)).toHaveLength(3);
    expect(
      s.w.db
        .query("SELECT count(*) AS n FROM decision_revisions WHERE subject_ref=?")
        .get(`proposal:${s.proposalId}`),
    ).toEqual({ n: 1 });
  });

  test("a bare pending_to_posted plan stored before the review existed never commits", async () => {
    const s = await scenario();
    const payload = payloadOf(await candidateOf(s, s.postedEvent), "same purchase");
    const bare: RelationPayload = { ...payload, evidenceRefs: payload.evidenceRefs.slice(1) };
    // The plan and its approval as an older build stored them: no marker.
    const planId = "b".repeat(64);
    const subject = `relation:pending_to_posted|${bare.fromRef}|${bare.toRef}`;
    s.w.run(
      `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
       VALUES(?,'relation.accept',?,'x',?,?,?,?,?,'planned')`,
      planId,
      JSON.stringify(bare),
      JSON.stringify({ [subject]: 0 }),
      JSON.stringify({ outboxTargets: ["identity-projection"] }),
      OPERATOR.id,
      T0,
      T2,
    );
    s.w.run(
      `INSERT INTO approvals(approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at)
       VALUES('approval-bare',?,?,?,'server','[]',?,1,?)`,
      planId,
      planId,
      OPERATOR.id,
      T2,
      T0,
    );
    const frozen = snapshot(s.w.db);
    expect(
      await commit(sqliteCommandStore(s.w.db), {
        operationId: "op-bare",
        principal: OPERATOR,
        planId,
        approvalId: "approval-bare",
        planners: PLANNERS,
        now: T1,
      }),
    ).toMatchObject({ ok: false, error: "invalid_command" });
    expect(snapshot(s.w.db)).toEqual(frozen);
  });

  test("what cannot be one purchase is refused, but may still be rejected", async () => {
    const s = await scenario();
    // A posted row of another card account.
    const other = s.w.usage({
      source: "myjcb",
      externalId: "myjcb-credit-ledger:confirmed:row-r:0",
      status: "posted",
      amount: -1200,
      usageDate: "2026-08-20",
      accountId: "acct-card-2",
    });
    await s.w.recognise(other);
    const accountId = propose(s.w, s.pending, refOf(other));
    // An unrecognised posted row.
    const bare = s.w.usage({
      source: "myjcb",
      externalId: "myjcb-credit-ledger:confirmed:row-s:0",
      status: "posted",
      amount: -1200,
    });
    const bareId = propose(s.w, s.pending, refOf(bare));
    const store = sqliteCommandStore(s.w.db);
    const load = async (proposalId: string) => {
      const page = await queryCardPurchases(s.w.sql, { eventId: s.pendingEvent });
      return page.items[0]!.candidates.find((entry) => entry.proposalId === proposalId)!;
    };
    const accounts = await load(accountId);
    expect(accounts).toMatchObject({ actions: ["reject"], blockers: ["account_differs"] });
    const unrecognised = await load(bareId);
    expect(unrecognised).toMatchObject({
      actions: ["reject"],
      blockers: ["row_not_recognized"],
      posted: { eventId: null, revision: null, state: null },
    });
    const plan = (kind: ChangeKind, candidate: CardPurchaseCandidate) =>
      createPlan(
        kind,
        payloadOf(candidate, "review"),
        { actor: OPERATOR, baseContextId: "x", now: T0, ttlSeconds: 900 },
        store,
      );
    expect(await plan("relation.accept", accounts)).toMatchObject({
      ok: false,
      error: "needs_scope_resolution",
    });
    expect(await plan("relation.accept", unrecognised)).toMatchObject({
      ok: false,
      error: "incomplete_evidence",
    });
    const rejected = await plan("relation.reject", unrecognised);
    expect(rejected).toMatchObject({ ok: true });
    if (!rejected.ok) throw new Error("unreachable");
    // Only the side with a live event is pinned.
    expect(Object.keys(rejected.plan.expectedRevisions).sort()).toEqual(
      [
        `card-purchase:${s.pendingEvent}`,
        `proposal:${bareId}`,
        `relation:pending_to_posted|${s.pending.id}|transaction:${bare.observationId}`,
      ].sort(),
    );
  });
});

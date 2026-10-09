// The own-transfer planners (ADR 0057, G3-a) against the migrated CORE schema
// on bun:sqlite, with proposals the pure engine made from stored synthetic rows
// and events written by a synthetic writer (no own-transfer writer ships). They
// are not registered: the lifecycle still refuses every economic-event command.
// Covers the ADR 0054 refusals G3 owns: W5 for `move`, W6's re-adoption, a
// stale identity epoch, alias conflicts, released keys and a proposal not in
// force. Every value is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  aliasClassText,
  economicEventSubject,
  INITIAL_IDENTITY_EPOCH,
} from "../../domain/src/economic-contract.ts";
import type { RestatedRevision } from "../../domain/src/economic-event-commands.ts";
import {
  OWN_TRANSFER_WRITER_RELEASE,
  ownTransferEventId,
  ownTransferProposalRef,
  proposeOwnTransfers,
  transactionRowRef,
  type OwnTransferProposal,
} from "../../domain/src/own-transfer-proposals.ts";
import {
  ownTransferProposalRetirementWrite,
  ownTransferProposalWrite,
} from "../../storage-d1/src/atomic/own-transfer-proposals.ts";
import { decisionEntry, revisionSealWrite } from "../../storage-d1/src/atomic/economic-commit.ts";
import { CURRENT_REVISIONS_SQL, type RevisionRow } from "../../storage-d1/src/core/operations.ts";
import {
  createPlan,
  ECONOMIC_EVENT_COMMAND_KINDS,
  ECONOMIC_EVENT_PLANNERS,
  type ChangePayload,
  type CommandStore,
  type EconomicEventCommandKind,
  type Principal,
  resolveAndSimulate,
  validPayload,
} from "../src/index.ts";
import {
  OWN_TRANSFER_PLANNERS,
  OWN_TRANSFER_PLAN_REFUSALS,
} from "../src/operations/own-transfer-plan.ts";
import {
  accountOf,
  claimOf,
  declareNextEpoch,
  engineRows,
  memberWrites,
  ownership,
  POLICY,
  ROWS,
  seedOwnTransferStore,
  type MemberSpec,
} from "./own-transfer-fixture.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const reason = "Reviewed both rows";
const human: Principal = {
  id: "operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};

interface World {
  db: Database;
  store: CommandStore;
}
function world(): World {
  const db = migratedDatabase();
  seedOwnTransferStore(db);
  return { db, store: sqliteCommandStore(db) };
}

async function write(store: CommandStore, writes: Parameters<CommandStore["batch"]>[0]) {
  return store.batch(writes);
}

/** Run the engine over stored rows and store every proposal it makes. */
async function propose(w: World, ids: number[]): Promise<OwnTransferProposal[]> {
  const run = await proposeOwnTransfers({
    rows: engineRows(w.db, ids),
    ownership,
    policy: POLICY,
    identityEpoch: INITIAL_IDENTITY_EPOCH,
    held: { keys: [], aliasClasses: [] },
  });
  if (!run.ok) throw new Error(run.refusal);
  await write(
    w.store,
    run.proposals.map((proposal) =>
      ownTransferProposalWrite({
        proposal,
        manifest: run.manifest,
        now: "2030-01-10T00:00:00.000Z",
      }),
    ),
  );
  return run.proposals;
}

const plan = (w: World, kind: EconomicEventCommandKind, payload: Record<string, unknown>) =>
  OWN_TRANSFER_PLANNERS[kind](w.store, kind, payload as unknown as ChangePayload);

const adoptPayload = (proposalId: string) => ({ family: "bank-movement", proposalId, reason });

/** Adopt a proposal through the synthetic writer: event rev 1 claiming both rows. */
async function adopt(w: World, proposal: OwnTransferProposal): Promise<string> {
  const eventId = ownTransferEventId(proposal.proposalId);
  await write(
    w.store,
    memberWrites(w.db, [
      { eventId, revision: 1, legs: [proposal.debit.observationId, proposal.credit.observationId] },
    ]),
  );
  return eventId;
}

const restated = (legs: number[]): RestatedRevision => ({
  kind: "transfer",
  state: "credited",
  unknownReason: null,
  legs: legs.map((id, legIndex) => ({
    legIndex,
    subjectRef: `account:${accountOf(ROWS[id]![1])}`,
    role: ROWS[id]![3].startsWith("-") ? "decrease" : "increase",
    basis: "cash-movement",
    source: transactionRowRef(id, ROWS[id]![0]),
  })),
  claims: [],
});

function payloadClaims(w: World, revision: RestatedRevision, ids: number[]): RestatedRevision {
  return { ...revision, claims: ids.map((id) => claimOf(w.db, id)) };
}

function refusalOf(result: Awaited<ReturnType<typeof plan>>) {
  if (result.ok) throw new Error("expected a refusal");
  return { error: result.error, code: result.refs?.[1] };
}

function snapshot(db: Database) {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [table, db.query(`SELECT * FROM "${table}" ORDER BY 1`).all()]),
  );
}

describe("nothing is registered: production behaviour is unchanged", () => {
  test("the lifecycle refuses an in-force proposal's adoption exactly as before G3-a", async () => {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    expect(Object.keys(ECONOMIC_EVENT_PLANNERS)).toEqual([]);
    // The planner would resolve it ...
    expect((await plan(w, "economic-event.adopt", adoptPayload(proposal!.proposalId))).ok).toBe(
      true,
    );
    // ... but the lifecycle does not call it.
    const before = snapshot(w.db);
    expect(
      await resolveAndSimulate(
        w.store,
        "economic-event.adopt",
        adoptPayload(proposal!.proposalId) as ChangePayload,
      ),
    ).toEqual({ ok: false, error: "unsupported_semantics", refs: ["economic-event.adopt"] });
    expect(
      await createPlan(
        "economic-event.adopt",
        adoptPayload(proposal!.proposalId),
        {
          actor: human,
          baseContextId: "ctx-synthetic",
          now: "2030-01-10T00:00:00.000Z",
          ttlSeconds: 900,
        },
        w.store,
      ),
    ).toEqual({ ok: false, error: "unsupported_semantics", refs: ["economic-event.adopt"] });
    expect(snapshot(w.db)).toEqual(before);
  });

  test("one planner per kind; every payload they read is the G2 contract's", () => {
    expect(Object.keys(OWN_TRANSFER_PLANNERS).sort()).toEqual(
      [...ECONOMIC_EVENT_COMMAND_KINDS].sort(),
    );
    expect(validPayload("economic-event.adopt", adoptPayload(`otp_${"0".repeat(64)}`))).toBe(true);
    expect(new Set(OWN_TRANSFER_PLAN_REFUSALS).size).toBe(OWN_TRANSFER_PLAN_REFUSALS.length);
  });
});

describe("economic-event.adopt", () => {
  test("an in-force proposal resolves to a plan that pins the event head at 0; counts only", async () => {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    const result = await plan(w, "economic-event.adopt", adoptPayload(proposal!.proposalId));
    if (!result.ok) throw new Error(result.error);
    const subject = economicEventSubject(ownTransferEventId(proposal!.proposalId));
    expect(result.resolved.expectedRevisions).toEqual({ [subject]: 0 });
    expect(result.resolved.targets).toEqual([
      {
        subjectRef: subject,
        currentRevision: 0,
        currentTargetRef: null,
        proposedTargetRef: ownTransferProposalRef(proposal!.proposalId),
      },
    ]);
    expect(result.resolved.simulation).toMatchObject({
      before: { attributedObservations: 0 },
      after: { attributedObservations: 2 },
      affectedScopes: ["smbc-bank"],
      affectedParseRuns: 1,
    });
    expect(JSON.stringify(result)).not.toContain("1000");
  });

  test("another family, a missing, retired, ambiguous or old-epoch proposal is refused", async () => {
    const w = world();
    expect(
      refusalOf(
        await plan(w, "economic-event.adopt", { ...adoptPayload("x"), family: "card-settlement" }),
      ),
    ).toEqual({
      error: "unsupported_semantics",
      code: "family_unsupported",
    });
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(`otp_${"0".repeat(64)}`))),
    ).toEqual({
      error: "target_missing",
      code: "proposal_missing",
    });
    // One debit, two credits: both proposals need review.
    const ambiguous = await propose(w, [101, 102, 105]);
    expect(ambiguous.map((p) => p.status)).toEqual(["needs_review", "needs_review"]);
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(ambiguous[0]!.proposalId))),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "proposal_needs_review",
    });
    const [clean] = await propose(w, [103, 104]);
    await write(w.store, [
      ownTransferProposalRetirementWrite({
        proposalId: clean!.proposalId,
        reason: "engine_superseded",
        now: "2030-01-11T00:00:00.000Z",
      }),
    ]);
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(clean!.proposalId))),
    ).toEqual({
      error: "stale_context",
      code: "proposal_not_in_force",
    });
  });

  test("a stale identity epoch: the proposal is refused, needs a new proposal", async () => {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    declareNextEpoch(w.db);
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(proposal!.proposalId))),
    ).toEqual({
      error: "stale_context",
      code: "identity_epoch_changed",
    });
  });

  test("evidence that moved, a rekeyed identity and an unrecorded origin are refused", async () => {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    const run = await proposeOwnTransfers({
      rows: engineRows(w.db, [101, 102]),
      ownership,
      policy: POLICY,
      identityEpoch: INITIAL_IDENTITY_EPOCH,
      held: { keys: [], aliasClasses: [] },
    });
    if (!run.ok) throw new Error(run.refusal);
    const store = async (mutated: OwnTransferProposal) => {
      await write(w.store, [
        ownTransferProposalWrite({
          proposal: mutated,
          manifest: run.manifest,
          now: "2030-01-10T00:00:00.000Z",
        }),
      ]);
      return plan(w, "economic-event.adopt", adoptPayload(mutated.proposalId));
    };
    const id = (n: string) => `otp_${n.repeat(64)}`;
    // The cited parse run does not hold the row any more.
    const moved = {
      ...proposal!,
      proposalId: id("1"),
      debit: { ...proposal!.debit, parseRunId: 3 },
    };
    expect(refusalOf(await store(moved))).toEqual({
      error: "stale_context",
      code: "evidence_changed",
    });
    // The stored alias class is not what the registry function computes now.
    const rekeyed = {
      ...proposal!,
      proposalId: id("2"),
      debit: {
        ...proposal!.debit,
        aliasClass: { ...proposal!.debit.aliasClass, ruleVersion: "smbc-meisai-id-v0" },
      },
    };
    expect(refusalOf(await store(rekeyed))).toEqual({
      error: "needs_scope_resolution",
      code: "identity_rekeyed",
    });
    // A credit the engine never proposes: the SBI-Shinsei-shaped row. The
    // planner re-admits each row and refuses it with rule 2's code.
    const shinsei = {
      ...proposal!,
      proposalId: id("3"),
      credit: {
        ...proposal!.credit,
        observationId: 201,
        parseRunId: 2,
        evidenceRef: transactionRowRef(201, 2),
        key: engineRows(w.db, [201])[0]!.key,
        aliasClass: {
          sourceId: "sbi-shinsei-bank",
          components: ["ref-0201"],
          accountId: "acct-synthetic-shinsei",
          ruleVersion: "sbi-shinsei-txn-reference-no-v1",
        },
        accountId: "acct-synthetic-shinsei",
      },
    };
    expect(refusalOf(await store(shinsei))).toEqual({
      error: "needs_scope_resolution",
      code: "identity_origin_unrecorded",
    });
  });

  test("a row a card settlement holds: alias_conflict under another key, economic_claim_held under the same", async () => {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    // A settlement-shaped holder of observation 111: 101's provider row under
    // another producer, with its alias class (as G1b's settlement writer records it).
    await write(
      w.store,
      memberWrites(w.db, [
        {
          eventId: "settlement-synthetic",
          revision: 1,
          legs: [111],
          writerRelease: "card-statement-settlement-v1:economic-guard-v1",
        },
      ]),
    );
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(proposal!.proposalId))),
    ).toEqual({
      error: "stale_context",
      code: "alias_conflict",
    });
    // The same key with no alias class recorded (a legacy-shaped holder).
    const v = world();
    const [other] = await propose(v, [103, 104]);
    await write(
      v.store,
      memberWrites(v.db, [
        {
          eventId: "holder-synthetic",
          revision: 1,
          legs: [104],
          withoutAlias: true,
          writerRelease: "synthetic-writer-v1",
        },
      ]),
    );
    expect(
      refusalOf(await plan(v, "economic-event.adopt", adoptPayload(other!.proposalId))),
    ).toEqual({
      error: "stale_context",
      code: "economic_claim_held",
    });
    // The engine refuses the same rows when it is told the holders.
    const run = await proposeOwnTransfers({
      rows: engineRows(w.db, [101, 102]),
      ownership,
      policy: POLICY,
      identityEpoch: INITIAL_IDENTITY_EPOCH,
      held: { keys: [], aliasClasses: [aliasClassText(proposal!.debit.aliasClass)] },
    });
    expect(run.ok && run.rowRefusals).toEqual([{ observationId: 101, code: "alias_conflict" }]);
  });

  test("W6: a proposal already adopted, or adopted and withdrawn, is never adopted again", async () => {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    const eventId = await adopt(w, proposal!);
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(proposal!.proposalId))),
    ).toEqual({
      error: "stale_context",
      code: "proposal_adopted",
    });
    await write(w.store, memberWrites(w.db, [{ eventId, revision: 2, legs: [] }], [101, 102]));
    expect(
      refusalOf(await plan(w, "economic-event.adopt", adoptPayload(proposal!.proposalId))),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "withdrawn_readoption",
    });
    // Nor by a correction of the withdrawn revision.
    expect(
      refusalOf(
        await plan(w, "economic-event.correct", {
          family: "bank-movement",
          eventId,
          priorRevision: 2,
          revision: payloadClaims(w, restated([101, 102]), [101, 102]),
          releasedClaims: [],
          reason,
        }),
      ),
    ).toEqual({ error: "needs_scope_resolution", code: "withdrawn_readoption" });
  });
});

describe("economic-event.withdraw", () => {
  async function adopted() {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    const eventId = await adopt(w, proposal!);
    return {
      w,
      eventId,
      payload: {
        family: "bank-movement",
        eventId,
        revision: 1,
        decisionRevisionId: `dr-${eventId}-1`,
        reason,
      },
    };
  }

  test("the live head, adopted by the named decision, resolves and pins the head", async () => {
    const { w, eventId, payload } = await adopted();
    const result = await plan(w, "economic-event.withdraw", payload);
    if (!result.ok) throw new Error(result.error);
    expect(result.resolved.expectedRevisions).toEqual({ [economicEventSubject(eventId)]: 1 });
    expect(result.resolved.simulation.after.attributedObservations).toBe(0);
  });

  test("another decision, another revision, a missing or foreign event is refused", async () => {
    const { w, payload } = await adopted();
    expect(
      refusalOf(
        await plan(w, "economic-event.withdraw", { ...payload, decisionRevisionId: "dr-other" }),
      ),
    ).toEqual({
      error: "stale_context",
      code: "decision_epoch_mismatch",
    });
    expect(
      refusalOf(await plan(w, "economic-event.withdraw", { ...payload, revision: 2 })),
    ).toEqual({
      error: "stale_context",
      code: "revision_not_head",
    });
    expect(await plan(w, "economic-event.withdraw", { ...payload, eventId: "missing" })).toEqual({
      ok: false,
      error: "target_missing",
      refs: [economicEventSubject("missing")],
    });
    await write(
      w.store,
      memberWrites(w.db, [
        {
          eventId: "settlement-synthetic",
          revision: 1,
          legs: [103],
          writerRelease: "card-statement-settlement-v1:economic-guard-v1",
        },
      ]),
    );
    expect(
      refusalOf(
        await plan(w, "economic-event.withdraw", {
          ...payload,
          eventId: "settlement-synthetic",
          decisionRevisionId: "dr-settlement-synthetic-1",
        }),
      ),
    ).toEqual({
      error: "unsupported_semantics",
      code: "event_not_own_transfer",
    });
  });

  test("an own-transfer revision sealed but never logged is refused: knowledge_unlogged", async () => {
    const { w, payload } = await adopted();
    w.db.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr-unlogged','relation','event:unlogged',1,'accept','manual','synthetic-reviewer',NULL,'synthetic','[]',NULL,NULL,'2030-01-10T00:00:00.000Z')`,
    );
    w.db.run(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES('unlogged',1,'transfer','credited',NULL,'{}','cash-movement','["synthetic:evidence"]','dr-unlogged',NULL,'2030-01-10T00:00:00.000Z')`,
    );
    const withdrawUnlogged = { ...payload, eventId: "unlogged", decisionRevisionId: "dr-unlogged" };
    // No seal: not one of the own-transfer writer's events.
    expect(refusalOf(await plan(w, "economic-event.withdraw", withdrawUnlogged))).toEqual({
      error: "unsupported_semantics",
      code: "event_not_own_transfer",
    });
    // Sealed by that release, but no commit row logs it.
    await write(w.store, [
      revisionSealWrite(decisionEntry("dr-unlogged"), {
        eventId: "unlogged",
        revision: 1,
        writerRelease: OWN_TRANSFER_WRITER_RELEASE,
        legCount: 0,
        claimCount: 0,
        timeCount: 0,
        effectCount: 0,
        contentDigest: "c".repeat(64),
        identityPins: {},
        identityEpoch: INITIAL_IDENTITY_EPOCH,
        now: "2030-01-10T00:00:00.000Z",
      }),
    ]);
    expect(refusalOf(await plan(w, "economic-event.withdraw", withdrawUnlogged))).toEqual({
      error: "needs_scope_resolution",
      code: "knowledge_unlogged",
    });
  });

  test("W6: a withdrawal planned before another withdrawal committed is stale; withdrawing twice is refused", async () => {
    const { w, eventId, payload } = await adopted();
    const first = await plan(w, "economic-event.withdraw", payload);
    if (!first.ok) throw new Error(first.error);
    await write(w.store, memberWrites(w.db, [{ eventId, revision: 2, legs: [] }], [101, 102]));
    // The pinned head moved: the commit's first statement would match nothing.
    const current = await w.store.all<RevisionRow>(CURRENT_REVISIONS_SQL, [
      JSON.stringify(first.resolved.expectedRevisions),
    ]);
    expect(current).toEqual([{ subject_ref: economicEventSubject(eventId), revision: 2 }]);
    expect(refusalOf(await plan(w, "economic-event.withdraw", payload))).toEqual({
      error: "stale_context",
      code: "revision_not_head",
    });
    expect(
      refusalOf(
        await plan(w, "economic-event.withdraw", {
          ...payload,
          revision: 2,
          decisionRevisionId: `dr-${eventId}-2`,
        }),
      ),
    ).toEqual({
      error: "stale_context",
      code: "already_withdrawn",
    });
  });

  test("a released key another live holder keeps is never washed", async () => {
    const { w, payload } = await adopted();
    // A pre-existing double holder, as only the pre-guard path could leave one:
    // the one-live-holder triggers are dropped to plant it.
    w.db.exec(
      "DROP TRIGGER economic_claims_one_live_holder; DROP TRIGGER economic_claims_alias_one_live_holder",
    );
    w.db.exec("DROP TRIGGER economic_commit_log_guard");
    await write(
      w.store,
      memberWrites(w.db, [
        {
          eventId: "double-holder",
          revision: 1,
          legs: [101],
          withoutAlias: true,
          writerRelease: "synthetic-writer-v1",
        },
      ]),
    );
    expect(refusalOf(await plan(w, "economic-event.withdraw", payload))).toEqual({
      error: "needs_scope_resolution",
      code: "economic_claim_conflict_unresolved",
    });
  });
});

describe("economic-event.correct", () => {
  async function adopted() {
    const w = world();
    const [proposal] = await propose(w, [101, 102]);
    const eventId = await adopt(w, proposal!);
    const payload = (legs: number[], claims: number[], released: number[]) => ({
      family: "bank-movement",
      eventId,
      priorRevision: 1,
      revision: payloadClaims(w, restated(legs), claims),
      releasedClaims: released.map((id) => claimOf(w.db, id)),
      reason,
    });
    return { w, eventId, payload };
  }

  test("a full restatement releasing exactly what it drops resolves", async () => {
    const { w, eventId, payload } = await adopted();
    const result = await plan(w, "economic-event.correct", payload([101, 105], [101, 105], [102]));
    if (!result.ok) throw new Error(`${result.error} ${result.refs}`);
    expect(result.resolved.expectedRevisions).toEqual({ [economicEventSubject(eventId)]: 1 });
  });

  test("released claims that are not exactly the dropped ones, a claim without its leg, another kind", async () => {
    const { w, payload } = await adopted();
    expect(
      refusalOf(await plan(w, "economic-event.correct", payload([101, 105], [101, 105], []))),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "released_claims_mismatch",
    });
    expect(
      refusalOf(await plan(w, "economic-event.correct", payload([101, 105], [101, 104], [102]))),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "claim_without_leg",
    });
    const fee = payload([101, 105], [101, 105], [102]);
    expect(
      refusalOf(
        await plan(w, "economic-event.correct", {
          ...fee,
          revision: { ...fee.revision, kind: "fee", state: "confirmed" },
        }),
      ),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "restatement_unsupported",
    });
  });

  test("a restated row held elsewhere, or with an unrecorded origin, is refused", async () => {
    const { w, payload } = await adopted();
    await write(
      w.store,
      memberWrites(w.db, [
        {
          eventId: "other-synthetic",
          revision: 1,
          legs: [105],
          writerRelease: "synthetic-writer-v1",
        },
      ]),
    );
    expect(
      refusalOf(await plan(w, "economic-event.correct", payload([101, 105], [101, 105], [102]))),
    ).toEqual({
      error: "stale_context",
      code: "alias_conflict",
    });
    expect(
      refusalOf(await plan(w, "economic-event.correct", payload([101, 201], [101, 201], [102]))),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "identity_origin_unrecorded",
    });
  });

  test("a holder sealed under an older identity epoch goes to review; a withdrawal stays plannable", async () => {
    const { w, eventId, payload } = await adopted();
    declareNextEpoch(w.db);
    expect(
      refusalOf(await plan(w, "economic-event.correct", payload([101, 105], [101, 105], [102]))),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "identity_epoch_changed",
    });
    expect(
      (
        await plan(w, "economic-event.withdraw", {
          family: "bank-movement",
          eventId,
          revision: 1,
          decisionRevisionId: `dr-${eventId}-1`,
          reason,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("economic-event.move and W5", () => {
  async function two() {
    const w = world();
    const proposals = await propose(w, [101, 102, 103, 104]);
    const [one, other] = proposals.sort((a, b) => a.debit.observationId - b.debit.observationId);
    const from = await adopt(w, one!); // 101 → 102
    const to = await adopt(w, other!); // 103 → 104
    const movePayload = (fromClaims: number[], toClaims: number[], claim = 102) => ({
      family: "bank-movement",
      claim: claimOf(w.db, claim),
      from: {
        eventId: from,
        priorRevision: 1,
        revision: payloadClaims(w, restated(fromClaims), fromClaims),
      },
      to: {
        eventId: to,
        priorRevision: 1,
        revision: payloadClaims(w, restated(toClaims), toClaims),
      },
      reason,
    });
    return { w, from, to, movePayload };
  }

  test("one claim leaves one event and joins the other; both heads are pinned", async () => {
    const { w, from, to, movePayload } = await two();
    const payload = movePayload([101], [103, 104, 102]);
    expect(validPayload("economic-event.move", payload)).toBe(true);
    const result = await plan(w, "economic-event.move", payload);
    if (!result.ok) throw new Error(`${result.error} ${result.refs}`);
    expect(result.resolved.expectedRevisions).toEqual({
      [economicEventSubject(from)]: 1,
      [economicEventSubject(to)]: 1,
    });
  });

  test("a claim the from member does not hold, or a restatement that changes other claims, is refused", async () => {
    const { w, movePayload } = await two();
    expect(
      refusalOf(
        await plan(w, "economic-event.move", movePayload([101, 102], [103, 104, 105], 105)),
      ),
    ).toEqual({
      error: "needs_scope_resolution",
      code: "move_claim_not_held",
    });
    expect(refusalOf(await plan(w, "economic-event.move", movePayload([101], [104, 102])))).toEqual(
      {
        error: "needs_scope_resolution",
        code: "move_restates_other_claims",
      },
    );
  });

  test("W5: the move's two-member batch fails whole at any statement, and commits whole", async () => {
    const { w, from, to } = await two();
    const members: MemberSpec[] = [
      { eventId: from, revision: 2, legs: [101], claims: [101] },
      { eventId: to, revision: 2, legs: [103, 104, 102], claims: [103, 104, 102] },
    ];
    const writes = memberWrites(w.db, members);
    const before = snapshot(w.db);
    const failing = {
      sql: "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(0,'x','x','x')",
      binds: [],
    };
    for (let index = 0; index < writes.length; index += 1) {
      const injected = writes.map((statement, at) => (at === index ? failing : statement));
      await expect(write(w.store, injected)).rejects.toThrow();
      expect(snapshot(w.db)).toEqual(before);
    }
    // The second member's own failure: its seal states a claim count its rows do not have.
    const seals = writes.flatMap((statement, at) =>
      statement.sql.startsWith("INSERT INTO economic_revision_seals") ? [at] : [],
    );
    const second = seals.at(-1)!;
    const wrong = writes.map((statement, at) =>
      at === second
        ? { sql: statement.sql, binds: statement.binds.map((bind, i) => (i === 4 ? 9 : bind)) }
        : statement,
    );
    await expect(write(w.store, wrong)).rejects.toThrow("economic_seal_invalid");
    expect(snapshot(w.db)).toEqual(before);
    // Whole: one commit row, two members, nothing released, the moved claim held once.
    await write(w.store, writes);
    const commit = w.db
      .query(
        "SELECT members_json,released_json FROM economic_commit_log ORDER BY commit_seq DESC LIMIT 1",
      )
      .get() as {
      members_json: string;
      released_json: string;
    };
    expect(JSON.parse(commit.members_json)).toHaveLength(2);
    expect(commit.released_json).toBe("[]");
    expect(
      w.db
        .query("SELECT event_id FROM live_consumption_claims WHERE consumption_key=?")
        .all(JSON.stringify(claimOf(w.db, 102).key)),
    ).toEqual([{ event_id: to }]);
    // Withdraw-then-adopt as two operations would instead surface the holder:
    // claiming 102 for a third event while `to` holds it is refused.
    await expect(
      write(
        w.store,
        memberWrites(w.db, [{ eventId: "third-synthetic", revision: 1, legs: [102] }]),
      ),
    ).rejects.toThrow(/alias_conflict|economic_claim_held/u);
  });

  test("a move planned before the from member moved on is stale", async () => {
    const { w, from, movePayload } = await two();
    await write(
      w.store,
      memberWrites(w.db, [{ eventId: from, revision: 2, legs: [] }], [101, 102]),
    );
    expect(
      refusalOf(await plan(w, "economic-event.move", movePayload([101], [103, 104, 102]))),
    ).toEqual({
      error: "stale_context",
      code: "revision_not_head",
    });
  });
});

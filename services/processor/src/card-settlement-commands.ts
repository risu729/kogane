// The card settlement commands' writes (accept, reject, withdraw), planned for
// the change lifecycle's commit batch. Since ADR 0054 G1b an acceptance and a
// withdrawal are writers of the common consumption guard (CORE 0070): after
// their own statements they append the economic statements, each guarded on
// this operation's receipt for this payload and plan (`receiptEntry`):
//
//   accept   ... legs → allocation → economic_claims row (book cash-movement,
//            the bank_key 5-tuple, the alias class of the registry's provider
//            identity function) → accepted decision → seal → commit row;
//   withdraw ... supersede pointer → allocation withdrawal (the writer's own
//            legacy record) → withdrawn decision → seal → commit row releasing
//            the accepted revision's claim.
//
// The commit row is the last economic statement (the lifecycle's approval,
// plan and outbox statements follow it). Its trigger refuses, and D1 rolls
// the whole batch back, when the key or the alias class has another live
// holder, when the withdrawal's pointer matched nothing, or when a released
// key is held twice; the commit answers with the closed code.
import {
  commandKey,
  type MutationPlanner,
  type PreparedWrite,
  type CardSettlementPayload,
} from "../../../packages/application/src/command/contract.ts";
import { cardSettlementDebitIdentity } from "../../../packages/application/src/operations/card-settlement-target.ts";
import {
  validCardSettlementFacts,
  cardSettlementEligible,
  type CardSettlementFacts,
} from "../../../packages/domain/src/card-settlement.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  parseConsumptionKey,
  type AliasClass,
  type BookClaim,
  type EconomicClaimRecord,
} from "../../../packages/domain/src/economic-contract.ts";
import { cardSettlementReadinessCtes } from "../../../packages/read-model/src/card-settlement-readiness.ts";
import { CURRENT_IDENTITY_EPOCH_SQL } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition.ts";
import {
  canonicalKnownAt,
  economicFinalizationWrites,
  receiptEntry,
} from "../../../packages/storage-d1/src/atomic/economic-commit.ts";

/** The writer release the settlement commands seal their revisions under. */
export const CARD_SETTLEMENT_WRITER_RELEASE = "card-statement-settlement-v1:economic-guard-v1";

interface Row {
  id: string;
  revision: number;
  status: string;
  facts_json: string;
  bank_key: string;
  bank_observation_id: number;
  bank_parse_run_id: number;
  decision_revision_id: string | null;
  event_id: string | null;
  settlement_id: string | null;
}
/**
 * The reservation's condition, binds (id, revision, status): the candidate is
 * still at the planned revision and status and, for an acceptance, every
 * `card_settlement_readiness` flag holds, `claim_available` (ADR 0054)
 * included. It is evaluated inside the statement that reserves the receipt,
 * so a source, ownership, allocation or claim change between plan and commit
 * still writes nothing. The flags are judged for this candidate alone, through
 * the keyed form of the view
 * (packages/read-model/src/card-settlement-readiness.ts): the whole view cost
 * seconds per commit on a two-year store (docs/card-settlements.md, Cost).
 */
export function cardSettlementCommitGuardSql(accept: boolean): string {
  return (
    `EXISTS(WITH chosen AS (SELECT ? AS id), ${cardSettlementReadinessCtes()}
   SELECT 1 FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id JOIN readiness ready ON ready.id=c.id
   WHERE c.revision=? AND c.status=?` +
    (accept
      ? " AND ready.statement_current=1 AND ready.bank_current=1 AND ready.ownership_current=1 AND ready.allocation_available=1 AND ready.claim_available=1"
      : "") +
    ")"
  );
}

/**
 * The digest of a settlement event revision's content, as its seal states it:
 * the stored fields of the revision, its legs and its claims, nothing else.
 */
async function contentDigest(content: {
  eventId: string;
  revision: number;
  withdraw: boolean;
  facts: CardSettlementFacts;
  claims: readonly BookClaim[];
  aliasClass: AliasClass | null;
}): Promise<string> {
  const { facts } = content;
  return canonicalDigest({
    eventId: content.eventId,
    revision: content.revision,
    kind: "card_settlement",
    state: content.withdraw ? "unknown" : "debited",
    unknownReason: content.withdraw ? "conflicting_evidence" : null,
    effectiveTime: facts.bankDebit.occurred,
    basis: "cash-movement",
    evidence: [facts.statement.ref, facts.bankDebit.ref],
    legs: content.withdraw
      ? []
      : [
          {
            legIndex: 0,
            subjectRef: facts.bankDebit.accountId,
            quantity: facts.statement.amount,
            role: "decrease",
            basis: "cash-movement",
          },
          {
            legIndex: 1,
            subjectRef: facts.statement.accountId,
            unitRef: facts.statement.amount.unitRef,
            valueReasonCode: "statement_principal_and_fees_unknown",
            role: "unresolved",
            basis: "obligation-change",
          },
        ],
    claims: content.claims.map((claim) => [claim.book, claim.key]),
    aliasClass: content.aliasClass,
  });
}

export const cardSettlementMutation: MutationPlanner = async (input) => {
  const { store, plan, principal, operationId, now, guard } = input;
  if (!plan.kind.startsWith("card-settlement.")) return null;
  const payload = plan.payload as CardSettlementPayload;
  const row = await store.first<Row>("SELECT * FROM card_settlement_reviews WHERE id=?", [
    payload.proposalId,
  ]);
  if (!row) return null;
  const facts: unknown = JSON.parse(row.facts_json);
  if (!validCardSettlementFacts(facts)) return null;
  const accept = plan.kind === "card-settlement.accept";
  const withdraw = plan.kind === "card-settlement.withdraw";
  const expected = plan.expectedRevisions["card-settlement:" + row.id];
  if (
    expected !== row.revision ||
    (withdraw ? row.status !== "accepted" : row.status !== "proposed")
  )
    return null;
  if (accept && !cardSettlementEligible(facts)) return null;
  // An eligible statement total is exact (`cardSettlementEligible` requires a
  // positive exact amount); the cash leg states it, never a guess.
  const amount = facts.statement.amount.value;
  if (accept && amount.status !== "exact") return null;
  const revision = row.revision + 1;
  const decisionId = await commandKey("dr", ["card-settlement", operationId]);
  const eventId = withdraw ? row.event_id : accept ? await commandKey("event", [row.id]) : null;
  const allocationId = withdraw
    ? row.settlement_id
    : accept
      ? await commandKey("allocation", [row.id])
      : null;
  if (withdraw && (!eventId || !allocationId)) return null;
  // What the economic statements need: the bank_key as a consumption key, the
  // debit's admitted identity (accept) and the identity epoch the seal is
  // made under. A refusal writes nothing; the commit's re-simulation of the
  // plan names it (identity_origin_unrecorded, ...).
  const key = parseConsumptionKey(row.bank_key);
  let aliasClass: AliasClass | null = null;
  let identityEpoch: string | null = null;
  if (eventId !== null) {
    if (key === null) return null;
    if (accept) {
      const identity = await cardSettlementDebitIdentity(store, row.id, facts);
      if (identity === null || !identity.admitted) return null;
      aliasClass = identity.aliasClass;
    }
    identityEpoch =
      (await store.first<{ identity_epoch: string }>(CURRENT_IDENTITY_EPOCH_SQL, []))
        ?.identity_epoch ?? null;
    if (identityEpoch === null) return null;
  }
  const status = withdraw ? "withdrawn" : accept ? "accepted" : "rejected";
  const result = {
    proposalId: row.id,
    status,
    revision,
    decisionRevisionId: decisionId,
    eventId,
    obligationId: null,
    settlementId: allocationId,
  };
  const writes: PreparedWrite[] = [];
  const add = (sql: string, binds: unknown[]) =>
    writes.push({ sql: sql + " AND " + guard.sql, binds: [...binds, ...guard.binds] });
  add(
    `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
 SELECT ?,?,'server',?,?,?,? WHERE 1`,
    [operationId, principal.id, plan.kind, plan.planId, JSON.stringify(result), now],
  );
  // The decisions cite the reviewed rows and the ownership evidence by id;
  // the event revision cites the rows it was read from as SourceFactRef
  // objects, the shape `validEconomicEventRevision` and the event reader read.
  const evidence = JSON.stringify([
    facts.statement.ref.id,
    facts.bankDebit.ref.id,
    ...facts.ownershipEvidenceRefs,
  ]);
  const support = JSON.stringify([facts.statement.ref, facts.bankDebit.ref]);
  const decision = (id: string, subject: string, rev: number, previous: number | null) => {
    add(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
   SELECT ?,'relation',?,?,?,'manual',?,?,?,?,?,? WHERE 1`,
      [
        id,
        subject,
        rev,
        withdraw ? "supersede" : accept ? "accept" : "reject",
        principal.id,
        operationId,
        payload.reason,
        evidence,
        previous,
        now,
      ],
    );
  };
  decision(decisionId, "card-settlement:" + row.id, revision, row.revision || null);
  const settlementDecision = () =>
    add(
      `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
  SELECT ?,?,?,?,?,NULL,?,? WHERE 1`,
      [row.id, revision, status, decisionId, eventId, allocationId, now],
    );
  if (eventId === null || allocationId === null || key === null || identityEpoch === null) {
    // A rejection: a judgement only, no event and nothing consumed.
    settlementDecision();
  } else {
    const eventDecision = await commandKey("dr", ["card-settlement-event", operationId]);
    const allocationDecision = await commandKey("dr", ["card-settlement-allocation", operationId]);
    decision(eventDecision, "event:" + eventId, revision, row.revision || null);
    decision(allocationDecision, "allocation:" + allocationId, revision, row.revision || null);
    add(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,created_at)
   SELECT ?,?,'card_settlement',?,?,?,'cash-movement',?,?,? WHERE 1`,
      [
        eventId,
        revision,
        withdraw ? "unknown" : "debited",
        withdraw ? "conflicting_evidence" : null,
        JSON.stringify(facts.bankDebit.occurred),
        support,
        eventDecision,
        now,
      ],
    );
    const claim: BookClaim = { book: "cash-movement", key };
    const claims: EconomicClaimRecord[] = [];
    if (accept && amount.status === "exact") {
      const { coefficient, scale } = amount.value;
      // This cash leg cites an existing observation. It is not an additional
      // expense or balance write. Its subject stays the bare account id the
      // 0044 readers tolerate (ADR 0054, Deviations).
      add(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,role,basis)
    SELECT ?,?,0,?,?,'exact',?,?,'decrease','cash-movement' WHERE 1`,
        [
          eventId,
          revision,
          facts.bankDebit.accountId,
          facts.statement.amount.unitRef,
          coefficient,
          scale,
        ],
      );
      // A billed payment total does not prove principal reduction or fee decomposition.
      add(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,value_reason_code,role,basis)
    SELECT ?,?,1,?,?,'missing','statement_principal_and_fees_unknown','unresolved','obligation-change' WHERE 1`,
        [eventId, revision, facts.statement.accountId, facts.statement.amount.unitRef],
      );
      add(
        `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,created_at)
    SELECT ?,?,?,'settlement',?,?,?,?,? WHERE 1`,
        [
          allocationId,
          facts.bankDebit.ref.id,
          "event:" + eventId,
          facts.statement.amount.unitRef,
          coefficient,
          scale,
          allocationDecision,
          now,
        ],
      );
      claims.push({
        eventId,
        revision,
        ...claim,
        aliasClass,
        identityEpoch,
        observationId: row.bank_observation_id,
        parseRunId: row.bank_parse_run_id,
      });
    } else {
      add("UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=?", [
        eventId + "@" + revision,
        eventId,
        row.revision,
      ]);
      add(
        `INSERT INTO card_settlement_allocation_withdrawals(settlement_id,decision_revision_id,created_at)
    SELECT ?,?,? WHERE 1`,
        [allocationId, allocationDecision, now],
      );
    }
    const finalization = economicFinalizationWrites({
      entry: receiptEntry({
        operationId,
        principal: principal.id,
        payloadDigest: input.payloadDigest,
        planId: plan.planId,
      }),
      claims,
      times: [],
      effects: [],
      seals: [
        {
          eventId,
          revision,
          writerRelease: CARD_SETTLEMENT_WRITER_RELEASE,
          legCount: withdraw ? 0 : 2,
          // The economic_claims row; the accepted decision restates its key.
          claimCount: claims.length,
          timeCount: 0,
          effectCount: 0,
          contentDigest: await contentDigest({
            eventId,
            revision,
            withdraw,
            facts,
            claims: claims.map(({ book, key: claimed }) => ({ book, key: claimed })),
            aliasClass,
          }),
          // The plan pins the review and the event head and the reservation
          // re-judges the facts' accounts and owners; the seal pins no
          // identity revision yet (ADR 0054, amendment G1b).
          identityPins: {},
          identityEpoch,
          now,
        },
      ],
      commit: {
        decisionRevisionId: decisionId,
        operationId,
        principal: principal.id,
        payloadDigest: input.payloadDigest,
        kind: plan.kind,
        members: [
          {
            eventId,
            revision,
            supersedes: withdraw ? [{ eventId, revision: row.revision }] : [],
          },
        ],
        claims: withdraw ? [] : [claim],
        released: withdraw ? [claim] : [],
        now: canonicalKnownAt(now),
      },
    });
    // claims → accepted or withdrawn decision → seal → commit row: the
    // decision precedes the seal, which counts it with the claims.
    writes.push(...finalization.slice(0, claims.length));
    settlementDecision();
    writes.push(...finalization.slice(claims.length));
  }
  return {
    writes,
    decisionRevisionId: decisionId,
    result,
    precondition: {
      sql: cardSettlementCommitGuardSql(accept),
      binds: [row.id, expected, withdraw ? "accepted" : "proposed"],
    },
  };
};

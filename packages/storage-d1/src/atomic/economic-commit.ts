// The common economic-event consumption guard as statements (CORE 0070,
// ADR 0054). Pure builders, called by the card purchase lane
// (`card-purchase-recognition.ts`) and the card settlement commands
// (`services/processor/src/card-settlement-commands.ts`) since G1b.
//
// One economic batch is
//
//   entry → revision(s) → legs → supersede pointer(s) → [writer sidecars]
//         → claims → times → effects → seal per member → commit row
//
// and every statement after the entry is a *conditional* write, for the
// reason `decision-commit.ts` gives: D1 rolls a batch back on an SQL error,
// not because a conditional INSERT matched zero rows.
//
//   * The entry is statement 1 and carries every precondition: the reviewed
//     path's receipt reservation (`receiptReservationWrite`), or a rule
//     writer's decision insert. `EconomicEntry` is the condition that is true
//     exactly when that row exists — the receipt with this operation id,
//     principal, payload digest and plan, or the decision with this id.
//   * Every statement here is `WHERE <entry> AND NOT EXISTS(own row)`, so a
//     stale batch whose entry matched nothing writes 0 rows everywhere, and a
//     replay of a batch that already committed finds its own rows and writes
//     nothing. A replay of a batch that committed *without* these statements
//     (a pre-guard rule decision) does write them: see `decisionEntry`.
//   * The commit row is last. Its BEFORE INSERT trigger is where the batch's
//     invariants are enforced (a supersede that matched 0 rows, a claim set
//     that differs from the declared one, a key someone else holds); a
//     violation raises, and D1 rolls the whole batch back. JavaScript after
//     the batch only chooses the response; it never decides what was written.
//
// The commit sequence and known_at are computed in SQL from the stored log,
// never from a worker clock alone: known_at is max(now, previous known_at).
import {
  aliasClassText,
  bookClaimId,
  bookClaimsJson,
  commitMembersJson,
  consumptionKeyText,
  validBookClaimSet,
  validCommitMember,
  validEconomicClaimRecord,
  validEventTimeRecord,
  validIdentityPins,
  validKnownAt,
  validLegEffectRecord,
  type BookClaim,
  type CommitMember,
  type EconomicClaimRecord,
  type EventTimeRecord,
  type IdentityPins,
  type LegEffectRecord,
  type RevisionRef,
} from "../../../domain/src/economic-contract.ts";
import type { SqlWrite } from "../core/operations.ts";

/**
 * A worker clock reading as the commit row's one known_at form
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`, `validKnownAt`). Throws on a value that is not
 * an instant: a programming error, never a runtime race.
 */
export function canonicalKnownAt(now: string): string {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) throw new RangeError("now is not an instant");
  return new Date(time).toISOString();
}

/** A condition, true exactly when this batch's entry row exists. */
export type EconomicEntry = SqlWrite;

/**
 * The entry of a rule writer: its decision row. This means "the decision
 * exists", not "this batch wrote it": a replay whose statement 1 wrote 0 rows
 * still finds the decision, and so writes any statement here it has not
 * written yet. A rule writer must therefore give a guard-era batch a decision
 * id no earlier batch used. From G1b on, the card purchase lane's decision
 * digest includes the writer release (ADR 0054); a replay of a pre-guard
 * draft id would otherwise seal and log that legacy revision now, with an
 * honest later known_at, which is allowed and never backdated.
 */
export function decisionEntry(decisionRevisionId: string): EconomicEntry {
  return {
    sql: "EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)",
    binds: [decisionRevisionId],
  };
}

/**
 * The entry of a reviewed command: the receipt the reservation wrote, tied to
 * this payload and plan, so a receipt for another payload under the same key
 * never lets these statements write.
 */
export function receiptEntry(input: {
  operationId: string;
  principal: string;
  payloadDigest: string;
  planId: string;
}): EconomicEntry {
  return {
    sql: `EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=? AND principal=?
  AND payload_digest=? AND plan_id=?)`,
    binds: [input.operationId, input.principal, input.payloadDigest, input.planId],
  };
}

/** One `economic_claims` row. */
export function economicClaimWrite(entry: EconomicEntry, claim: EconomicClaimRecord): SqlWrite {
  if (!validEconomicClaimRecord(claim)) throw new RangeError("economic claim is not the contract");
  const key = consumptionKeyText(claim.key);
  return {
    sql: `INSERT INTO economic_claims(event_id,revision,book,consumption_key,alias_class,identity_epoch,observation_id,parse_run_id)
 SELECT ?,?,?,?,?,?,?,? WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_claims WHERE event_id=? AND revision=? AND book=? AND consumption_key=?)`,
    binds: [
      claim.eventId,
      claim.revision,
      claim.book,
      key,
      claim.aliasClass === null ? null : aliasClassText(claim.aliasClass),
      claim.identityEpoch,
      claim.observationId,
      claim.parseRunId,
      ...entry.binds,
      claim.eventId,
      claim.revision,
      claim.book,
      key,
    ],
  };
}

/** One `economic_event_times` row. */
export function eventTimeWrite(entry: EconomicEntry, time: EventTimeRecord): SqlWrite {
  if (!validEventTimeRecord(time)) throw new RangeError("event time is not the contract");
  return {
    sql: `INSERT INTO economic_event_times(event_id,revision,role,temporal_json)
 SELECT ?,?,?,? WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_event_times WHERE event_id=? AND revision=? AND role=?)`,
    binds: [
      time.eventId,
      time.revision,
      time.role,
      JSON.stringify(time.time),
      ...entry.binds,
      time.eventId,
      time.revision,
      time.role,
    ],
  };
}

/** One `economic_leg_effects` row. */
export function legEffectWrite(entry: EconomicEntry, effect: LegEffectRecord): SqlWrite {
  if (!validLegEffectRecord(effect)) throw new RangeError("leg effect is not the contract");
  return {
    sql: `INSERT INTO economic_leg_effects(event_id,revision,leg_index,effect,of_leg_index)
 SELECT ?,?,?,?,? WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_leg_effects WHERE event_id=? AND revision=? AND leg_index=?)`,
    binds: [
      effect.eventId,
      effect.revision,
      effect.legIndex,
      effect.effect,
      effect.ofLegIndex,
      ...entry.binds,
      effect.eventId,
      effect.revision,
      effect.legIndex,
    ],
  };
}

/** What the writer states about one member revision; the commit is computed in SQL. */
export interface RevisionSealInput extends RevisionRef {
  writerRelease: string;
  legCount: number;
  /** Every claim of the revision, legacy holders included (economic_revision_claims). */
  claimCount: number;
  timeCount: number;
  effectCount: number;
  contentDigest: string;
  identityPins: IdentityPins;
  /** The identity epoch the revision is adopted under (normally the current one). */
  identityEpoch: string;
  now: string;
}

const NEXT_SEQ =
  "coalesce((SELECT max(l.commit_seq) FROM economic_commit_log l WHERE l.core_epoch=e.core_epoch),0)+1";

/** One `economic_revision_seals` row, for the commit this batch is about to write. */
export function revisionSealWrite(entry: EconomicEntry, seal: RevisionSealInput): SqlWrite {
  if (
    !/^[a-z0-9.:-]{1,128}$/u.test(seal.writerRelease) ||
    !/^[0-9a-f]{64}$/u.test(seal.contentDigest) ||
    !validIdentityPins(seal.identityPins) ||
    !/^[a-z0-9.-]{1,64}$/u.test(seal.identityEpoch) ||
    ![seal.legCount, seal.claimCount, seal.timeCount, seal.effectCount].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
    throw new RangeError("revision seal is not the contract");
  return {
    sql: `INSERT INTO economic_revision_seals(event_id,revision,writer_release,leg_count,claim_count,time_count,effect_count,content_digest,identity_pins_json,identity_epoch,core_epoch,commit_seq,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,e.core_epoch,${NEXT_SEQ},?
 FROM core_source_revision e WHERE e.id=1 AND ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_revision_seals WHERE event_id=? AND revision=?)`,
    binds: [
      seal.eventId,
      seal.revision,
      seal.writerRelease,
      seal.legCount,
      seal.claimCount,
      seal.timeCount,
      seal.effectCount,
      seal.contentDigest,
      JSON.stringify(seal.identityPins),
      seal.identityEpoch,
      seal.now,
      ...entry.binds,
      seal.eventId,
      seal.revision,
    ],
  };
}

/** The finalization row's content; the sequence and known_at are computed in SQL. */
export interface CommitInput {
  decisionRevisionId: string;
  /** Null for a rule writer, whose decision has no operation. */
  operationId: string | null;
  principal: string;
  payloadDigest: string;
  kind: string;
  members: readonly CommitMember[];
  claims: readonly BookClaim[];
  released: readonly BookClaim[];
  /** The worker's clock, canonical UTC (`validKnownAt`). */
  now: string;
}

/** The `economic_commit_log` row: statement N of N. */
export function commitLogWrite(entry: EconomicEntry, commit: CommitInput): SqlWrite {
  checkCommit(commit);
  return {
    sql: `INSERT INTO economic_commit_log(core_epoch,commit_seq,decision_revision_id,operation_id,principal,payload_digest,kind,members_json,claims_json,released_json,known_at)
 SELECT e.core_epoch,${NEXT_SEQ},?,?,?,?,?,?,?,?,
 max(?,coalesce((SELECT l.known_at FROM economic_commit_log l WHERE l.core_epoch=e.core_epoch
  ORDER BY l.commit_seq DESC LIMIT 1),''))
 FROM core_source_revision e WHERE e.id=1 AND ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_commit_log WHERE decision_revision_id=?)`,
    binds: [
      commit.decisionRevisionId,
      commit.operationId,
      commit.principal,
      commit.payloadDigest,
      commit.kind,
      commitMembersJson(commit.members),
      bookClaimsJson(commit.claims),
      bookClaimsJson(commit.released),
      commit.now,
      ...entry.binds,
      commit.decisionRevisionId,
    ],
  };
}

function checkCommit(commit: CommitInput): void {
  const claimed = new Set(commit.claims.map(bookClaimId));
  if (
    commit.members.length === 0 ||
    commit.members.length > 16 ||
    !commit.members.every((member) => validCommitMember(member)) ||
    new Set(commit.members.map((member) => member.eventId)).size !== commit.members.length ||
    !validBookClaimSet(commit.claims) ||
    !validBookClaimSet(commit.released) ||
    commit.released.some((claim) => claimed.has(bookClaimId(claim))) ||
    !/^[0-9a-f]{64}$/u.test(commit.payloadDigest) ||
    !/^[a-z0-9.-]{1,64}$/u.test(commit.kind) ||
    !validKnownAt(commit.now)
  )
    throw new RangeError("economic commit is not the contract");
}

/** Everything a batch appends after its own mutations, in order. */
export interface EconomicFinalizationInput {
  entry: EconomicEntry;
  claims: readonly EconomicClaimRecord[];
  times: readonly EventTimeRecord[];
  effects: readonly LegEffectRecord[];
  /** One seal per commit member. */
  seals: readonly RevisionSealInput[];
  commit: CommitInput;
}

/**
 * claims → times → effects → seals → commit row. Throws on an inconsistent
 * input (a programming error, never a runtime race): a seal that is not a
 * member or a member without a seal, a child row of a revision that is not a
 * member, or an `economic_claims` row whose claim the commit does not declare.
 */
export function economicFinalizationWrites(input: EconomicFinalizationInput): SqlWrite[] {
  const { entry, commit } = input;
  checkCommit(commit);
  const member = (ref: RevisionRef) => `${ref.eventId}@${ref.revision}`;
  const members = new Set(commit.members.map(member));
  const sealed = new Set(input.seals.map(member));
  const declared = new Set(commit.claims.map(bookClaimId));
  if (
    sealed.size !== input.seals.length ||
    sealed.size !== members.size ||
    [...members].some((ref) => !sealed.has(ref)) ||
    [...input.claims, ...input.times, ...input.effects].some((row) => !members.has(member(row))) ||
    input.claims.some((claim) => !declared.has(bookClaimId(claim)))
  )
    throw new RangeError("economic finalization does not match its commit");
  return [
    ...input.claims.map((claim) => economicClaimWrite(entry, claim)),
    ...input.times.map((time) => eventTimeWrite(entry, time)),
    ...input.effects.map((effect) => legEffectWrite(entry, effect)),
    ...input.seals.map((seal) => revisionSealWrite(entry, seal)),
    commitLogWrite(entry, commit),
  ];
}

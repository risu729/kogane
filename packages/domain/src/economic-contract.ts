// The common economic-event consumption contract (ADR 0054, CORE 0070).
//
// One provider row is consumed at most once per book: a card usage row as a
// purchase, a posted cash row as a settlement debit or one leg of an own
// transfer. Every writer states the same thing in the same shape: which
// (book, consumption key) pairs one event revision claims, that the
// revision's children are complete (its seal), and one finalization row per
// batch with a dense commit sequence. CORE 0070 enforces it; this module only
// names the shapes, the closed codes the triggers raise and the pure checks a
// writer runs before it plans a batch.
//
// Versions are separate identities and none is inferred from another (ADR
// 0054): a revision's content (its digest in the seal), the head version of
// an event (its highest revision, 0 when it never existed), the decision id,
// the commit sequence, and the read source version. A row's created_at is
// never adoption evidence.
//
// Nothing here reads storage or a clock. The statement builders are
// `packages/storage-d1/src/atomic/economic-commit.ts`.
import { hasExactKeys, isArrayOf, isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";
import { validTemporalValue, type TemporalValue } from "./time.ts";

export const ECONOMIC_CONTRACT_VERSION = "economic-contract-v1";

/**
 * The dimension a provider row is consumed in. A claim is one per book per
 * row, not per account: the key already carries the source account.
 *   * `card-usage` — a card usage row recognised as a purchase or refund;
 *   * `cash-movement` — a posted movement row of a cash or stored-value
 *     account (a card settlement's bank debit, an own transfer's two legs);
 *   * `security-quantity` — a holding-quantity movement row. No writer; CORE
 *     0070 refuses it (`economic_claim_book_unsupported`) until one has its ADR.
 */
export const BOOKS = ["card-usage", "cash-movement", "security-quantity"] as const;
export type Book = (typeof BOOKS)[number];
export const isBook = isOneOf(BOOKS);

/**
 * `[source_id, producer_id, external_id_namespace, source_account, external_id]`,
 * the 0047 recognition key and the 0044 bank_key. Its text form is
 * `JSON.stringify(key)`, which equals SQLite's `json_array(...)` of the same
 * columns: the form CORE stores and re-derives from the cited row.
 */
export type ConsumptionKey = readonly [
  sourceId: string,
  producerId: string,
  externalIdNamespace: string | null,
  sourceAccount: string,
  externalId: string,
];

/** The bound CORE 0070 puts on a stored key's text. */
export const CONSUMPTION_KEY_MAX_TEXT = 2048;

export function validConsumptionKey(value: unknown): value is ConsumptionKey {
  if (!Array.isArray(value) || value.length !== 5) return false;
  const [sourceId, producerId, namespace, sourceAccount, externalId] = value as unknown[];
  return (
    isText(sourceId, 256) &&
    isText(producerId, 256) &&
    (namespace === null || isText(namespace, 256)) &&
    isText(sourceAccount, 512) &&
    isText(externalId, 512) &&
    JSON.stringify(value).length <= CONSUMPTION_KEY_MAX_TEXT
  );
}

/** The stored text of a key: `JSON.stringify`, as SQLite's `json_array` renders it. */
export function consumptionKeyText(key: ConsumptionKey): string {
  return JSON.stringify(key);
}

/** A stored key text back into its tuple, or null when it is not one. */
export function parseConsumptionKey(text: string): ConsumptionKey | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  // Only the canonical rendering is a key: a re-spaced text is another string
  // to SQLite and would never match the stored one.
  return validConsumptionKey(value) && JSON.stringify(value) === text ? value : null;
}

/**
 * The key above names a row inside one collection path, not an economic fact:
 * a producer or namespace change, a parser release that rewrites id text, an
 * identity rewrite (0063) or a mirrored source can give one fact several
 * keys, and a fingerprint can give two facts one key. A human-adopted writer
 * therefore also records the fact's alias class: the source, the provider
 * identity components a registry-declared, versioned function reads from the
 * row, the resolved account id, and that function's version. Never the raw
 * external id text, the producer or the namespace. Its stored text is
 * `JSON.stringify([sourceId, components, accountId, ruleVersion])`.
 */
export interface AliasClass {
  sourceId: string;
  components: readonly string[];
  accountId: string;
  ruleVersion: string;
}

export function validAliasClass(value: unknown): value is AliasClass {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sourceId", "components", "accountId", "ruleVersion"]) &&
    isText(value.sourceId, 256) &&
    isArrayOf((item): item is string => isText(item, 512), 16)(value.components) &&
    value.components.length > 0 &&
    isText(value.accountId, 256) &&
    isText(value.ruleVersion, 64) &&
    aliasClassText(value as unknown as AliasClass).length <= CONSUMPTION_KEY_MAX_TEXT
  );
}

export function aliasClassText(alias: AliasClass): string {
  return JSON.stringify([
    alias.sourceId,
    [...alias.components],
    alias.accountId,
    alias.ruleVersion,
  ]);
}

/** One (book, key) a revision consumes. */
export interface BookClaim {
  book: Book;
  key: ConsumptionKey;
}

export function validBookClaim(value: unknown): value is BookClaim {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["book", "key"]) &&
    isBook(value.book) &&
    validConsumptionKey(value.key)
  );
}

/** The identity of a claim inside a set: book and key text. */
export function bookClaimId(claim: BookClaim): string {
  return JSON.stringify([claim.book, consumptionKeyText(claim.key)]);
}

/** No (book, key) twice. */
export function validBookClaimSet(value: unknown, max = 64): value is BookClaim[] {
  if (!isArrayOf(validBookClaim, max)(value)) return false;
  return new Set(value.map(bookClaimId)).size === value.length;
}

/** Sorted, so two equal sets store the same text. */
export function sortedBookClaims(claims: readonly BookClaim[]): BookClaim[] {
  return [...claims].sort((a, b) => compareText(bookClaimId(a), bookClaimId(b)));
}

/** Set equality of two claim sets (order and duplicates ignored). */
export function sameBookClaims(a: readonly BookClaim[], b: readonly BookClaim[]): boolean {
  const left = new Set(a.map(bookClaimId));
  const right = new Set(b.map(bookClaimId));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * What a correct, withdraw or move releases: every claim of the superseded
 * revisions that no new member claims again. Nothing implicit: a claim the
 * next revision does not restate is released, never carried over.
 */
export function releasedBookClaims(
  prior: readonly BookClaim[],
  next: readonly BookClaim[],
): BookClaim[] {
  const kept = new Set(next.map(bookClaimId));
  const seen = new Set<string>();
  return sortedBookClaims(
    prior.filter((claim) => {
      const id = bookClaimId(claim);
      if (kept.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  );
}

/** One revision of one event. */
export interface RevisionRef {
  eventId: string;
  revision: number;
}

export function validRevisionRef(value: unknown): value is RevisionRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision"]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1)
  );
}

/**
 * An event's head as a plan read it: its highest revision, 0 when the event
 * never existed (a first adoption plans against 0). `live` says whether that
 * revision is live; a merged-away event has a head that is not.
 */
export interface HeadRef {
  eventId: string;
  version: number;
  live: boolean;
}

export function validHeadRef(value: unknown): value is HeadRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "version", "live"]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.version, 0) &&
    typeof value.live === "boolean" &&
    (value.version > 0 || value.live === false)
  );
}

/**
 * The expected-revision subject of an event head (core/operations.ts
 * REVISION_OF gains this prefix when the first writer joins, G1b in ADR 0054;
 * `card-purchase:` keeps its meaning).
 */
export const ECONOMIC_EVENT_SUBJECT_PREFIX = "economic-event:";
export function economicEventSubject(eventId: string): string {
  return `${ECONOMIC_EVENT_SUBJECT_PREFIX}${eventId}`;
}

/** One commit: the dense sequence number inside one core epoch (0038). */
export interface CommitRef {
  coreEpoch: string;
  commitSeq: number;
}

export function validCommitRef(value: unknown): value is CommitRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["coreEpoch", "commitSeq"]) &&
    isText(value.coreEpoch, 64) &&
    isSafeInt(value.commitSeq, 1)
  );
}

/**
 * What a reader knew: every commit up to a sequence number, or every commit
 * whose known_at is at or before an instant (all commits of an equal instant
 * included), resolved to a sequence before anything is read. Never a D1
 * bookmark: a bookmark is "at least this", not a past snapshot.
 */
export type KnowledgeCut = CommitRef | { coreEpoch: string; instant: string };

export function validKnowledgeCut(value: unknown): value is KnowledgeCut {
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ["coreEpoch", "commitSeq"])) return validCommitRef(value);
  return (
    hasExactKeys(value, ["coreEpoch", "instant"]) &&
    isText(value.coreEpoch, 64) &&
    isText(value.instant, 64)
  );
}

// ---------------------------------------------------------------------------
// Record shapes, one per CORE 0070 table.

/** The first declared identity epoch (CORE 0070 seeds it). */
export const INITIAL_IDENTITY_EPOCH = "identity-epoch-1";
const IDENTITY_EPOCH = /^[a-z0-9.-]{1,64}$/u;

/**
 * An `economic_claims` row: the claim, its alias class (null only for a rule
 * writer that proves retire-before-recognise), the identity epoch it was made
 * under, and the row it was derived from (pinned as 0047 pins its keys).
 */
export interface EconomicClaimRecord extends RevisionRef, BookClaim {
  aliasClass: AliasClass | null;
  identityEpoch: string;
  observationId: number;
  parseRunId: number;
}

export function validEconomicClaimRecord(value: unknown): value is EconomicClaimRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "eventId",
      "revision",
      "book",
      "key",
      "aliasClass",
      "identityEpoch",
      "observationId",
      "parseRunId",
    ]) &&
    validRevisionRef({ eventId: value.eventId, revision: value.revision }) &&
    validBookClaim({ book: value.book, key: value.key }) &&
    (value.aliasClass === null ||
      (validAliasClass(value.aliasClass) &&
        value.aliasClass.sourceId === (value.key as ConsumptionKey)[0])) &&
    typeof value.identityEpoch === "string" &&
    IDENTITY_EPOCH.test(value.identityEpoch) &&
    isSafeInt(value.observationId, 1) &&
    isSafeInt(value.parseRunId, 1)
  );
}

/** The time roles of `economic_event_times`. No fallback between roles. */
export const EVENT_TIME_ROLES = ["trade", "settlement", "posting", "usage", "value"] as const;
export type EventTimeRole = (typeof EVENT_TIME_ROLES)[number];

export interface EventTimeRecord extends RevisionRef {
  role: EventTimeRole;
  time: TemporalValue;
}

export function validEventTimeRecord(value: unknown): value is EventTimeRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision", "role", "time"]) &&
    validRevisionRef({ eventId: value.eventId, revision: value.revision }) &&
    isOneOf(EVENT_TIME_ROLES)(value.role) &&
    validTemporalValue(value.time)
  );
}

/**
 * What a leg is (`economic_leg_effects`): a movement, a breakdown of another
 * leg (a stated fee inside a net movement: 101 out = 100 principal + 1 fee
 * counts 101 out once), or a correspondence to another leg (trade and
 * settlement). A leg without a row keeps the legacy reading: increase and
 * decrease move, fee and unresolved have no effect of their own.
 */
export const LEG_EFFECTS = ["movement", "breakdown", "correspondence"] as const;
export type LegEffect = (typeof LEG_EFFECTS)[number];

export interface LegEffectRecord extends RevisionRef {
  legIndex: number;
  effect: LegEffect;
  /** The leg this one breaks down or corresponds to; null for a movement. */
  ofLegIndex: number | null;
}

export function validLegEffectRecord(value: unknown): value is LegEffectRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision", "legIndex", "effect", "ofLegIndex"]) &&
    validRevisionRef({ eventId: value.eventId, revision: value.revision }) &&
    isSafeInt(value.legIndex, 0) &&
    isOneOf(LEG_EFFECTS)(value.effect) &&
    (value.effect === "movement"
      ? value.ofLegIndex === null
      : isSafeInt(value.ofLegIndex, 0) && value.ofLegIndex !== value.legIndex)
  );
}

/**
 * Identity revisions a revision was adopted under, keyed by expected-revision
 * subject (`account_mapping:<id>`, `ownership:<kind>|<account>`, ...). Pins are
 * immutable; a current meaning that differs marks the revision identity_changed.
 */
export type IdentityPins = Readonly<Record<string, number>>;

export function validIdentityPins(value: unknown): value is IdentityPins {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 256 &&
    Object.entries(value).every(([key, revision]) => isText(key, 512) && isSafeInt(revision, 0))
  );
}

/** An `economic_revision_seals` row: the revision's children are complete. */
export interface RevisionSealRecord extends RevisionRef {
  writerRelease: string;
  legCount: number;
  claimCount: number;
  timeCount: number;
  effectCount: number;
  contentDigest: string;
  identityPins: IdentityPins;
  identityEpoch: string;
  commit: CommitRef;
}

const WRITER_RELEASE = /^[a-z0-9.:-]{1,128}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function validRevisionSealRecord(value: unknown): value is RevisionSealRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "eventId",
      "revision",
      "writerRelease",
      "legCount",
      "claimCount",
      "timeCount",
      "effectCount",
      "contentDigest",
      "identityPins",
      "identityEpoch",
      "commit",
    ]) &&
    validRevisionRef({ eventId: value.eventId, revision: value.revision }) &&
    typeof value.writerRelease === "string" &&
    WRITER_RELEASE.test(value.writerRelease) &&
    isSafeInt(value.legCount, 0) &&
    isSafeInt(value.claimCount, 0) &&
    isSafeInt(value.timeCount, 0) &&
    isSafeInt(value.effectCount, 0) &&
    typeof value.contentDigest === "string" &&
    DIGEST.test(value.contentDigest) &&
    validIdentityPins(value.identityPins) &&
    typeof value.identityEpoch === "string" &&
    IDENTITY_EPOCH.test(value.identityEpoch) &&
    validCommitRef(value.commit)
  );
}

/** One member of a commit: the new revision and every revision it supersedes. */
export interface CommitMember extends RevisionRef {
  supersedes: RevisionRef[];
}

export function validCommitMember(value: unknown): value is CommitMember {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision", "supersedes"]) &&
    validRevisionRef({ eventId: value.eventId, revision: value.revision }) &&
    isArrayOf(validRevisionRef, 16)(value.supersedes) &&
    new Set(value.supersedes.map((ref) => `${ref.eventId}@${ref.revision}`)).size ===
      value.supersedes.length &&
    !value.supersedes.some(
      (ref) => ref.eventId === value.eventId && ref.revision >= (value.revision as number),
    )
  );
}

/**
 * The one commit kind CORE 0070 lets seal a member under an identity epoch
 * that is no longer current: a reviewed needs-review resolution, and only
 * with an operation receipt of this kind for the commit's operation and
 * principal. No receipt can carry it until a vocabulary migration adds it
 * with its planner, so the exemption is closed today.
 */
export const IDENTITY_RESOLUTION_KIND = "economic-event.resolve-identity";

/**
 * A commit's known_at: `YYYY-MM-DDTHH:MM:SS.sssZ` exactly, a real UTC
 * instant (`Date#toISOString`'s form). One format only, because the log, its
 * regression check and every instant cut compare known_at as text, and
 * `...T10:00:00Z` sorts after `...T10:00:00.500Z`. CORE 0070 checks the same.
 */
export function validKnownAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** The command and rule kinds a commit row records: a code, never text. */
const COMMIT_KIND = /^[a-z0-9.-]{1,64}$/u;

/** An `economic_commit_log` row: the finalization of one economic batch. */
export interface CommitLogRecord {
  commit: CommitRef;
  decisionRevisionId: string;
  /** Null for a rule writer, whose decision has no operation. */
  operationId: string | null;
  principal: string;
  payloadDigest: string;
  kind: string;
  members: CommitMember[];
  claims: BookClaim[];
  released: BookClaim[];
  knownAt: string;
}

export function validCommitLogRecord(value: unknown): value is CommitLogRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "commit",
      "decisionRevisionId",
      "operationId",
      "principal",
      "payloadDigest",
      "kind",
      "members",
      "claims",
      "released",
      "knownAt",
    ])
  )
    return false;
  const { members, claims, released } = value;
  if (
    !validCommitRef(value.commit) ||
    !isText(value.decisionRevisionId, 256) ||
    !(value.operationId === null || isText(value.operationId, 256)) ||
    !isText(value.principal, 256) ||
    typeof value.payloadDigest !== "string" ||
    !DIGEST.test(value.payloadDigest) ||
    typeof value.kind !== "string" ||
    !COMMIT_KIND.test(value.kind) ||
    !isArrayOf(validCommitMember, 16)(members) ||
    members.length === 0 ||
    new Set(members.map((member) => member.eventId)).size !== members.length ||
    !validBookClaimSet(claims) ||
    !validBookClaimSet(released) ||
    !validKnownAt(value.knownAt)
  )
    return false;
  const claimed = new Set(claims.map(bookClaimId));
  return released.every((claim) => !claimed.has(bookClaimId(claim)));
}

// ---------------------------------------------------------------------------
// The stored JSON of a commit row. CORE 0070 reads exactly these shapes.

/** `members_json`: `[{eventId, revision, supersedes: [[eventId, revision], ...]}]`. */
export function commitMembersJson(members: readonly CommitMember[]): string {
  return JSON.stringify(
    members.map((member) => ({
      eventId: member.eventId,
      revision: member.revision,
      supersedes: member.supersedes.map((ref) => [ref.eventId, ref.revision]),
    })),
  );
}

/** `claims_json` / `released_json`: a sorted set of `[book, key text]`. */
export function bookClaimsJson(claims: readonly BookClaim[]): string {
  return JSON.stringify(
    sortedBookClaims(claims).map((claim) => [claim.book, consumptionKeyText(claim.key)]),
  );
}

// ---------------------------------------------------------------------------
// The closed codes CORE 0070 raises. Each trigger names one; the SQL text and
// this list are compared by a storage test, so neither side can drift.

export const ECONOMIC_GUARD_CODES = [
  /** A claim on a missing or superseded revision, or a key the cited row does not have. */
  "economic_claim_invalid",
  /** A book no writer is admitted for yet (`security-quantity`). */
  "economic_claim_book_unsupported",
  /** The (book, key) already has a live holder outside this revision or commit. */
  "economic_claim_held",
  /** A child row for a revision that is already sealed. */
  "economic_revision_sealed",
  /** A seal whose counts, liveness, epoch, sequence or pins do not hold. */
  "economic_seal_invalid",
  "economic_event_time_invalid",
  "economic_leg_effect_invalid",
  /** members_json, claims_json or released_json is not the stored shape, or repeats an entry. */
  "economic_commit_shape_invalid",
  /** Another core epoch, or commit_seq is not the previous one plus one. */
  "economic_commit_sequence_invalid",
  "economic_commit_known_at_regressed",
  /** A member that is missing, not live, not the newest, or not sealed for this commit. */
  "economic_commit_member_invalid",
  /** A revision a member says it supersedes does not point at that member (a 0-row CAS). */
  "economic_commit_prior_not_superseded",
  /** A revision points at a member that does not name it in supersedes: an undeclared supersession. */
  "economic_commit_supersession_undeclared",
  /** Another live revision of a member's event. */
  "economic_event_live_conflict",
  /** claims_json is not the members' claim set. */
  "economic_commit_claims_mismatch",
  /** released_json is not the superseded claims that no member claims again. */
  "economic_commit_released_mismatch",
  /** A released key still has a live holder: a pre-existing conflict, never washed. */
  "economic_claim_conflict_unresolved",
  /** The commit's or a member's decision is missing or under another operation or principal. */
  "economic_commit_decision_mismatch",
  /** The (book, alias class) already has a live holder under another row: the same fact, rekeyed. */
  "alias_conflict",
  /** A member sealed under an identity epoch that is no longer the declared one. */
  "identity_epoch_changed",
] as const;
export type EconomicGuardCode = (typeof ECONOMIC_GUARD_CODES)[number];

/** The guard code a D1 error message carries, or null. */
export function economicGuardCode(message: string): EconomicGuardCode | null {
  return (
    ECONOMIC_GUARD_CODES.find((code) => new RegExp(`\\b${code}\\b`, "u").test(message)) ?? null
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Identity admission: may a writer consume a row under this identity at all?
// Decided before any claim is planned. The registry (#549) states each input
// per source family and calls this; nothing here reads a registry.

/** Where a row's external id comes from, as the parser recorded it. */
export const IDENTITY_ORIGIN_BASES = [
  /** The provider issued it (and the parser recorded that it did). */
  "provider-id",
  /** A fingerprint of the row's content plus an occurrence index. */
  "fingerprint-occurrence",
  /** A collector-made fingerprint, including one recorded under externalIdOrigin. */
  "collector-fingerprint",
  /** A digest of stored content (a message hash, a normalized event id). */
  "evidence-digest",
  /** An id with no recorded origin. */
  "unrecorded",
  /** No external id at all. */
  "absent",
] as const;
export type IdentityOriginBasis = (typeof IDENTITY_ORIGIN_BASES)[number];

export const IDENTITY_WRITER_KINDS = ["rule", "human"] as const;
export type IdentityWriterKind = (typeof IDENTITY_WRITER_KINDS)[number];

export interface IdentityAdmissionInput {
  originBasis: IdentityOriginBasis;
  /** A reviewed registry entry declares this family's provider identity function. */
  resolverDeclared: boolean;
  writerKind: IdentityWriterKind;
  /** The writer retires a churned key's holder before it recognises the new key. */
  retireBeforeRecognise: boolean;
}

export function validIdentityAdmissionInput(value: unknown): value is IdentityAdmissionInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "originBasis",
      "resolverDeclared",
      "writerKind",
      "retireBeforeRecognise",
    ]) &&
    isOneOf(IDENTITY_ORIGIN_BASES)(value.originBasis) &&
    typeof value.resolverDeclared === "boolean" &&
    isOneOf(IDENTITY_WRITER_KINDS)(value.writerKind) &&
    typeof value.retireBeforeRecognise === "boolean"
  );
}

/**
 * The closed identity refusals. The first five come from `admitIdentity`;
 * the rest are decided against stored holders (a planner or CORE 0070):
 *   * duplicate_unresolved — two rows that may be one fact are never
 *     asserted separate or the same;
 *   * alias_conflict — the alias class already has a live holder;
 *   * identity_rekeyed / identity_epoch_changed — a held fact reappears under
 *     a new key, or its identity epoch moved: needs review, the holder is
 *     kept, never moved.
 */
export const IDENTITY_REFUSALS = [
  "identity_fingerprint_only",
  "identity_origin_unrecorded",
  "identity_digest_not_provider",
  "identity_resolver_missing",
  "identity_absent",
  "duplicate_unresolved",
  "alias_conflict",
  "identity_rekeyed",
  "identity_epoch_changed",
] as const;
export type IdentityRefusal = (typeof IDENTITY_REFUSALS)[number];

export type IdentityAdmission =
  | {
      admitted: true;
      /** Whether the writer must record an alias class with each claim. */
      aliasClassRequired: boolean;
    }
  | {
      admitted: false;
      refusal: Extract<
        IdentityRefusal,
        | "identity_fingerprint_only"
        | "identity_origin_unrecorded"
        | "identity_digest_not_provider"
        | "identity_resolver_missing"
        | "identity_absent"
      >;
    };

/**
 * The fail-closed identity rules of ADR 0054:
 *   * a row without an external id has nothing to consume (identity_absent);
 *   * a rule writer keeps the bare 5-tuple only where it proves
 *     retire-before-recognise (ADR 0002): churn then retires and recreates,
 *     it never counts twice, and an undercount is the safe direction;
 *   * every other writer — every human-adopted one — needs a provider-issued
 *     id the parser recorded as such and a declared provider identity
 *     function, and records the alias class it computes:
 *       fingerprints → identity_fingerprint_only,
 *       digests of stored content → identity_digest_not_provider,
 *       ids with no recorded origin → identity_origin_unrecorded,
 *       provider ids without a declared function → identity_resolver_missing.
 */
export function admitIdentity(input: IdentityAdmissionInput): IdentityAdmission {
  if (input.originBasis === "absent") return { admitted: false, refusal: "identity_absent" };
  if (input.writerKind === "rule" && input.retireBeforeRecognise)
    return { admitted: true, aliasClassRequired: false };
  switch (input.originBasis) {
    case "fingerprint-occurrence":
    case "collector-fingerprint":
      return { admitted: false, refusal: "identity_fingerprint_only" };
    case "evidence-digest":
      return { admitted: false, refusal: "identity_digest_not_provider" };
    case "unrecorded":
      return { admitted: false, refusal: "identity_origin_unrecorded" };
    case "provider-id":
      return input.resolverDeclared
        ? { admitted: true, aliasClassRequired: true }
        : { admitted: false, refusal: "identity_resolver_missing" };
  }
}

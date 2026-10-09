// The knowledge selector, pure half (ADR 0058; ADR 0054, "Knowledge selector
// interface"). Given the rows a reader loaded for every event a scope touches
// (all their revisions, legs, claims, times, effects, seals, the commits those
// seals name, the identity epochs and the current meaning of every pinned
// identity subject), it answers what was adopted as known at one commit of
// the economic commit log:
//
//   1. every touched event's active revision at the cut is resolved first,
//      over the whole loaded history: a revision is in force when its commit
//      is at or before the cut and no commit at or before the cut supersedes
//      it. Only then is the scope (accounts, instruments, kinds, leg effects,
//      range, basis) applied, so a date or account correction and a dateless
//      withdrawal always decide which revision is active;
//   2. past claim holders come from the claims of the revisions in force at
//      the cut, never from the `current_*` or `live_*` views;
//   3. what the log cannot place is said, never guessed: a revision without a
//      commit row (written before the log started, or by an older build) or
//      with a commit of another core epoch is `knowledge_unlogged`; a cut
//      before the log's first commit is `indeterminate`; two revisions of one
//      event in force, a supersession the log and the stored pointer disagree
//      on, or a seal whose counts the stored rows do not match is
//      `chain_inconsistent`; a seal whose identity epoch or pins differ from
//      the current meaning is `identity_changed` (the holder is kept and
//      listed); two holders of one (book, key) or (book, alias class) are a
//      conflict, listed, never washed; a book or a stored shape the fold
//      cannot take is `unsupported`.
//
// No I/O and no clock. The SQL half is
// `packages/read-model/src/economic-selector.ts`; the reconstruction adapter
// is `reconstruction-adapter.ts`.
import { canonicalJson, sha256Hex } from "./context.ts";
import {
  BOOKS,
  EVENT_TIME_ROLES,
  LEG_EFFECTS,
  parseConsumptionKey,
  validCommitRef,
  validKnowledgeCut,
  validKnownAt,
  type Book,
  type EventTimeRole,
  type IdentityPins,
  type KnowledgeCut,
  type RevisionRef,
} from "./economic-contract.ts";
import {
  ECONOMIC_EVENT_KINDS,
  EVENT_STATE_FAMILIES,
  LEG_ROLES,
  RECOGNITION_BASES,
  UNKNOWN_STATE_REASONS,
  type EconomicEventKind,
  type EventState,
  type LegRole,
  type RecognitionBasis,
  type UnknownStateReason,
} from "./events.ts";
import {
  hasExactKeys,
  isOneOf,
  isRecord,
  isRefList,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import {
  formatLocalDate,
  civilFromDays,
  parseInstant,
  validLocalDateText,
  validTemporalValue,
  type TemporalValue,
} from "./time.ts";
import { absentQuantity, exactQuantity, normalizeDecimal, type Quantity } from "./values.ts";

/** The release of this module's selection rules; pinned in every manifest that reads it. */
export const KNOWLEDGE_SELECTOR_RELEASE = "knowledge-selector-v1";
/** The shape of the loaded rows this module takes. */
export const ADOPTED_SELECTION_INPUT = "adopted-selection-input-v1";
/** The shape of what it returns. */
export const ADOPTED_SELECTION_CONTRACT = "adopted-selection-v1";

/**
 * Bounds on what one selection may load. A larger load is refused
 * (`selector_bound_exceeded`), never cut: the SQL half refuses before it
 * reads past them, and this module checks them again.
 */
export const SELECTOR_BOUNDS = {
  events: 2_000,
  revisions: 5_000,
  legs: 20_000,
  claims: 20_000,
  times: 25_000,
  effects: 20_000,
  commits: 5_000,
  subjects: 5_000,
  pins: 1_000,
  scopeAccounts: 16,
} as const;

// ---------------------------------------------------------------------------
// Cuts

/**
 * A cut resolved to a sequence of one core epoch. `commitSeq` 0 is the cut
 * before the first commit (an empty log, or an instant before it).
 */
export interface ResolvedCut {
  coreEpoch: string;
  commitSeq: number;
}

export function validResolvedCut(value: unknown): value is ResolvedCut {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["coreEpoch", "commitSeq"]) &&
    isText(value.coreEpoch, 64) &&
    isSafeInt(value.commitSeq, 0)
  );
}

/**
 * An instant cut in the one form `known_at` is stored in
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`), or null when it is not an instant. Known
 * instants have millisecond precision, so `known_at <= t` exactly when
 * `known_at <= floor_ms(t)`: a finer instant is floored, never rounded up.
 */
export function canonicalCutInstant(instant: string): string | null {
  const parsed = parseInstant(instant);
  if (parsed === null) return null;
  const ms = parsed.epochSeconds * 1000 + Math.floor(parsed.nanoseconds / 1_000_000);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const text = date.toISOString();
  return validKnownAt(text) ? text : null;
}

/** One commit of the log as the instant resolution reads it. */
export interface LogPoint {
  commitSeq: number;
  knownAt: string;
}

/**
 * The pure form of the instant resolution the SQL half runs: the largest
 * sequence whose known_at is at or before the instant, every commit of an
 * equal instant included; 0 when there is none. Used by tests as the oracle
 * of the SQL text.
 */
export function resolveInstantCut(log: readonly LogPoint[], instant: string): number | null {
  const bound = canonicalCutInstant(instant);
  if (bound === null) return null;
  let best = 0;
  for (const point of log)
    if (point.knownAt <= bound && point.commitSeq > best) best = point.commitSeq;
  return best;
}

// ---------------------------------------------------------------------------
// Scope

/** What a leg is, as the selector reports it: the stored effect row, or none (legacy). */
export const SELECTED_LEG_EFFECTS = [...LEG_EFFECTS, "undeclared"] as const;
export type SelectedLegEffect = (typeof SELECTED_LEG_EFFECTS)[number];

/**
 * What the caller asks about. Applied only after every touched event's
 * revision in force at the cut is resolved. A revision is in scope when its
 * kind matches and at least one leg it reaches (its own, or one of a revision
 * it superseded by the cut) matches every given dimension; an event is in
 * scope when one of its selected revisions is.
 */
export interface SelectionScope {
  /** Resolved account ids (`accounts.id`); a leg names one as `account:<id>` or bare. */
  accounts: string[];
  /** Leg unit refs; null for every unit. */
  instruments: string[] | null;
  kinds: EconomicEventKind[] | null;
  legEffects: SelectedLegEffect[] | null;
  /** Leg basis and the one time role a range is read from; null for every basis. */
  basis: { legBasis: RecognitionBasis; timeRole: EventTimeRole } | null;
  /**
   * Civil days (Asia/Tokyo), inclusive; needs `basis`. A revision without one
   * time of the role, or with a time not placeable on a day, is kept.
   */
  range: { from: string; to: string } | null;
}

export function validSelectionScope(value: unknown): value is SelectionScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["accounts", "instruments", "kinds", "legEffects", "basis", "range"]) ||
    !isRefList(value.accounts, SELECTOR_BOUNDS.scopeAccounts) ||
    value.accounts.length === 0 ||
    !(
      value.instruments === null ||
      (isRefList(value.instruments, 64) && value.instruments.length > 0)
    ) ||
    !(
      value.kinds === null ||
      (isRefList(value.kinds, ECONOMIC_EVENT_KINDS.length) &&
        value.kinds.length > 0 &&
        value.kinds.every((kind) => isOneOf(ECONOMIC_EVENT_KINDS)(kind)))
    ) ||
    !(
      value.legEffects === null ||
      (isRefList(value.legEffects, SELECTED_LEG_EFFECTS.length) &&
        value.legEffects.length > 0 &&
        value.legEffects.every((effect) => isOneOf(SELECTED_LEG_EFFECTS)(effect)))
    )
  )
    return false;
  const basis = value.basis;
  if (
    !(
      basis === null ||
      (isRecord(basis) &&
        hasExactKeys(basis, ["legBasis", "timeRole"]) &&
        isOneOf(RECOGNITION_BASES)(basis.legBasis) &&
        isOneOf(EVENT_TIME_ROLES)(basis.timeRole))
    )
  )
    return false;
  const range = value.range;
  if (range === null) return true;
  return (
    basis !== null &&
    isRecord(range) &&
    hasExactKeys(range, ["from", "to"]) &&
    validLocalDateText(range.from) &&
    validLocalDateText(range.to) &&
    range.from <= range.to
  );
}

// ---------------------------------------------------------------------------
// Loaded rows (what the SQL half hands over; one interface per table read)

export interface LoadedRevision {
  eventId: string;
  revision: number;
  kind: string;
  state: string;
  unknownReason: string | null;
  /** The stored `created_at`: informational, never used to select or order. */
  createdAt: string;
  /** The stored pointer `eventId@revision`, or null. */
  supersededBy: string | null;
}

export interface LoadedLeg {
  eventId: string;
  revision: number;
  legIndex: number;
  subjectRef: string;
  unitRef: string;
  valueStatus: string;
  coefficient: string | null;
  scale: number | null;
  valueReasonCode: string | null;
  role: string;
  basis: string;
}

/**
 * How a stored leg subject resolves: `account:<id>` (card purchases, every
 * new writer) or the bare id (card settlements, read under the 0044
 * tolerance) of an existing account; anything else is unrecognized.
 */
export const SUBJECT_FORMS = ["account-prefixed", "bare-account", "unrecognized"] as const;
export type SubjectForm = (typeof SUBJECT_FORMS)[number];
export interface LoadedSubject {
  subjectRef: string;
  accountId: string | null;
  form: SubjectForm;
}

/** One claim as `economic_revision_claims` (0070) lists it, legacy holders included. */
export interface LoadedClaim {
  eventId: string;
  revision: number;
  book: string;
  consumptionKey: string;
  aliasClass: string | null;
}

export interface LoadedTime {
  eventId: string;
  revision: number;
  role: string;
  temporalJson: string;
}

export interface LoadedEffect {
  eventId: string;
  revision: number;
  legIndex: number;
  effect: string;
  ofLegIndex: number | null;
}

export interface LoadedSeal {
  eventId: string;
  revision: number;
  writerRelease: string;
  legCount: number;
  claimCount: number;
  timeCount: number;
  effectCount: number;
  contentDigest: string;
  identityPinsJson: string;
  identityEpoch: string;
  coreEpoch: string;
  commitSeq: number;
}

export interface LoadedCommit {
  coreEpoch: string;
  commitSeq: number;
  kind: string;
  knownAt: string;
  membersJson: string;
}

/** The current revision of one pinned identity subject; null when no reader answers it. */
export interface LoadedPin {
  subject: string;
  currentRevision: number | null;
}

/** The first and last commit of the cut's epoch; all null for an empty log. */
export interface LogExtent {
  firstSeq: number | null;
  firstKnownAt: string | null;
  lastSeq: number | null;
  lastKnownAt: string | null;
}

export interface SelectorInput {
  contract: typeof ADOPTED_SELECTION_INPUT;
  requestedCut: KnowledgeCut;
  cut: ResolvedCut;
  /** known_at of the cut's commit; null for sequence 0. */
  cutKnownAt: string | null;
  currentCoreEpoch: string;
  currentIdentityEpoch: string;
  log: LogExtent;
  scope: SelectionScope;
  revisions: LoadedRevision[];
  legs: LoadedLeg[];
  subjects: LoadedSubject[];
  claims: LoadedClaim[];
  times: LoadedTime[];
  effects: LoadedEffect[];
  seals: LoadedSeal[];
  commits: LoadedCommit[];
  pins: LoadedPin[];
}

const intOrNull = (value: unknown, min = 0) => value === null || isSafeInt(value, min);

function validLoadedRevision(value: unknown): value is LoadedRevision {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "eventId",
      "revision",
      "kind",
      "state",
      "unknownReason",
      "createdAt",
      "supersededBy",
    ]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isText(value.kind, 64) &&
    isText(value.state, 64) &&
    isTextOrNull(value.unknownReason, 64) &&
    typeof value.createdAt === "string" &&
    isTextOrNull(value.supersededBy, 512)
  );
}

function validLoadedLeg(value: unknown): value is LoadedLeg {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "eventId",
      "revision",
      "legIndex",
      "subjectRef",
      "unitRef",
      "valueStatus",
      "coefficient",
      "scale",
      "valueReasonCode",
      "role",
      "basis",
    ]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isSafeInt(value.legIndex, 0) &&
    isText(value.subjectRef, 512) &&
    isText(value.unitRef, 128) &&
    isText(value.valueStatus, 32) &&
    isTextOrNull(value.coefficient, 4096) &&
    intOrNull(value.scale) &&
    isTextOrNull(value.valueReasonCode, 256) &&
    isText(value.role, 32) &&
    isText(value.basis, 64)
  );
}

function validLoadedSubject(value: unknown): value is LoadedSubject {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["subjectRef", "accountId", "form"]) &&
    isText(value.subjectRef, 512) &&
    isTextOrNull(value.accountId, 256) &&
    isOneOf(SUBJECT_FORMS)(value.form) &&
    (value.form === "unrecognized") === (value.accountId === null)
  );
}

function validLoadedClaim(value: unknown): value is LoadedClaim {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision", "book", "consumptionKey", "aliasClass"]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isText(value.book, 64) &&
    isText(value.consumptionKey, 2048) &&
    isTextOrNull(value.aliasClass, 2048)
  );
}

function validLoadedTime(value: unknown): value is LoadedTime {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision", "role", "temporalJson"]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isText(value.role, 32) &&
    isText(value.temporalJson, 4096)
  );
}

function validLoadedEffect(value: unknown): value is LoadedEffect {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "revision", "legIndex", "effect", "ofLegIndex"]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isSafeInt(value.legIndex, 0) &&
    isText(value.effect, 32) &&
    intOrNull(value.ofLegIndex)
  );
}

function validLoadedSeal(value: unknown): value is LoadedSeal {
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
      "identityPinsJson",
      "identityEpoch",
      "coreEpoch",
      "commitSeq",
    ]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isText(value.writerRelease, 128) &&
    isSafeInt(value.legCount, 0) &&
    isSafeInt(value.claimCount, 0) &&
    isSafeInt(value.timeCount, 0) &&
    isSafeInt(value.effectCount, 0) &&
    isText(value.contentDigest, 64) &&
    isText(value.identityPinsJson, 16_384) &&
    isText(value.identityEpoch, 64) &&
    isText(value.coreEpoch, 64) &&
    isSafeInt(value.commitSeq, 1)
  );
}

function validLoadedCommit(value: unknown): value is LoadedCommit {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["coreEpoch", "commitSeq", "kind", "knownAt", "membersJson"]) &&
    validCommitRef({ coreEpoch: value.coreEpoch, commitSeq: value.commitSeq }) &&
    isText(value.kind, 64) &&
    validKnownAt(value.knownAt) &&
    isText(value.membersJson, 65_536)
  );
}

function validLoadedPin(value: unknown): value is LoadedPin {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["subject", "currentRevision"]) &&
    isText(value.subject, 512) &&
    intOrNull(value.currentRevision)
  );
}

function validLogExtent(value: unknown): value is LogExtent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["firstSeq", "firstKnownAt", "lastSeq", "lastKnownAt"])
  )
    return false;
  const empty =
    value.firstSeq === null &&
    value.firstKnownAt === null &&
    value.lastSeq === null &&
    value.lastKnownAt === null;
  return (
    empty ||
    (isSafeInt(value.firstSeq, 1) &&
      isSafeInt(value.lastSeq, 1) &&
      value.firstSeq <= value.lastSeq &&
      validKnownAt(value.firstKnownAt) &&
      validKnownAt(value.lastKnownAt))
  );
}

// ---------------------------------------------------------------------------
// Result

export const SELECTION_REFUSALS = [
  "invalid_input",
  "invalid_cut",
  "invalid_scope",
  "selector_bound_exceeded",
  "cut_after_log_end",
] as const;
export type SelectionRefusal = (typeof SELECTION_REFUSALS)[number];
export interface SelectionError {
  code: SelectionRefusal;
  /** Input paths or counts; never stored content. */
  refs: string[];
}

/** A selected event's status at the cut. */
export const ADOPTED_STATUSES = ["active", "knowledge_unlogged", "chain_inconsistent"] as const;
export type AdoptedStatus = (typeof ADOPTED_STATUSES)[number];

/** Why a revision's knowledge is not placed by the log. */
export const UNLOGGED_REASONS = [
  /** No seal or no commit row: written before the log started, or by an older build. */
  "no_commit",
  /** Committed in another core epoch (a restored CORE starts a new history). */
  "other_core_epoch",
  /** Its stored successor pointer names a revision the log does not place. */
  "successor_unlogged",
] as const;
export type UnloggedReason = (typeof UNLOGGED_REASONS)[number];

export const INCONSISTENCY_REASONS = [
  "two_in_force_at_cut",
  "supersession_pointer_mismatch",
  "supersession_undeclared",
  "successor_committed_first",
  "superseded_revision_missing",
  "seal_commit_mismatch",
  "seal_count_mismatch",
  "pointer_target_missing",
] as const;
export type InconsistencyReason = (typeof INCONSISTENCY_REASONS)[number];

export const IDENTITY_CHANGE_REASONS = [
  "identity_epoch_changed",
  "identity_pin_moved",
  "identity_pin_unreadable",
] as const;
export type IdentityChangeReason = (typeof IDENTITY_CHANGE_REASONS)[number];

export const UNSUPPORTED_REASONS = [
  /** A claim in a book no writer is admitted for (`security-quantity`). */
  "book_unsupported",
  /** A stored claim key that is not a canonical consumption key. */
  "claim_key_unreadable",
  /** A time row whose JSON is not a temporal value, or a role outside the contract. */
  "time_unreadable",
  /** A stored leg value, role or basis outside the contract. */
  "leg_value_unreadable",
  /** An effect row that names no leg, a movement on a fee or unresolved leg, or a target that is not a movement. */
  "leg_effect_unreadable",
  /** A kind, state or unknown reason outside the contract. */
  "revision_unreadable",
  /** Seal identity pins that are not `{subject: revision}`. */
  "identity_pins_unreadable",
] as const;
export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number];

export const SELECTION_FLAGS = [
  "identity_changed",
  "claim_conflict",
  "alias_conflict",
  "unsupported",
] as const;
export type SelectionFlag = (typeof SELECTION_FLAGS)[number];

export interface SelectedLeg {
  legIndex: number;
  subjectRef: string;
  /** The resolved account, or null when the subject names none. */
  accountId: string | null;
  subjectForm: SubjectForm;
  /** Exact, or absent with the stored reason; never a zero. */
  quantity: Quantity;
  role: LegRole;
  basis: RecognitionBasis;
  /** The `economic_leg_effects` row, or `undeclared` for a leg without one. */
  effect: SelectedLegEffect;
  ofLegIndex: number | null;
}

export interface SelectedTime {
  role: EventTimeRole;
  time: TemporalValue;
}

export interface SelectedClaim {
  eventId: string;
  revision: number;
  book: Book;
  /** The stored key text (`json_array` of the 5-tuple). */
  key: string;
  /** The stored alias class text, or null (legacy holders and rule writers). */
  aliasClass: string | null;
}

export interface SelectedSeal {
  writerRelease: string;
  contentDigest: string;
  identityPins: IdentityPins;
  identityEpoch: string;
}

export interface SelectedCommit {
  coreEpoch: string;
  commitSeq: number;
  knownAt: string;
  kind: string;
}

/** One revision as known at the cut, fully loaded. */
export interface SelectedAdoptedRevision {
  eventId: string;
  revision: number;
  kind: EconomicEventKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  /** The event's status at the cut; every selected revision of an event carries it. */
  status: AdoptedStatus;
  /** The stored `created_at`; informational only. */
  createdAt: string;
  /** The commit that finalized it, when the log places it in the cut's epoch. */
  commit: SelectedCommit | null;
  /** What its commit says it superseded. */
  supersedes: RevisionRef[];
  /** The stored pointer when it is not in force, else null (a later successor is not known at the cut). */
  supersededBy: string | null;
  seal: SelectedSeal | null;
  legs: SelectedLeg[];
  times: SelectedTime[];
  claims: SelectedClaim[];
  flags: SelectionFlag[];
}

export interface SelectedConflict {
  dimension: "key" | "alias";
  book: Book;
  /** The key text, or the alias class text. */
  ref: string;
  /** `eventId@revision` of every holder in force (or not placed) at the cut, sorted. */
  holders: string[];
}

export interface UnloggedEntry extends RevisionRef {
  reasonCode: UnloggedReason;
}
export interface InconsistentEntry {
  eventId: string;
  reasonCode: InconsistencyReason;
}
export interface IdentityChangedEntry extends RevisionRef {
  reasons: IdentityChangeReason[];
}
export interface UnsupportedEntry extends RevisionRef {
  reasonCode: UnsupportedReason;
}

export const KNOWLEDGE_COVERAGE_STATUSES = ["logged", "partial", "indeterminate"] as const;
export type KnowledgeCoverageStatus = (typeof KNOWLEDGE_COVERAGE_STATUSES)[number];
export const KNOWLEDGE_COVERAGE_REASONS = [
  "log_empty",
  "cut_before_log_start",
  "cut_epoch_not_current",
  "knowledge_unlogged",
] as const;
export type KnowledgeCoverageReason = (typeof KNOWLEDGE_COVERAGE_REASONS)[number];

/** How far the log answers the scope at the cut. */
export interface KnowledgeCoverage {
  status: KnowledgeCoverageStatus;
  reasons: KnowledgeCoverageReason[];
  /**
   * The epoch's first commit. Its last commit is not part of the answer: it
   * moves with every later commit, which never changes an earlier cut.
   */
  logStart: { commitSeq: number; knownAt: string } | null;
}

export interface AdoptedSelectionBody {
  contract: typeof ADOPTED_SELECTION_CONTRACT;
  selectorRelease: typeof KNOWLEDGE_SELECTOR_RELEASE;
  requestedCut: KnowledgeCut;
  cut: ResolvedCut;
  cutKnownAt: string | null;
  scope: SelectionScope;
  currentIdentityEpoch: string;
  /** Sorted by (eventId, revision). */
  revisions: SelectedAdoptedRevision[];
  /**
   * The claims of the selected revisions: the holders at the cut (of an
   * `active` revision), or the possible holders the log does not place (a
   * `knowledge_unlogged` or `chain_inconsistent` one), by their revision's status.
   */
  claims: SelectedClaim[];
  conflicts: SelectedConflict[];
  unlogged: UnloggedEntry[];
  inconsistent: InconsistentEntry[];
  identityChanged: IdentityChangedEntry[];
  unsupported: UnsupportedEntry[];
  coverage: KnowledgeCoverage;
}

export interface AdoptedSelection extends AdoptedSelectionBody {
  /**
   * `sha256` of the canonical body: every row the answer at the cut depends
   * on, in its at-cut form. A row recorded after the cut is read (to place it
   * after the cut) but does not enter it, so a later commit leaves an earlier
   * cut's set version unchanged.
   */
  setVersion: string;
}

export type AdoptedSelectionResult =
  | { ok: true; selection: AdoptedSelection }
  | { ok: false; error: SelectionError };

// ---------------------------------------------------------------------------
// Helpers

const refText = (ref: RevisionRef) => `${ref.eventId}@${ref.revision}`;
const POINTER = /^(.+)@([1-9][0-9]*)$/u;

function parsePointer(text: string): RevisionRef | null {
  const match = POINTER.exec(text);
  if (match === null) return null;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) ? { eventId: match[1]!, revision } : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byRef(a: RevisionRef, b: RevisionRef): number {
  return cmp(a.eventId, b.eventId) || a.revision - b.revision;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list === undefined) out.set(k, [row]);
    else list.push(row);
  }
  return out;
}

const rowRef = (row: { eventId: string; revision: number }) => refText(row);

/** `members_json` of a commit row, or null when it is not the stored shape. */
function parseMembers(text: string): { member: RevisionRef; supersedes: RevisionRef[] }[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: { member: RevisionRef; supersedes: RevisionRef[] }[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["eventId", "revision", "supersedes"]) ||
      !isText(entry.eventId, 256) ||
      !isSafeInt(entry.revision, 1) ||
      !Array.isArray(entry.supersedes)
    )
      return null;
    const supersedes: RevisionRef[] = [];
    for (const prior of entry.supersedes) {
      if (
        !Array.isArray(prior) ||
        prior.length !== 2 ||
        !isText(prior[0], 256) ||
        !isSafeInt(prior[1], 1)
      )
        return null;
      supersedes.push({ eventId: prior[0] as string, revision: prior[1] as number });
    }
    out.push({ member: { eventId: entry.eventId, revision: entry.revision }, supersedes });
  }
  return out;
}

function parsePins(text: string): IdentityPins | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, revision] of Object.entries(value)) {
    if (!isText(key, 512) || !isSafeInt(revision, 0)) return null;
    out[key] = revision;
  }
  return out;
}

/** A stored leg value as a quantity; an inexact one keeps its stored reason (INV05). */
function legQuantity(leg: LoadedLeg): Quantity | null {
  if (leg.valueStatus === "exact") {
    if (leg.coefficient === null || leg.scale === null) return null;
    if (!/^(?:0|-?[1-9][0-9]*)$/u.test(leg.coefficient) || leg.scale > 4096) return null;
    return exactQuantity(
      leg.unitRef,
      normalizeDecimal(BigInt(leg.coefficient), leg.scale),
      "decimal-v1",
    );
  }
  if (
    leg.valueStatus === "missing" ||
    leg.valueStatus === "unparsed" ||
    leg.valueStatus === "conflict"
  )
    return leg.coefficient === null && leg.scale === null && leg.valueReasonCode !== null
      ? absentQuantity(leg.unitRef, leg.valueStatus, leg.valueReasonCode)
      : null;
  return null;
}

function parseTime(row: LoadedTime): SelectedTime | null {
  if (!isOneOf(EVENT_TIME_ROLES)(row.role)) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.temporalJson);
  } catch {
    return null;
  }
  return validTemporalValue(value) ? { role: row.role, time: value } : null;
}

const TOKYO_OFFSET_SECONDS = 9 * 3600;

/** The Tokyo civil day of a time, or null when it is not one day. */
function tokyoDay(time: TemporalValue): string | null {
  if (time.kind === "local-date")
    return time.zone === null || time.zone === "Asia/Tokyo" ? time.value : null;
  if (time.kind === "instant") {
    const parsed = parseInstant(time.value);
    if (parsed === null) return null;
    return formatLocalDate(
      civilFromDays(Math.floor((parsed.epochSeconds + TOKYO_OFFSET_SECONDS) / 86_400)),
    );
  }
  return null;
}

function checkBounds(input: SelectorInput): SelectionError | null {
  const counts: [keyof typeof SELECTOR_BOUNDS, number][] = [
    ["revisions", input.revisions.length],
    ["legs", input.legs.length],
    ["claims", input.claims.length],
    ["times", input.times.length],
    ["effects", input.effects.length],
    ["commits", input.commits.length],
    ["subjects", input.subjects.length],
    ["pins", input.pins.length],
    ["events", new Set(input.revisions.map((row) => row.eventId)).size],
  ];
  for (const [name, count] of counts)
    if (count > SELECTOR_BOUNDS[name])
      return { code: "selector_bound_exceeded", refs: [`${name}:${count}`] };
  return null;
}

function checkInput(value: unknown): SelectionError | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contract",
      "requestedCut",
      "cut",
      "cutKnownAt",
      "currentCoreEpoch",
      "currentIdentityEpoch",
      "log",
      "scope",
      "revisions",
      "legs",
      "subjects",
      "claims",
      "times",
      "effects",
      "seals",
      "commits",
      "pins",
    ]) ||
    value.contract !== ADOPTED_SELECTION_INPUT
  )
    return { code: "invalid_input", refs: ["$"] };
  for (const key of [
    "revisions",
    "legs",
    "subjects",
    "claims",
    "times",
    "effects",
    "seals",
    "commits",
    "pins",
  ] as const)
    if (!Array.isArray(value[key])) return { code: "invalid_input", refs: [key] };
  const bound = checkBounds(value as unknown as SelectorInput);
  if (bound !== null) return bound;
  if (!validKnowledgeCut(value.requestedCut) || !validResolvedCut(value.cut))
    return { code: "invalid_cut", refs: ["cut"] };
  if (
    !(value.cutKnownAt === null || validKnownAt(value.cutKnownAt)) ||
    (value.cut.commitSeq === 0) !== (value.cutKnownAt === null) ||
    value.requestedCut.coreEpoch !== value.cut.coreEpoch
  )
    return { code: "invalid_cut", refs: ["cutKnownAt"] };
  if (!validSelectionScope(value.scope)) return { code: "invalid_scope", refs: ["scope"] };
  if (
    !isText(value.currentCoreEpoch, 64) ||
    !isText(value.currentIdentityEpoch, 64) ||
    !validLogExtent(value.log)
  )
    return { code: "invalid_input", refs: ["log"] };
  const lastSeq = value.log.lastSeq ?? 0;
  if (value.cut.commitSeq > lastSeq) return { code: "cut_after_log_end", refs: ["cut"] };
  if ("commitSeq" in value.requestedCut && value.requestedCut.commitSeq !== value.cut.commitSeq)
    return { code: "invalid_cut", refs: ["requestedCut"] };
  const checks: [string, (row: unknown) => boolean][] = [
    ["revisions", validLoadedRevision],
    ["legs", validLoadedLeg],
    ["subjects", validLoadedSubject],
    ["claims", validLoadedClaim],
    ["times", validLoadedTime],
    ["effects", validLoadedEffect],
    ["seals", validLoadedSeal],
    ["commits", validLoadedCommit],
    ["pins", validLoadedPin],
  ];
  for (const [key, check] of checks) {
    const rows = value[key] as unknown[];
    for (const [index, row] of rows.entries())
      if (!check(row)) return { code: "invalid_input", refs: [`${key}[${index}]`] };
  }
  const input = value as unknown as SelectorInput;
  // One row per key, as the tables' primary keys guarantee.
  const unique: [string, string[]][] = [
    ["revisions", input.revisions.map(rowRef)],
    ["legs", input.legs.map((row) => `${rowRef(row)}#${row.legIndex}`)],
    ["subjects", input.subjects.map((row) => row.subjectRef)],
    [
      "claims",
      input.claims.map((row) => `${rowRef(row)}\u0000${row.book}\u0000${row.consumptionKey}`),
    ],
    ["times", input.times.map((row) => `${rowRef(row)}\u0000${row.role}`)],
    ["effects", input.effects.map((row) => `${rowRef(row)}#${row.legIndex}`)],
    ["seals", input.seals.map(rowRef)],
    ["commits", input.commits.map((row) => `${row.coreEpoch}\u0000${row.commitSeq}`)],
    ["pins", input.pins.map((row) => row.subject)],
  ];
  for (const [key, ids] of unique)
    if (new Set(ids).size !== ids.length) return { code: "invalid_input", refs: [key] };
  const known = new Set(input.revisions.map(rowRef));
  for (const key of ["legs", "claims", "times", "effects", "seals"] as const)
    for (const [index, row] of (input[key] as RevisionRef[]).entries())
      if (!known.has(rowRef(row))) return { code: "invalid_input", refs: [`${key}[${index}]`] };
  return null;
}

// ---------------------------------------------------------------------------
// The selector

type LogState =
  | { kind: "visible"; commit: SelectedCommit }
  | { kind: "later"; commit: SelectedCommit }
  | { kind: "unlogged"; reason: UnloggedReason };

/**
 * Select what was adopted as known at `input.cut`. Pure: the same rows in any
 * order give the same selection and the same set version.
 */
export async function selectAdopted(input: SelectorInput): Promise<AdoptedSelectionResult> {
  const problem = checkInput(input);
  if (problem !== null) return { ok: false, error: problem };
  const body = selectBody(input);
  return { ok: true, selection: { ...body, setVersion: await adoptedSetVersion(body) } };
}

/** The set version of a selection body: `sha256` of its canonical JSON. */
export async function adoptedSetVersion(body: AdoptedSelectionBody): Promise<string> {
  return sha256Hex(canonicalJson(body));
}

function selectBody(input: SelectorInput): AdoptedSelectionBody {
  const { cut } = input;
  const revisions = new Map(input.revisions.map((row) => [rowRef(row), row]));
  const byEvent = groupBy(input.revisions, (row) => row.eventId);
  const legsOf = groupBy(input.legs, rowRef);
  const claimsOf = groupBy(input.claims, rowRef);
  const timesOf = groupBy(input.times, rowRef);
  const effectsOf = groupBy(input.effects, rowRef);
  const seals = new Map(input.seals.map((row) => [rowRef(row), row]));
  const subjects = new Map(input.subjects.map((row) => [row.subjectRef, row]));
  const pins = new Map(input.pins.map((row) => [row.subject, row.currentRevision]));

  // Commits: parsed members, by (epoch, seq).
  const commits = new Map<
    string,
    { commit: SelectedCommit; members: Map<string, RevisionRef[]> | null }
  >();
  for (const row of input.commits) {
    const parsed = parseMembers(row.membersJson);
    commits.set(`${row.coreEpoch}\u0000${row.commitSeq}`, {
      commit: {
        coreEpoch: row.coreEpoch,
        commitSeq: row.commitSeq,
        knownAt: row.knownAt,
        kind: row.kind,
      },
      members:
        parsed === null
          ? null
          : new Map(parsed.map((entry) => [refText(entry.member), entry.supersedes])),
    });
  }

  const inconsistent = new Map<string, Set<InconsistencyReason>>();
  const markInconsistent = (eventId: string, reason: InconsistencyReason) => {
    const set = inconsistent.get(eventId) ?? new Set();
    set.add(reason);
    inconsistent.set(eventId, set);
  };

  // 1. Where the log places each revision.
  const logState = new Map<string, LogState>();
  const supersedesOf = new Map<string, RevisionRef[]>();
  for (const row of input.revisions) {
    const ref = rowRef(row);
    const seal = seals.get(ref);
    const entry =
      seal === undefined ? undefined : commits.get(`${seal.coreEpoch}\u0000${seal.commitSeq}`);
    if (seal === undefined || entry === undefined) {
      logState.set(ref, { kind: "unlogged", reason: "no_commit" });
      continue;
    }
    const declared = entry.members?.get(ref);
    if (declared === undefined) {
      // The seal names a commit that does not list it: the log cannot place it.
      markInconsistent(row.eventId, "seal_commit_mismatch");
      logState.set(ref, { kind: "unlogged", reason: "no_commit" });
      continue;
    }
    supersedesOf.set(ref, declared);
    if (entry.commit.coreEpoch !== cut.coreEpoch)
      logState.set(ref, { kind: "unlogged", reason: "other_core_epoch" });
    else
      logState.set(ref, {
        kind: entry.commit.commitSeq <= cut.commitSeq ? "visible" : "later",
        commit: entry.commit,
      });
  }

  // 2. Supersessions the log knows by the cut: a visible member's `supersedes`.
  const supersededAt = new Map<string, string>();
  for (const [ref, priors] of supersedesOf) {
    const state = logState.get(ref)!;
    if (state.kind !== "visible") continue;
    const member = revisions.get(ref)!;
    for (const prior of priors) {
      const priorRef = refText(prior);
      const priorRow = revisions.get(priorRef);
      if (priorRow === undefined) {
        markInconsistent(member.eventId, "superseded_revision_missing");
        continue;
      }
      supersededAt.set(priorRef, ref);
      if (priorRow.supersededBy !== ref) {
        markInconsistent(member.eventId, "supersession_pointer_mismatch");
        markInconsistent(priorRow.eventId, "supersession_pointer_mismatch");
      }
      const priorState = logState.get(priorRef)!;
      if (priorState.kind === "visible" && priorState.commit.commitSeq >= state.commit.commitSeq) {
        markInconsistent(member.eventId, "successor_committed_first");
        markInconsistent(priorRow.eventId, "successor_committed_first");
      }
    }
  }

  // 3. Per event: what is in force at the cut, and whether the log places it.
  const unloggedEntries: UnloggedEntry[] = [];
  const selectedRefs = new Map<
    string,
    { eventId: string; refs: string[]; status: AdoptedStatus }
  >();
  for (const [eventId, rows] of byEvent) {
    const inForce = rows.filter((row) => !supersededAt.has(rowRef(row)));
    const candidates: LoadedRevision[] = [];
    const unknown: LoadedRevision[] = [];
    for (const row of inForce) {
      const ref = rowRef(row);
      const state = logState.get(ref)!;
      if (state.kind === "unlogged") {
        unknown.push(row);
        unloggedEntries.push({ eventId, revision: row.revision, reasonCode: state.reason });
        continue;
      }
      if (state.kind === "later") continue;
      candidates.push(row);
      if (row.supersededBy === null) continue;
      const target = parsePointer(row.supersededBy);
      const targetRow = target === null ? undefined : revisions.get(refText(target));
      if (targetRow === undefined) {
        markInconsistent(eventId, "pointer_target_missing");
        continue;
      }
      const targetState = logState.get(refText(targetRow))!;
      if (targetState.kind === "unlogged") {
        // Superseded by a revision the log does not place: when is not known.
        unknown.push(row);
        unloggedEntries.push({ eventId, revision: row.revision, reasonCode: "successor_unlogged" });
      } else if (targetState.kind === "visible") {
        // A pointer to a visible revision no visible commit declared.
        markInconsistent(eventId, "supersession_undeclared");
      }
    }
    if (new Set(candidates.map(rowRef)).size > 1 && unknown.length === 0)
      markInconsistent(eventId, "two_in_force_at_cut");
    const relevant = [
      ...new Map([...candidates, ...unknown].map((row) => [rowRef(row), row])).values(),
    ];
    if (relevant.length === 0 && !inconsistent.has(eventId)) continue;
    const status: AdoptedStatus = inconsistent.has(eventId)
      ? "chain_inconsistent"
      : unknown.length > 0
        ? "knowledge_unlogged"
        : "active";
    selectedRefs.set(eventId, { eventId, refs: relevant.map(rowRef), status });
  }

  // Seals whose counts the stored rows do not match: the revision is not whole.
  for (const { eventId, refs } of selectedRefs.values())
    for (const ref of refs) {
      const seal = seals.get(ref);
      if (seal === undefined) continue;
      if (
        seal.legCount !== (legsOf.get(ref)?.length ?? 0) ||
        seal.claimCount !== (claimsOf.get(ref)?.length ?? 0) ||
        seal.timeCount !== (timesOf.get(ref)?.length ?? 0) ||
        seal.effectCount !== (effectsOf.get(ref)?.length ?? 0)
      ) {
        markInconsistent(eventId, "seal_count_mismatch");
        selectedRefs.get(eventId)!.status = "chain_inconsistent";
      }
    }
  for (const eventId of inconsistent.keys()) {
    const entry = selectedRefs.get(eventId);
    if (entry !== undefined) entry.status = "chain_inconsistent";
    else selectedRefs.set(eventId, { eventId, refs: [], status: "chain_inconsistent" });
  }

  // 4. Fully load every selected revision.
  const predecessors = new Map<string, string[]>();
  for (const [prior, successor] of supersededAt) {
    const list = predecessors.get(successor) ?? [];
    list.push(prior);
    predecessors.set(successor, list);
  }
  const unsupported = new Map<string, Set<UnsupportedReason>>();
  const markUnsupported = (ref: string, reason: UnsupportedReason) => {
    const set = unsupported.get(ref) ?? new Set();
    set.add(reason);
    unsupported.set(ref, set);
  };

  /** The stored pointer as known at the cut: hidden when it names a revision recorded later. */
  const atCutPointer = (row: LoadedRevision): string | null => {
    if (row.supersededBy === null) return null;
    const target = parsePointer(row.supersededBy);
    const state = target === null ? undefined : logState.get(refText(target));
    return state?.kind === "later" ? null : row.supersededBy;
  };

  const load = (ref: string, status: AdoptedStatus): SelectedAdoptedRevision => {
    const row = revisions.get(ref)!;
    const kindOk = isOneOf(ECONOMIC_EVENT_KINDS)(row.kind);
    const stateOk =
      kindOk &&
      (EVENT_STATE_FAMILIES[row.kind as EconomicEventKind] as readonly string[]).includes(
        row.state,
      );
    const reasonOk =
      row.state === "unknown"
        ? isOneOf(UNKNOWN_STATE_REASONS)(row.unknownReason)
        : row.unknownReason === null;
    if (!kindOk || !stateOk || !reasonOk) markUnsupported(ref, "revision_unreadable");
    const state = logState.get(ref)!;
    const effectRows = new Map(
      (effectsOf.get(ref) ?? []).map((effect) => [effect.legIndex, effect]),
    );
    const legRows = [...(legsOf.get(ref) ?? [])].sort((a, b) => a.legIndex - b.legIndex);
    const legIndexes = new Set(legRows.map((leg) => leg.legIndex));
    for (const effect of effectRows.values())
      if (
        !legIndexes.has(effect.legIndex) ||
        !isOneOf(LEG_EFFECTS)(effect.effect) ||
        (effect.effect === "movement") !== (effect.ofLegIndex === null)
      )
        markUnsupported(ref, "leg_effect_unreadable");
    const legs: SelectedLeg[] = [];
    for (const leg of legRows) {
      const quantity = legQuantity(leg);
      if (
        quantity === null ||
        !isOneOf(LEG_ROLES)(leg.role) ||
        !isOneOf(RECOGNITION_BASES)(leg.basis)
      ) {
        markUnsupported(ref, "leg_value_unreadable");
        continue;
      }
      const subject = subjects.get(leg.subjectRef);
      const effectRow = effectRows.get(leg.legIndex);
      const effect: SelectedLegEffect =
        effectRow !== undefined && isOneOf(LEG_EFFECTS)(effectRow.effect)
          ? effectRow.effect
          : "undeclared";
      legs.push({
        legIndex: leg.legIndex,
        subjectRef: leg.subjectRef,
        accountId: subject?.accountId ?? null,
        subjectForm: subject?.form ?? "unrecognized",
        quantity,
        role: leg.role,
        basis: leg.basis,
        effect,
        ofLegIndex: effectRow?.ofLegIndex ?? null,
      });
    }
    // A movement row on a leg without a direction, or a target that does not move.
    const legByIndex = new Map(legs.map((leg) => [leg.legIndex, leg]));
    const moves = (leg: SelectedLeg | undefined) =>
      leg !== undefined &&
      (leg.effect === "movement" ||
        (leg.effect === "undeclared" && (leg.role === "increase" || leg.role === "decrease")));
    for (const leg of legs) {
      if (leg.effect === "movement" && leg.role !== "increase" && leg.role !== "decrease")
        markUnsupported(ref, "leg_effect_unreadable");
      if (
        (leg.effect === "breakdown" || leg.effect === "correspondence") &&
        !moves(legByIndex.get(leg.ofLegIndex!))
      )
        markUnsupported(ref, "leg_effect_unreadable");
    }
    const times: SelectedTime[] = [];
    for (const time of timesOf.get(ref) ?? []) {
      const parsed = parseTime(time);
      if (parsed === null) markUnsupported(ref, "time_unreadable");
      else times.push(parsed);
    }
    times.sort((a, b) => cmp(a.role, b.role));
    const claims: SelectedClaim[] = [];
    for (const claim of claimsOf.get(ref) ?? []) {
      if (!isOneOf(BOOKS)(claim.book)) {
        markUnsupported(ref, "book_unsupported");
        continue;
      }
      if (claim.book === "security-quantity") markUnsupported(ref, "book_unsupported");
      if (parseConsumptionKey(claim.consumptionKey) === null)
        markUnsupported(ref, "claim_key_unreadable");
      claims.push({
        eventId: row.eventId,
        revision: row.revision,
        book: claim.book,
        key: claim.consumptionKey,
        aliasClass: claim.aliasClass,
      });
    }
    claims.sort((a, b) => cmp(a.book, b.book) || cmp(a.key, b.key));
    const sealRow = seals.get(ref);
    let seal: SelectedSeal | null = null;
    if (sealRow !== undefined) {
      const parsedPins = parsePins(sealRow.identityPinsJson);
      if (parsedPins === null) markUnsupported(ref, "identity_pins_unreadable");
      seal = {
        writerRelease: sealRow.writerRelease,
        contentDigest: sealRow.contentDigest,
        identityPins: parsedPins ?? {},
        identityEpoch: sealRow.identityEpoch,
      };
    }
    return {
      eventId: row.eventId,
      revision: row.revision,
      kind: (kindOk ? row.kind : "unknown") as EconomicEventKind,
      state: (stateOk ? row.state : "unknown") as EventState,
      unknownReason: (reasonOk ? row.unknownReason : null) as UnknownStateReason | null,
      status,
      createdAt: row.createdAt,
      commit: state.kind === "visible" ? state.commit : null,
      supersedes: state.kind === "visible" ? [...(supersedesOf.get(ref) ?? [])].sort(byRef) : [],
      // A pointer to a revision recorded after the cut is not known at the cut.
      supersededBy: atCutPointer(row),
      seal,
      legs,
      times,
      claims,
      flags: [],
    };
  };

  const selected = new Map<string, SelectedAdoptedRevision>();
  for (const { refs, status } of selectedRefs.values())
    for (const ref of refs) selected.set(ref, load(ref, status));
  // An inconsistent event with nothing in force still shows the revisions involved.
  for (const { eventId, refs, status } of selectedRefs.values())
    if (refs.length === 0)
      for (const row of byEvent.get(eventId) ?? []) {
        const ref = rowRef(row);
        if (logState.get(ref)!.kind !== "later") selected.set(ref, load(ref, status));
      }

  // 5. Holders at the cut and their conflicts, over every selected revision.
  const holders = new Map<
    string,
    { dimension: "key" | "alias"; book: Book; ref: string; refs: Set<string>; events: Set<string> }
  >();
  for (const revision of selected.values())
    for (const claim of revision.claims) {
      const dims: ["key" | "alias", string | null][] = [
        ["key", claim.key],
        ["alias", claim.aliasClass],
      ];
      for (const [dimension, value] of dims) {
        if (value === null) continue;
        const k = `${dimension}\u0000${claim.book}\u0000${value}`;
        const entry = holders.get(k) ?? {
          dimension,
          book: claim.book,
          ref: value,
          refs: new Set<string>(),
          events: new Set<string>(),
        };
        entry.refs.add(rowRef(revision));
        // A held class is in conflict with any other row: another event, or
        // another key of the same event (one fact under two keys).
        entry.events.add(
          dimension === "key" ? revision.eventId : `${revision.eventId}\u0000${claim.key}`,
        );
        holders.set(k, entry);
      }
    }
  const allConflicts = [...holders.values()]
    .filter((entry) => entry.events.size > 1)
    .map((entry): SelectedConflict => ({
      dimension: entry.dimension,
      book: entry.book,
      ref: entry.ref,
      holders: [...entry.refs].sort(cmp),
    }));

  // 6. The scope, after resolution: kind, and a leg the revision reaches.
  const scope = input.scope;
  const accountSet = new Set(scope.accounts);
  const legMatches = (owner: SelectedAdoptedRevision, leg: SelectedLeg) =>
    leg.accountId !== null &&
    accountSet.has(leg.accountId) &&
    (scope.instruments === null || scope.instruments.includes(leg.quantity.unitRef)) &&
    (scope.legEffects === null || scope.legEffects.includes(leg.effect)) &&
    (scope.basis === null || leg.basis === scope.basis.legBasis) &&
    inRange(owner);
  const inRange = (owner: SelectedAdoptedRevision) => {
    if (scope.range === null || scope.basis === null) return true;
    const role = scope.basis.timeRole;
    const own = owner.times.filter((time) => time.role === role);
    if (own.length !== 1) return true;
    const day = tokyoDay(own[0]!.time);
    return day === null || (day >= scope.range.from && day <= scope.range.to);
  };
  // Superseded predecessors, loaded once, only for the legs a successor reaches.
  const priorLoads = new Map<string, SelectedAdoptedRevision>();
  const reachedRevision = (ref: string): SelectedAdoptedRevision | undefined => {
    const found = selected.get(ref) ?? priorLoads.get(ref);
    if (found !== undefined || !revisions.has(ref)) return found;
    const loaded = load(ref, "active");
    priorLoads.set(ref, loaded);
    return loaded;
  };
  const reached = (ref: string): SelectedAdoptedRevision[] => {
    const out: SelectedAdoptedRevision[] = [];
    const seen = new Set<string>();
    const queue = [ref];
    while (queue.length > 0) {
      const at = queue.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      const revision = reachedRevision(at);
      if (revision !== undefined) out.push(revision);
      queue.push(...(predecessors.get(at) ?? []));
    }
    return out;
  };
  const inScopeEvents = new Set<string>();
  for (const revision of selected.values()) {
    if (scope.kinds !== null && !scope.kinds.includes(revision.kind)) continue;
    if (reached(rowRef(revision)).some((owner) => owner.legs.some((leg) => legMatches(owner, leg))))
      inScopeEvents.add(revision.eventId);
  }
  // A scoped event's unsupported shapes are reported against the revisions selected.
  const inScope = [...selected.values()]
    .filter((revision) => inScopeEvents.has(revision.eventId))
    .sort(byRef);
  const inScopeRefs = new Set(inScope.map(rowRef));

  // 7. Identity meaning, conflicts and unsupported shapes of the scoped revisions.
  const identityChanged: IdentityChangedEntry[] = [];
  for (const revision of inScope) {
    if (revision.seal === null) continue;
    const reasons = new Set<IdentityChangeReason>();
    if (revision.seal.identityEpoch !== input.currentIdentityEpoch)
      reasons.add("identity_epoch_changed");
    for (const [subject, pinned] of Object.entries(revision.seal.identityPins)) {
      const current = pins.get(subject);
      if (current === undefined || current === null) reasons.add("identity_pin_unreadable");
      else if (current !== pinned) reasons.add("identity_pin_moved");
    }
    if (reasons.size > 0) {
      identityChanged.push({
        eventId: revision.eventId,
        revision: revision.revision,
        reasons: IDENTITY_CHANGE_REASONS.filter((reason) => reasons.has(reason)),
      });
      revision.flags.push("identity_changed");
    }
  }
  const conflicts = allConflicts
    .filter((conflict) => conflict.holders.some((holder) => inScopeRefs.has(holder)))
    .sort((a, b) => cmp(a.dimension, b.dimension) || cmp(a.book, b.book) || cmp(a.ref, b.ref));
  for (const conflict of conflicts)
    for (const holder of conflict.holders) {
      const revision = selected.get(holder);
      const flag = conflict.dimension === "key" ? "claim_conflict" : "alias_conflict";
      if (revision !== undefined && inScopeRefs.has(holder) && !revision.flags.includes(flag))
        revision.flags.push(flag);
    }
  const unsupportedEntries: UnsupportedEntry[] = [];
  for (const revision of inScope) {
    const reasons = unsupported.get(rowRef(revision));
    if (reasons === undefined) continue;
    for (const reason of UNSUPPORTED_REASONS)
      if (reasons.has(reason))
        unsupportedEntries.push({
          eventId: revision.eventId,
          revision: revision.revision,
          reasonCode: reason,
        });
    revision.flags.push("unsupported");
  }
  for (const revision of inScope)
    revision.flags = SELECTION_FLAGS.filter((flag) => revision.flags.includes(flag));

  // 8. Coverage of the scope by the log at the cut.
  const log = input.log;
  const reasons: KnowledgeCoverageReason[] = [];
  if (log.lastSeq === null) reasons.push("log_empty");
  else if (cut.commitSeq < log.firstSeq!) reasons.push("cut_before_log_start");
  if (cut.coreEpoch !== input.currentCoreEpoch) reasons.push("cut_epoch_not_current");
  const unloggedInScope = unloggedEntries
    .filter((entry) => inScopeEvents.has(entry.eventId))
    .sort((a, b) => byRef(a, b) || cmp(a.reasonCode, b.reasonCode));
  if (unloggedInScope.length > 0) reasons.push("knowledge_unlogged");
  const status: KnowledgeCoverageStatus = reasons.some((reason) => reason !== "knowledge_unlogged")
    ? "indeterminate"
    : reasons.length > 0
      ? "partial"
      : "logged";

  const inconsistentEntries: InconsistentEntry[] = [];
  for (const [eventId, set] of inconsistent)
    if (inScopeEvents.has(eventId))
      for (const reason of INCONSISTENCY_REASONS)
        if (set.has(reason)) inconsistentEntries.push({ eventId, reasonCode: reason });
  inconsistentEntries.sort((a, b) => cmp(a.eventId, b.eventId) || cmp(a.reasonCode, b.reasonCode));

  return {
    contract: ADOPTED_SELECTION_CONTRACT,
    selectorRelease: KNOWLEDGE_SELECTOR_RELEASE,
    requestedCut: { ...input.requestedCut },
    cut: { coreEpoch: cut.coreEpoch, commitSeq: cut.commitSeq },
    cutKnownAt: input.cutKnownAt,
    scope: canonicalScope(scope),
    currentIdentityEpoch: input.currentIdentityEpoch,
    revisions: inScope,
    claims: inScope.flatMap((revision) => revision.claims),
    conflicts,
    unlogged: unloggedInScope,
    inconsistent: inconsistentEntries,
    identityChanged,
    unsupported: unsupportedEntries,
    coverage: {
      status,
      reasons,
      logStart:
        log.firstSeq === null ? null : { commitSeq: log.firstSeq, knownAt: log.firstKnownAt! },
    },
  };
}

function canonicalScope(scope: SelectionScope): SelectionScope {
  const sorted = <T extends string>(list: T[] | null) =>
    list === null ? null : [...list].sort(cmp);
  return {
    accounts: [...scope.accounts].sort(cmp),
    instruments: sorted(scope.instruments),
    kinds: sorted(scope.kinds),
    legEffects: sorted(scope.legEffects),
    basis: scope.basis === null ? null : { ...scope.basis },
    range: scope.range === null ? null : { ...scope.range },
  };
}

// Reconstructed state (docs/reconstructed-state.md, ADR 0052): a start
// snapshot plus the adopted events selected at a knowledge cut, folded per
// (account, unit) and per (account, instrument), and explained against the
// reported end snapshot with closed codes. Pure and synchronous: no I/O, no
// clock, no default policy. Nothing here totals across accounts or produces a
// net worth, nothing absent becomes zero, and a difference is shown, never
// absorbed into an invented adjustment.
//
// The event input is PROVISIONAL (`provisional-adopted-events-v1`): an
// adapter maps what the writers of `economic_event_revisions` store onto it,
// and it is replaced by the #549/#550 hand-off contract. The fold reads only
// the fields declared here.
import { canonicalJson } from "./context.ts";
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
  isArrayOf,
  isOneOf,
  isRecord,
  isRefList,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import {
  MEASUREMENT_KINDS,
  SIGN_MEANINGS,
  type MeasurementKind,
  type SignMeaning,
} from "./metrics.ts";
import type { ResultPartition } from "./calculation.ts";
import {
  addDays,
  civilFromDays,
  compareTemporal,
  daysFromCivil,
  formatLocalDate,
  parseInstant,
  parseLocalDate,
  validInstantText,
  validLocalDateText,
  validTemporalValue,
  type TemporalValue,
} from "./time.ts";
import {
  absentQuantity,
  compareQuantities,
  exactQuantity,
  negateDecimal,
  subtractQuantities,
  sumQuantities,
  validQuantity,
  type Quantity,
} from "./values.ts";

export const PROVISIONAL_EVENT_CONTRACT = "provisional-adopted-events-v1";
export const RECONSTRUCTED_STATE_SCHEMA = "reconstructed-state-v1";
/** The release of this module's selection and fold mechanics; pinned in every manifest. */
export const RECONSTRUCTION_ENGINE_RELEASE = "reconstruction-engine-v1";
export const RECONSTRUCTION_FOLD_POLICY_ID = "reconstruction-fold-v1";
/** The civil zone every capture and event time is projected into before placement. */
export const RECONSTRUCTION_ZONE = "Asia/Tokyo";
const ZONE_OFFSET_SECONDS = 9 * 3600;
/**
 * Input bounds. A larger input is refused (`event_budget_exceeded`,
 * `reported_budget_exceeded`), never cut to fit.
 */
export const RECONSTRUCTION_BUDGET = {
  revisions: 5_000,
  legs: 20_000,
  reportedRows: 5_000,
  coverageRows: 1_000,
} as const;

// ---------------------------------------------------------------------------
// Provisional adopted-event input
// ---------------------------------------------------------------------------

/** The writers of `economic_event_revisions` today. */
export const PROVISIONAL_WRITERS = [
  "card-purchase-recognition-v1",
  "card-settlement-review",
] as const;
export type ProvisionalWriter = (typeof PROVISIONAL_WRITERS)[number];

/**
 * A position in the adopted-decision history: the history cursor the common
 * guard assigns (ADR 0054, in preparation). It is not a D1 bookmark and not a
 * timestamp; `created_at` is never evidence of when a revision was adopted.
 */
export interface ProvisionalCommitRef {
  /** The history the sequence belongs to: a restored backup starts another epoch. */
  coreEpoch: string;
  commitSeq: number;
}
/** Everything committed in `coreEpoch` at or before `commitSeq` is known at the cut. */
export interface ProvisionalKnowledgeCut {
  coreEpoch: string;
  commitSeq: number;
}

/**
 * `full-chains`: every revision of every event that touches the target,
 * superseded ones included; the selector resolves them at the cut.
 * `resolved-at-cut`: the adapter already selected; the selector only checks
 * that no event has more than one revision.
 */
export const PROVISIONAL_RESOLUTIONS = ["full-chains", "resolved-at-cut"] as const;
export type ProvisionalResolution = (typeof PROVISIONAL_RESOLUTIONS)[number];

/** The time roles a revision may carry. A basis reads exactly one; there is no fallback. */
export const PROVISIONAL_TIME_ROLES = ["trade", "settlement", "posting", "usage", "value"] as const;
export type ProvisionalTimeRole = (typeof PROVISIONAL_TIME_ROLES)[number];
export interface ProvisionalTime {
  role: ProvisionalTimeRole;
  time: TemporalValue;
}

/**
 * What a leg is. A `movement` (direction `increase` or `decrease`) is what
 * moved and is applied once. A `breakdown` divides the movement `ofLegIndex`
 * names (a net debit of 101 into principal 100 and fee 1) for the cost
 * engine; a `correspondence` restates it on another reading (the obligation
 * a cash payment reduces, the settlement of a trade). Neither is ever added.
 */
export const PROVISIONAL_LEG_EFFECTS = ["movement", "breakdown", "correspondence"] as const;
export type ProvisionalLegEffect = (typeof PROVISIONAL_LEG_EFFECTS)[number];
export interface ProvisionalLeg {
  legIndex: number;
  /**
   * The account the adapter resolved from the stored subject, or null when it
   * recognised none. The two writers name it differently today (purchases
   * `account:<id>`, settlements the bare id); resolving them is the adapter's
   * rule, not a canonical form.
   */
  accountId: string | null;
  quantity: Quantity;
  effect: ProvisionalLegEffect;
  /** For a movement, its direction; for the others, the stored role. */
  role: LegRole;
  /** The movement leg of the same revision a breakdown or correspondence refers to. */
  ofLegIndex: number | null;
  basis: RecognitionBasis;
}

/** The exclusivity books of the common contract; one live holder per (book, key). */
export const PROVISIONAL_CLAIM_BOOKS = [
  "card-usage",
  "cash-movement",
  "security-quantity",
] as const;
export type ProvisionalClaimBook = (typeof PROVISIONAL_CLAIM_BOOKS)[number];
export interface ProvisionalClaim {
  book: ProvisionalClaimBook;
  key: string;
}

/** Conditions the adapter detects and the fold never applies through. */
export const PROVISIONAL_REVISION_FLAGS = [
  "identity_changed",
  "alias_conflict",
  "claim_conflict",
  "writer_unsupported",
] as const;
export type ProvisionalRevisionFlag = (typeof PROVISIONAL_REVISION_FLAGS)[number];

/**
 * One stored event revision as the provisional adapter hands it over. Replaced
 * by the #549/#550 hand-off contract; until then the fold reads only these
 * fields, and the questions the contract must answer are held in ADR 0052.
 */
export interface ProvisionalEventRevision {
  eventId: string;
  /** Need not start at 1: settlement revisions follow their review's revision. */
  revision: number;
  kind: EconomicEventKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  times: ProvisionalTime[];
  /** Null when no history cursor records the revision (`knowledge_unlogged`). */
  commitRef: ProvisionalCommitRef | null;
  /** The stored `created_at`, informational only: never used to select or order. */
  recordedAt: string;
  /** `eventId@revision` that replaced it (may name another event), or null. */
  supersededBy: string | null;
  legs: ProvisionalLeg[];
  /** Source facts cited, for explanation; duplicates are detected on `claims`. */
  evidenceIds: string[];
  claims: ProvisionalClaim[];
  flags: ProvisionalRevisionFlag[];
}
export const FAMILY_COVERAGE_STATUSES = ["evented", "not-evented", "unknown"] as const;
export type FamilyCoverageStatus = (typeof FAMILY_COVERAGE_STATUSES)[number];
/** Whether these transaction families of an account are turned into events at all. */
export interface ProvisionalFamilyCoverage {
  accountId: string;
  families: string[];
  status: FamilyCoverageStatus;
}
export const HISTORY_COVERAGE_STATUSES = ["complete", "gap", "unknown"] as const;
export type HistoryCoverageStatus = (typeof HISTORY_COVERAGE_STATUSES)[number];
/** Whether an account's transaction history is known complete over civil days `[from, to]` (Tokyo). */
export interface ProvisionalHistoryCoverage {
  accountId: string;
  from: string;
  to: string;
  status: HistoryCoverageStatus;
  /** Null exactly when `complete`. */
  reasonCode: string | null;
}
/** Versions the adapter read with, pinned in the manifest. The fold uses none of them. */
export interface ProvisionalManifestPins {
  identityRelease: string;
  evidenceAliasRelease: string;
  coverageRelease: string;
  /** No FX is applied here; an adapter names the reference set it read, if any. */
  fxReferenceRef: string | null;
  policyRefs: string[];
}
export interface ProvisionalAdoptedEventSet {
  contract: typeof PROVISIONAL_EVENT_CONTRACT;
  resolution: ProvisionalResolution;
  /** The adapter's digest of every row it read, supersession pointers included. */
  setVersion: string;
  adapterRelease: string;
  writers: ProvisionalWriter[];
  pins: ProvisionalManifestPins;
  revisions: ProvisionalEventRevision[];
  familyCoverage: ProvisionalFamilyCoverage[];
  historyCoverage: ProvisionalHistoryCoverage[];
}

// ---------------------------------------------------------------------------
// Reported sides and the request
// ---------------------------------------------------------------------------

export interface ReconstructionReportedBalance {
  ref: string;
  accountId: string;
  metricId: string;
  measurementKind: MeasurementKind;
  signMeaning: SignMeaning;
  /** As reported: exact, or absent with its reason. */
  quantity: Quantity;
  snapshotRef: string;
  /** The capture instant; projected to Tokyo before any placement. */
  capturedAt: string;
}
export interface ReconstructionReportedPosition {
  ref: string;
  accountId: string;
  /** Null when the instrument is not identified; its unit is then never matched. */
  instrumentId: string | null;
  /** The held quantity; its unit is the instrument id when one is identified. */
  quantity: Quantity;
  snapshotRef: string;
  capturedAt: string;
}
/** One reported side (start or end): the reported state of one date, pinned by its context id. */
export interface ReconstructionReportedSide {
  contextId: string;
  date: string;
  /** Requested accounts no reported container lists (card accounts, aggregators). */
  accountsWithoutContainer: string[];
  balances: ReconstructionReportedBalance[];
  positions: ReconstructionReportedPosition[];
}
export type StartSnapshot = ReconstructionReportedSide;
export type EndReported = ReconstructionReportedSide;

export const RECONSTRUCTION_BASES = ["cash", "trade-date", "settlement-date"] as const;
export type ReconstructionBasis = (typeof RECONSTRUCTION_BASES)[number];
export interface ReconstructionRequest {
  accountIds: string[];
  startDate: string;
  endDate: string;
  basis: ReconstructionBasis;
  /** The instant asked about, as the caller states it; informational. */
  knowledgeAt: string;
  /** The cut the adapter resolved `knowledgeAt` to; the selection must be at it. */
  knowledgeCut: ProvisionalKnowledgeCut;
}

// ---------------------------------------------------------------------------
// Fold policy
// ---------------------------------------------------------------------------

export const STATE_EFFECTS = ["applied", "pending-apart", "no-effect"] as const;
export type StateEffect = (typeof STATE_EFFECTS)[number];
export const LEG_EFFECT_RULES = [
  "apply-by-direction",
  "attribution-never-added",
  "link-never-added",
] as const;
export type LegEffectRule = (typeof LEG_EFFECT_RULES)[number];
/** A policy is data that never changes under its id: every level is read-only. */
export interface FoldPolicy {
  readonly policyId: typeof RECONSTRUCTION_FOLD_POLICY_ID;
  readonly zone: typeof RECONSTRUCTION_ZONE;
  /** Basis → the one leg basis and the one time role read. No fallback. */
  readonly bases: Readonly<
    Record<
      ReconstructionBasis,
      Readonly<{ legBasis: RecognitionBasis; timeRole: ProvisionalTimeRole }>
    >
  >;
  /** Kind → state → effect. A state absent here has an unknown effect. */
  readonly stateEffects: Readonly<
    Record<EconomicEventKind, Readonly<Partial<Record<EventState, StateEffect>>>>
  >;
  /** A movement adds when it is an `increase` and subtracts when a `decrease`. */
  readonly legEffects: Readonly<Record<ProvisionalLegEffect, LegEffectRule>>;
}

const STATE_EFFECT_V1: Partial<Record<EventState, StateEffect>> = {
  captured: "applied",
  debited: "applied",
  credited: "applied",
  confirmed: "applied",
  authorized: "pending-apart",
  requested: "pending-apart",
  "in-transit": "pending-apart",
  proposed: "pending-apart",
  canceled: "no-effect",
  returned: "no-effect",
  unknown: "no-effect",
};

function stateEffectsV1(): FoldPolicy["stateEffects"] {
  const out = {} as Record<EconomicEventKind, Partial<Record<EventState, StateEffect>>>;
  for (const kind of ECONOMIC_EVENT_KINDS) {
    const row: Partial<Record<EventState, StateEffect>> = {};
    for (const state of EVENT_STATE_FAMILIES[kind] as readonly EventState[]) {
      const effect = STATE_EFFECT_V1[state];
      if (effect !== undefined) row[state] = effect;
    }
    out[kind] = row;
  }
  return out;
}

/**
 * `reconstruction-fold-v1`. Callers pass it explicitly; the fold refuses any
 * other content under this id. `observed`, `issued` and `revised` (charges)
 * have no entry, so their effect is unknown.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const RECONSTRUCTION_FOLD_V1: FoldPolicy = deepFreeze({
  policyId: RECONSTRUCTION_FOLD_POLICY_ID,
  zone: RECONSTRUCTION_ZONE,
  bases: {
    cash: { legBasis: "cash-movement", timeRole: "posting" },
    "trade-date": { legBasis: "trade-date", timeRole: "trade" },
    "settlement-date": { legBasis: "settlement-date", timeRole: "settlement" },
  },
  stateEffects: stateEffectsV1(),
  legEffects: {
    movement: "apply-by-direction",
    breakdown: "attribution-never-added",
    correspondence: "link-never-added",
  },
} satisfies FoldPolicy);
/** The canonical text of v1, captured when the module loads. */
const FOLD_V1_TEXT = canonicalJson(RECONSTRUCTION_FOLD_V1);

// ---------------------------------------------------------------------------
// Closed codes
// ---------------------------------------------------------------------------

export const RECONSTRUCTION_REFUSALS = [
  "invalid_request",
  "invalid_policy",
  "invalid_event_set",
  "invalid_knowledge_cut",
  "invalid_start_snapshot",
  "invalid_end_reported",
  "selection_mismatch",
  "baseline_mismatch",
  "event_budget_exceeded",
  "reported_budget_exceeded",
  "coverage_budget_exceeded",
] as const;
export type ReconstructionRefusal = (typeof RECONSTRUCTION_REFUSALS)[number];
export interface ReconstructionError {
  code: ReconstructionRefusal;
  /** Input paths or counts; never provider content. */
  refs: string[];
}

export const SELECTION_STATUSES = [
  "active",
  "superseded_at_cut",
  "recorded_after_cut",
  "chain_inconsistent",
  "knowledge_unlogged",
] as const;
export type SelectionStatus = (typeof SELECTION_STATUSES)[number];

export const LEG_DISPOSITIONS = [
  "applied",
  "pending_shown_apart",
  "outside_range",
  "superseded_at_knowledge_time",
  "recorded_after_knowledge_time",
  "state_no_effect",
  "other_basis",
  "other_account",
  "boundary_same_day",
  "breakdown_attribution",
  "correspondence_link",
  "unknown_effect",
  "knowledge_unlogged",
  "identity_changed",
  "alias_conflict",
  "claim_conflict",
  "writer_unsupported",
] as const;
export type LegDisposition = (typeof LEG_DISPOSITIONS)[number];
/** Dispositions counted per cell as ignored: they neither add nor block. */
export const IGNORED_DISPOSITIONS = [
  "outside_range",
  "superseded_at_knowledge_time",
  "recorded_after_knowledge_time",
  "state_no_effect",
  "other_basis",
  "breakdown_attribution",
  "correspondence_link",
] as const;
export type IgnoredDisposition = (typeof IGNORED_DISPOSITIONS)[number];

/** Why a cell is not complete. All but the last three leave the figure absent. */
export const RECONSTRUCTION_GAPS = [
  "no_start_snapshot",
  "start_metric_not_stock",
  "start_sign_unknown",
  "start_ambiguous_metrics",
  "start_ambiguous_positions",
  "start_value_not_exact",
  "instrument_not_identified",
  "knowledge_unlogged",
  "revision_chain_inconsistent",
  "identity_changed",
  "alias_conflict",
  "claim_conflict",
  "writer_unsupported",
  "duplicate_claim",
  "leg_value_not_exact",
  "leg_sign_unknown",
  "event_time_unknown",
  "own_transfer_held",
  "leg_subject_unrecognized",
  "leg_effect_unknown",
  "family_not_evented",
  "history_coverage_unknown",
  "history_gap",
] as const;
export type ReconstructionGap = (typeof RECONSTRUCTION_GAPS)[number];
const SCOPE_GAPS: readonly ReconstructionGap[] = [
  "family_not_evented",
  "history_coverage_unknown",
  "history_gap",
];
/** Gaps a person must look at: a conflict or a changed meaning, not missing data. */
export const REVIEW_GAPS: readonly ReconstructionGap[] = [
  "revision_chain_inconsistent",
  "identity_changed",
  "alias_conflict",
  "claim_conflict",
  "writer_unsupported",
  "duplicate_claim",
];
const FLAG_ORDER: readonly ProvisionalRevisionFlag[] = PROVISIONAL_REVISION_FLAGS;

export const EXPLANATION_STATUSES = [
  "reconciled",
  "consistent_with_boundary_inclusion",
  "consistent_with_boundary_exclusion",
  "difference_unexplained",
  "not_comparable",
  "unavailable",
] as const;
export type ExplanationStatus = (typeof EXPLANATION_STATUSES)[number];
export const NOT_COMPARABLE_REASONS = [
  "reported_end_missing",
  "reported_end_not_exact",
  "reconstruction_incomplete",
  "snapshot_basis_unknown",
  "same_capture_as_start",
] as const;
export type NotComparableReason = (typeof NOT_COMPARABLE_REASONS)[number];
export const UNAVAILABLE_REASONS = ["no_reported_container"] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface SelectedRevision {
  revision: ProvisionalEventRevision;
  status: SelectionStatus;
  /** For `superseded_at_cut`: the revision that replaced it by the cut. */
  supersededAtCutBy: string | null;
}
/** A (book, key) more than one active event holds at the cut. */
export interface DuplicateClaim {
  book: ProvisionalClaimBook;
  key: string;
  /** `eventId@revision` of every active holder, sorted. */
  holders: string[];
}
/**
 * Step 1's output and the fold's event input: every revision of the set with
 * its status at the cut, resolved over the whole chains before any range,
 * account, instrument, kind or leg filter is applied.
 */
export interface KnowledgeSelection {
  contract: typeof PROVISIONAL_EVENT_CONTRACT;
  resolution: ProvisionalResolution;
  knowledgeCut: ProvisionalKnowledgeCut;
  setVersion: string;
  adapterRelease: string;
  writers: ProvisionalWriter[];
  pins: ProvisionalManifestPins;
  familyCoverage: ProvisionalFamilyCoverage[];
  historyCoverage: ProvisionalHistoryCoverage[];
  /** Sorted by (eventId, revision). */
  revisions: SelectedRevision[];
  inconsistentEvents: string[];
  unloggedEvents: string[];
  duplicateClaims: DuplicateClaim[];
}
/** The revisions whose being in force differs between two cuts of one scope. */
export interface LateExplanation {
  baselineCut: ProvisionalKnowledgeCut;
  cut: ProvisionalKnowledgeCut;
  /** Active at the cut, not at the baseline. */
  entered: string[];
  /** Active at the baseline, not at the cut. */
  left: string[];
}

export interface LegDispositionRecord {
  /** `eventId@revision#legIndex`, or `eventId@revision` for a revision without legs. */
  ref: string;
  eventId: string;
  revision: number;
  legIndex: number | null;
  accountId: string | null;
  unitRef: string | null;
  disposition: LegDisposition;
  gap: ReconstructionGap | null;
  conflict: "duplicate_claim" | null;
}
export interface ReconstructionStart {
  ref: string;
  snapshotRef: string;
  capturedAt: string;
  metricId: string | null;
  signMeaning: SignMeaning | null;
  /** As reported. */
  reported: Quantity;
  /** In the cell's asset-positive orientation (a liability-positive figure negated). */
  oriented: Quantity;
}
export interface ComponentTotal {
  count: number;
  /** Signed in the cell's orientation; exact (only exact legs reach a total). */
  total: Quantity;
  refs: string[];
}
export interface ReconstructionExplanation {
  status: ExplanationStatus;
  reasonCode: NotComparableReason | UnavailableReason | null;
  reported: ReconstructionStart | null;
  /** `reported − reconstructed`, exact when both are; never absorbed or written. */
  remainder: Quantity;
  /** Applied at the cut minus applied at the baseline cut; null without a baseline. */
  lateRecorded: { total: Quantity; refs: string[] } | null;
  pendingShownApart: { total: Quantity; refs: string[] };
  /** Candidates on a capture's Tokyo day: never adopted into the figure. */
  sameDayBoundary: { total: Quantity; refs: string[] };
}
export type ReconstructionWindowBound =
  | { kind: "capture"; capturedAt: string }
  | { kind: "end-of-date"; date: string };
export interface ReconstructedCell {
  accountId: string;
  measure: "balance" | "position" | "flow-only";
  /** The currency or instrument id; null for an unidentified position. */
  unitRef: string | null;
  /** The position row of an unidentified instrument, else null. */
  unidentifiedRef: string | null;
  orientation: "asset-positive";
  window: { from: ReconstructionWindowBound; to: ReconstructionWindowBound };
  start: ReconstructionStart | null;
  /** Start plus applied movements; absent with a reason whenever anything blocks it. */
  reconstructed: Quantity;
  applied: ComponentTotal;
  pending: ComponentTotal;
  boundary: ComponentTotal & { atStart: number; atEnd: number };
  ignored: Record<IgnoredDisposition, number>;
  unknown: { count: number; refs: string[] };
  gaps: ReconstructionGap[];
  partition: ResultPartition;
  needsReview: boolean;
  explanation: ReconstructionExplanation;
}
export interface ReconstructedAccount {
  accountId: string;
  startContainer: boolean;
  endContainer: boolean;
  familyCoverage: FamilyCoverageStatus | "not-declared";
  cells: number;
}
export interface ReconstructionManifest {
  schemaVersion: typeof RECONSTRUCTED_STATE_SCHEMA;
  engineRelease: typeof RECONSTRUCTION_ENGINE_RELEASE;
  inputContract: typeof PROVISIONAL_EVENT_CONTRACT;
  resolution: ProvisionalResolution;
  policies: string[];
  zone: typeof RECONSTRUCTION_ZONE;
  basis: ReconstructionBasis;
  range: { startDate: string; endDate: string };
  accountIds: string[];
  knowledgeAt: string;
  knowledgeCut: ProvisionalKnowledgeCut;
  baselineCut: ProvisionalKnowledgeCut | null;
  baselineSetVersion: string | null;
  startContextId: string;
  endContextId: string;
  eventSetVersion: string;
  adapterRelease: string;
  writers: ProvisionalWriter[];
  identityRelease: string;
  evidenceAliasRelease: string;
  coverageRelease: string;
  /** The coverage rows the fold read, in canonical order: the context id covers them. */
  coverage: {
    family: ProvisionalFamilyCoverage[];
    history: ProvisionalHistoryCoverage[];
  };
  fxReferenceRef: string | null;
  policyRefs: string[];
}
export interface ReconstructedState {
  schemaVersion: typeof RECONSTRUCTED_STATE_SCHEMA;
  basis: ReconstructionBasis;
  knowledgeCut: ProvisionalKnowledgeCut;
  zone: typeof RECONSTRUCTION_ZONE;
  accounts: ReconstructedAccount[];
  cells: ReconstructedCell[];
  dispositions: LegDispositionRecord[];
  /** Nothing is totalled across accounts. */
  netWorth: "not-computed";
  manifest: ReconstructionManifest;
}
export type ReconstructionResult =
  | { ok: true; state: ReconstructedState }
  | { ok: false; error: ReconstructionError };
export type KnowledgeSelectionResult =
  | { ok: true; selection: KnowledgeSelection }
  | { ok: false; error: ReconstructionError };
export type LateExplanationResult =
  | { ok: true; late: LateExplanation }
  | { ok: false; error: ReconstructionError };

// ---------------------------------------------------------------------------
// Validators (every one rejects unknown keys)
// ---------------------------------------------------------------------------

const EVENT_REF = /^(.+)@([1-9][0-9]*)$/u;

function validCut(value: unknown): value is ProvisionalKnowledgeCut {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["coreEpoch", "commitSeq"]) &&
    isText(value.coreEpoch, 64) &&
    isSafeInt(value.commitSeq, 0)
  );
}

const sameCut = (a: ProvisionalKnowledgeCut, b: ProvisionalKnowledgeCut) =>
  a.coreEpoch === b.coreEpoch && a.commitSeq === b.commitSeq;
const copyCut = (cut: ProvisionalKnowledgeCut): ProvisionalKnowledgeCut => ({
  coreEpoch: cut.coreEpoch,
  commitSeq: cut.commitSeq,
});

function validTime(value: unknown): value is ProvisionalTime {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["role", "time"]) &&
    isOneOf(PROVISIONAL_TIME_ROLES)(value.role) &&
    validTemporalValue(value.time)
  );
}

function validClaim(value: unknown): value is ProvisionalClaim {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["book", "key"]) &&
    isOneOf(PROVISIONAL_CLAIM_BOOKS)(value.book) &&
    isText(value.key, 512)
  );
}

export function validProvisionalLeg(value: unknown): value is ProvisionalLeg {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "legIndex",
      "accountId",
      "quantity",
      "effect",
      "role",
      "ofLegIndex",
      "basis",
    ]) ||
    !isSafeInt(value.legIndex, 0) ||
    !isTextOrNull(value.accountId, 256) ||
    !validQuantity(value.quantity) ||
    !isOneOf(PROVISIONAL_LEG_EFFECTS)(value.effect) ||
    !isOneOf(LEG_ROLES)(value.role) ||
    !isOneOf(RECOGNITION_BASES)(value.basis)
  )
    return false;
  // A movement has a direction and refers to nothing; the others refer to a movement.
  return value.effect === "movement"
    ? (value.role === "increase" || value.role === "decrease") && value.ofLegIndex === null
    : isSafeInt(value.ofLegIndex, 0) && value.ofLegIndex !== value.legIndex;
}

export function validProvisionalEventRevision(value: unknown): value is ProvisionalEventRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "eventId",
      "revision",
      "kind",
      "state",
      "unknownReason",
      "times",
      "commitRef",
      "recordedAt",
      "supersededBy",
      "legs",
      "evidenceIds",
      "claims",
      "flags",
    ]) ||
    !isText(value.eventId, 256) ||
    value.eventId.includes("@") ||
    !isSafeInt(value.revision, 1) ||
    !isOneOf(ECONOMIC_EVENT_KINDS)(value.kind) ||
    !isArrayOf(validTime, 16)(value.times) ||
    !(value.commitRef === null || validCut(value.commitRef)) ||
    !validInstantText(value.recordedAt) ||
    !(
      value.supersededBy === null ||
      (isText(value.supersededBy, 512) && EVENT_REF.test(value.supersededBy))
    ) ||
    !isArrayOf(validProvisionalLeg, 64)(value.legs) ||
    !isRefList(value.evidenceIds, 64) ||
    !isArrayOf(validClaim, 64)(value.claims) ||
    !isRefList(value.flags, PROVISIONAL_REVISION_FLAGS.length) ||
    !value.flags.every((flag) => isOneOf(PROVISIONAL_REVISION_FLAGS)(flag))
  )
    return false;
  const family: readonly string[] = EVENT_STATE_FAMILIES[value.kind];
  if (typeof value.state !== "string" || !family.includes(value.state)) return false;
  const reasonOk =
    value.state === "unknown"
      ? isOneOf(UNKNOWN_STATE_REASONS)(value.unknownReason)
      : value.unknownReason === null;
  const legs = value.legs;
  const byIndex = new Map(legs.map((leg) => [leg.legIndex, leg]));
  const claimKeys = value.claims.map((claim) => `${claim.book}\u0000${claim.key}`);
  return (
    reasonOk &&
    byIndex.size === legs.length &&
    new Set(claimKeys).size === claimKeys.length &&
    legs.every((leg) => {
      if (leg.ofLegIndex === null) return true;
      const target = byIndex.get(leg.ofLegIndex);
      if (target === undefined || target.effect !== "movement") return false;
      // A breakdown divides its movement, so it is in the movement's unit.
      return leg.effect !== "breakdown" || leg.quantity.unitRef === target.quantity.unitRef;
    })
  );
}

function validPins(value: unknown): value is ProvisionalManifestPins {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "identityRelease",
      "evidenceAliasRelease",
      "coverageRelease",
      "fxReferenceRef",
      "policyRefs",
    ]) &&
    isText(value.identityRelease, 256) &&
    isText(value.evidenceAliasRelease, 256) &&
    isText(value.coverageRelease, 256) &&
    isTextOrNull(value.fxReferenceRef, 256) &&
    isRefList(value.policyRefs, 64)
  );
}

function validFamilyCoverage(value: unknown): value is ProvisionalFamilyCoverage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["accountId", "families", "status"]) &&
    isText(value.accountId, 256) &&
    isRefList(value.families, 64) &&
    value.families.length > 0 &&
    isOneOf(FAMILY_COVERAGE_STATUSES)(value.status)
  );
}

function validHistoryCoverage(value: unknown): value is ProvisionalHistoryCoverage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["accountId", "from", "to", "status", "reasonCode"]) ||
    !isText(value.accountId, 256) ||
    !validLocalDateText(value.from) ||
    !validLocalDateText(value.to) ||
    value.from > value.to ||
    !isOneOf(HISTORY_COVERAGE_STATUSES)(value.status)
  )
    return false;
  return value.status === "complete" ? value.reasonCode === null : isText(value.reasonCode, 128);
}

/** Shape and budget of the provisional set; the budget is checked before any row. */
function checkEventSet(value: unknown): ReconstructionError | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contract",
      "resolution",
      "setVersion",
      "adapterRelease",
      "writers",
      "pins",
      "revisions",
      "familyCoverage",
      "historyCoverage",
    ]) ||
    !Array.isArray(value.revisions)
  )
    return { code: "invalid_event_set", refs: ["$"] };
  if (value.revisions.length > RECONSTRUCTION_BUDGET.revisions)
    return { code: "event_budget_exceeded", refs: [`revisions:${value.revisions.length}`] };
  const legs = value.revisions.reduce(
    (count: number, row: unknown) =>
      count + (isRecord(row) && Array.isArray(row.legs) ? row.legs.length : 0),
    0,
  );
  if (legs > RECONSTRUCTION_BUDGET.legs)
    return { code: "event_budget_exceeded", refs: [`legs:${legs}`] };
  for (const key of ["familyCoverage", "historyCoverage"] as const) {
    const rows = value[key];
    if (Array.isArray(rows) && rows.length > RECONSTRUCTION_BUDGET.coverageRows)
      return { code: "coverage_budget_exceeded", refs: [`${key}:${rows.length}`] };
  }
  if (
    value.contract !== PROVISIONAL_EVENT_CONTRACT ||
    !isOneOf(PROVISIONAL_RESOLUTIONS)(value.resolution) ||
    !isText(value.setVersion, 256) ||
    !isText(value.adapterRelease, 256) ||
    !isRefList(value.writers, PROVISIONAL_WRITERS.length) ||
    !value.writers.every((writer) => isOneOf(PROVISIONAL_WRITERS)(writer)) ||
    !validPins(value.pins) ||
    !isArrayOf(validFamilyCoverage, RECONSTRUCTION_BUDGET.coverageRows)(value.familyCoverage) ||
    !isArrayOf(validHistoryCoverage, RECONSTRUCTION_BUDGET.coverageRows)(value.historyCoverage)
  )
    return { code: "invalid_event_set", refs: ["$"] };
  const seen = new Set<string>();
  for (const [index, row] of value.revisions.entries()) {
    if (!validProvisionalEventRevision(row))
      return { code: "invalid_event_set", refs: [`revisions[${index}]`] };
    const ref = `${row.eventId}@${row.revision}`;
    if (seen.has(ref)) return { code: "invalid_event_set", refs: [`revisions[${index}]`] };
    seen.add(ref);
  }
  return null;
}

export function validProvisionalAdoptedEventSet(
  value: unknown,
): value is ProvisionalAdoptedEventSet {
  return checkEventSet(value) === null;
}

function captureTokyoDate(capturedAt: string): string | null {
  const projected = tokyoInstant(capturedAt);
  return projected === null ? null : projected.slice(0, 10);
}

function validReportedBalance(value: unknown): value is ReconstructionReportedBalance {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "ref",
      "accountId",
      "metricId",
      "measurementKind",
      "signMeaning",
      "quantity",
      "snapshotRef",
      "capturedAt",
    ]) &&
    isText(value.ref, 512) &&
    isText(value.accountId, 256) &&
    isText(value.metricId, 256) &&
    isOneOf(MEASUREMENT_KINDS)(value.measurementKind) &&
    isOneOf(SIGN_MEANINGS)(value.signMeaning) &&
    validQuantity(value.quantity) &&
    isText(value.snapshotRef, 512) &&
    validInstantText(value.capturedAt)
  );
}

function validReportedPosition(value: unknown): value is ReconstructionReportedPosition {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "ref",
      "accountId",
      "instrumentId",
      "quantity",
      "snapshotRef",
      "capturedAt",
    ]) &&
    isText(value.ref, 512) &&
    isText(value.accountId, 256) &&
    isTextOrNull(value.instrumentId, 256) &&
    validQuantity(value.quantity) &&
    (value.instrumentId === null || value.quantity.unitRef === value.instrumentId) &&
    isText(value.snapshotRef, 512) &&
    validInstantText(value.capturedAt)
  );
}

function checkReportedSide(
  value: unknown,
  date: string,
  code: "invalid_start_snapshot" | "invalid_end_reported",
): ReconstructionError | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contextId",
      "date",
      "accountsWithoutContainer",
      "balances",
      "positions",
    ]) ||
    !Array.isArray(value.balances) ||
    !Array.isArray(value.positions)
  )
    return { code, refs: ["$"] };
  const rows = value.balances.length + value.positions.length;
  if (rows > RECONSTRUCTION_BUDGET.reportedRows)
    return { code: "reported_budget_exceeded", refs: [`rows:${rows}`] };
  if (
    !isText(value.contextId, 256) ||
    value.date !== date ||
    !isRefList(value.accountsWithoutContainer, 1_000) ||
    !value.balances.every(validReportedBalance) ||
    !value.positions.every(validReportedPosition)
  )
    return { code, refs: ["$"] };
  const uncontained = new Set(value.accountsWithoutContainer);
  for (const row of [...value.balances, ...value.positions] as (
    | ReconstructionReportedBalance
    | ReconstructionReportedPosition
  )[]) {
    const captured = captureTokyoDate(row.capturedAt);
    // A side lists captures of its own Tokyo date or before it, and none for an
    // account it says no container lists.
    if (captured === null || captured > date || uncontained.has(row.accountId))
      return { code, refs: [row.ref] };
  }
  return null;
}

export function validReconstructionRequest(value: unknown): value is ReconstructionRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "accountIds",
      "startDate",
      "endDate",
      "basis",
      "knowledgeAt",
      "knowledgeCut",
    ]) &&
    isRefList(value.accountIds, 100) &&
    value.accountIds.length > 0 &&
    validLocalDateText(value.startDate) &&
    validLocalDateText(value.endDate) &&
    value.startDate < value.endDate &&
    isOneOf(RECONSTRUCTION_BASES)(value.basis) &&
    validInstantText(value.knowledgeAt) &&
    validCut(value.knowledgeCut)
  );
}

function sameCanonical(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/** Only the exact `reconstruction-fold-v1` content is accepted. */
export function validFoldPolicy(value: unknown): value is FoldPolicy {
  try {
    return canonicalJson(value) === FOLD_V1_TEXT;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Two validated instants in absolute order (`compareTemporal`'s instant branch). */
function compareInstants(a: string, b: string): -1 | 0 | 1 {
  const value = (text: string): TemporalValue => ({
    kind: "instant",
    value: text,
    zone: RECONSTRUCTION_ZONE,
    basis: "collector",
  });
  const order = compareTemporal(value(a), value(b));
  if (order.kind !== "ordered") throw new Error("instant_not_validated");
  return order.order;
}

/** The same instant written with the Tokyo offset, so its own calendar date is the Tokyo date. */
function tokyoInstant(text: string): string | null {
  const parsed = parseInstant(text);
  if (parsed === null) return null;
  const local = parsed.epochSeconds + ZONE_OFFSET_SECONDS;
  const days = Math.floor(local / 86_400);
  const second = local - days * 86_400;
  const pad = (n: number) => String(n).padStart(2, "0");
  const fraction =
    parsed.nanoseconds === 0
      ? ""
      : `.${String(parsed.nanoseconds).padStart(9, "0").replace(/0+$/u, "")}`;
  return `${formatLocalDate(civilFromDays(days))}T${pad(Math.floor(second / 3600))}:${pad(
    Math.floor((second % 3600) / 60),
  )}:${pad(second % 60)}${fraction}+09:00`;
}

function tokyoInstantValue(text: string): TemporalValue {
  return {
    kind: "instant",
    value: tokyoInstant(text)!,
    zone: RECONSTRUCTION_ZONE,
    basis: "collector",
  };
}

function tokyoDate(date: string): TemporalValue {
  return { kind: "local-date", value: date, zone: RECONSTRUCTION_ZONE, basis: "derived" };
}

/** An event time projected to Tokyo when it is an instant; dates and periods as written. */
function projectEventTime(time: TemporalValue): TemporalValue {
  if (time.kind !== "instant") return time;
  const projected = tokyoInstant(time.value);
  return projected === null
    ? { kind: "unknown", reasonCode: "invalid_instant" }
    : { kind: "instant", value: projected, zone: RECONSTRUCTION_ZONE, basis: time.basis };
}

// ---------------------------------------------------------------------------
// Step 1: knowledge selection
// ---------------------------------------------------------------------------

const refOf = (row: ProvisionalEventRevision) => `${row.eventId}@${row.revision}`;

function resolveAtCut(
  revisions: readonly ProvisionalEventRevision[],
  resolution: ProvisionalResolution,
  cut: ProvisionalKnowledgeCut,
): Omit<
  KnowledgeSelection,
  | "contract"
  | "resolution"
  | "knowledgeCut"
  | "setVersion"
  | "adapterRelease"
  | "writers"
  | "pins"
  | "familyCoverage"
  | "historyCoverage"
> {
  const byRef = new Map(revisions.map((row) => [refOf(row), row]));
  // A commit of another epoch belongs to another history: it cannot be placed
  // at this cut, exactly like a revision no history records.
  const logged = (row: ProvisionalEventRevision) =>
    row.commitRef !== null && row.commitRef.coreEpoch === cut.coreEpoch;
  const committed = (row: ProvisionalEventRevision) =>
    logged(row) && row.commitRef!.commitSeq <= cut.commitSeq;
  const unlogged = new Set<string>();
  const inconsistent = new Set<string>();
  const successorAtCut = new Map<string, ProvisionalEventRevision>();
  for (const row of revisions) if (!logged(row)) unlogged.add(row.eventId);
  if (resolution === "full-chains") {
    for (const row of revisions) {
      if (!committed(row) || row.supersededBy === null) continue;
      const target = byRef.get(row.supersededBy);
      // A pointer to a revision the input does not carry cannot be placed.
      if (target === undefined) {
        inconsistent.add(row.eventId);
        continue;
      }
      // Whether a successor without a history position is in force is not known.
      if (!logged(target)) {
        unlogged.add(row.eventId);
        continue;
      }
      if (!committed(target)) continue;
      successorAtCut.set(refOf(row), target);
      if (
        target === row ||
        (target.eventId === row.eventId && target.revision <= row.revision) ||
        target.commitRef!.commitSeq < row.commitRef!.commitSeq
      ) {
        inconsistent.add(row.eventId);
        inconsistent.add(target.eventId);
      }
    }
    // Cycles among the supersessions in force at the cut.
    const state = new Map<string, "walking" | "done">();
    for (const start of successorAtCut.keys()) {
      const path: string[] = [];
      let current: string | undefined = start;
      while (current !== undefined && state.get(current) !== "done") {
        if (state.get(current) === "walking") {
          for (const ref of path.slice(path.indexOf(current)))
            inconsistent.add(byRef.get(ref)!.eventId);
          break;
        }
        state.set(current, "walking");
        path.push(current);
        const next = successorAtCut.get(current);
        current = next === undefined ? undefined : refOf(next);
      }
      for (const ref of path) state.set(ref, "done");
    }
  }
  // More than one revision of one event in force at the cut.
  const live = new Map<string, number>();
  for (const row of revisions)
    if (committed(row) && !successorAtCut.has(refOf(row)))
      live.set(row.eventId, (live.get(row.eventId) ?? 0) + 1);
  for (const [eventId, count] of live) if (count > 1) inconsistent.add(eventId);
  const selected = revisions
    .map((row): SelectedRevision => {
      const plain = (status: SelectionStatus): SelectedRevision => ({
        revision: row,
        status,
        supersededAtCutBy: null,
      });
      if (!logged(row)) return plain("knowledge_unlogged");
      if (!committed(row)) return plain("recorded_after_cut");
      if (unlogged.has(row.eventId)) return plain("knowledge_unlogged");
      if (inconsistent.has(row.eventId)) return plain("chain_inconsistent");
      const by = successorAtCut.get(refOf(row));
      return by === undefined
        ? plain("active")
        : { revision: row, status: "superseded_at_cut", supersededAtCutBy: refOf(by) };
    })
    .sort(
      (a, b) =>
        cmp(a.revision.eventId, b.revision.eventId) || a.revision.revision - b.revision.revision,
    );
  // Holders at the cut come from the revisions selected at the cut, nothing else.
  const holders = new Map<
    string,
    { claim: ProvisionalClaim; refs: Set<string>; events: Set<string> }
  >();
  for (const { revision: row, status } of selected) {
    if (status !== "active") continue;
    for (const claim of row.claims) {
      const key = `${claim.book}\u0000${claim.key}`;
      const entry = holders.get(key) ?? { claim, refs: new Set(), events: new Set() };
      entry.refs.add(refOf(row));
      entry.events.add(row.eventId);
      holders.set(key, entry);
    }
  }
  const duplicateClaims = [...holders.values()]
    .filter((entry) => entry.events.size > 1)
    .map((entry) => ({
      book: entry.claim.book,
      key: entry.claim.key,
      holders: [...entry.refs].sort(cmp),
    }))
    .sort((a, b) => cmp(a.book, b.book) || cmp(a.key, b.key));
  return {
    revisions: selected,
    inconsistentEvents: [...inconsistent].sort(cmp),
    unloggedEvents: [...unlogged].sort(cmp),
    duplicateClaims,
  };
}

/**
 * Step 1, the knowledge selector. Every revision committed at or before the
 * cut is selected, then every event's active revision is resolved over the
 * complete chains (cross-event supersession included); only after that does
 * the fold filter by range, account, instrument, kind or leg. A correction of
 * a date, an account or an instrument and a dateless withdrawal therefore
 * always take part in deciding which revision is active. A revision is active
 * at the cut when its commit is at or before it and its successor's commit is
 * after it or absent; holders at the cut come only from those revisions,
 * never from a current-live flag, and `recordedAt` plays no part.
 */
export function selectKnowledge(
  eventSet: ProvisionalAdoptedEventSet,
  knowledgeCut: ProvisionalKnowledgeCut,
): KnowledgeSelectionResult {
  const problem = checkEventSet(eventSet);
  if (problem !== null) return { ok: false, error: problem };
  if (!validCut(knowledgeCut))
    return { ok: false, error: { code: "invalid_knowledge_cut", refs: ["knowledgeCut"] } };
  return {
    ok: true,
    selection: {
      contract: PROVISIONAL_EVENT_CONTRACT,
      resolution: eventSet.resolution,
      knowledgeCut: copyCut(knowledgeCut),
      setVersion: eventSet.setVersion,
      adapterRelease: eventSet.adapterRelease,
      writers: [...eventSet.writers].sort(cmp),
      pins: { ...eventSet.pins, policyRefs: [...eventSet.pins.policyRefs].sort(cmp) },
      familyCoverage: eventSet.familyCoverage,
      historyCoverage: eventSet.historyCoverage,
      ...resolveAtCut(eventSet.revisions, eventSet.resolution, knowledgeCut),
    },
  };
}

/** The selection is exactly what the selector gives for its own set and cut. */
function checkSelection(selection: KnowledgeSelection): ReconstructionError | null {
  if (!isRecord(selection) || !Array.isArray(selection.revisions))
    return { code: "selection_mismatch", refs: ["selection"] };
  const again = selectKnowledge(
    {
      contract: selection.contract,
      resolution: selection.resolution,
      setVersion: selection.setVersion,
      adapterRelease: selection.adapterRelease,
      writers: selection.writers,
      pins: selection.pins,
      revisions: selection.revisions.map((row) => row?.revision),
      familyCoverage: selection.familyCoverage,
      historyCoverage: selection.historyCoverage,
    } as ProvisionalAdoptedEventSet,
    selection.knowledgeCut,
  );
  if (!again.ok) return again.error;
  return sameCanonical(again.selection, selection)
    ? null
    : { code: "selection_mismatch", refs: ["selection"] };
}

/**
 * The late-recorded part of an explanation: a pure diff of two selections of
 * one scope at two cuts (the baseline is the cut the adapter resolves for the
 * end capture). Nothing here reads a timestamp.
 */
export function explainLate(
  baseline: KnowledgeSelection,
  now: KnowledgeSelection,
): LateExplanationResult {
  const problem = checkSelection(baseline) ?? checkSelection(now);
  if (problem !== null) return { ok: false, error: problem };
  return lateUnchecked(baseline, now);
}

/** `explainLate` for two selections already checked (each is checked once). */
function lateUnchecked(
  baseline: KnowledgeSelection,
  now: KnowledgeSelection,
): LateExplanationResult {
  if (
    baseline.contract !== now.contract ||
    baseline.resolution !== now.resolution ||
    baseline.adapterRelease !== now.adapterRelease ||
    // Full chains are one set read at two cuts; resolved sets differ per cut.
    (now.resolution === "full-chains" && baseline.setVersion !== now.setVersion) ||
    baseline.knowledgeCut.coreEpoch !== now.knowledgeCut.coreEpoch ||
    baseline.knowledgeCut.commitSeq > now.knowledgeCut.commitSeq
  )
    return { ok: false, error: { code: "baseline_mismatch", refs: ["baseline"] } };
  const activeRefs = (selection: KnowledgeSelection) =>
    new Set(
      selection.revisions
        .filter((row) => row.status === "active")
        .map((row) => refOf(row.revision)),
    );
  const then = activeRefs(baseline);
  const after = activeRefs(now);
  return {
    ok: true,
    late: {
      baselineCut: baseline.knowledgeCut,
      cut: now.knowledgeCut,
      entered: [...after].filter((ref) => !then.has(ref)).sort(cmp),
      left: [...then].filter((ref) => !after.has(ref)).sort(cmp),
    },
  };
}

// ---------------------------------------------------------------------------
// Steps 2–7: the fold
// ---------------------------------------------------------------------------

type Placement = "inside" | "boundary-start" | "boundary-end" | "outside" | "unknown";
type StartOutcome =
  | { kind: "row"; start: ReconstructionStart }
  | { kind: "gap"; gap: ReconstructionGap };
type EndOutcome =
  | { kind: "row"; end: ReconstructionStart }
  | { kind: "missing" }
  | { kind: "unusable" };

interface CellFrame {
  accountId: string;
  measure: ReconstructedCell["measure"];
  unitRef: string | null;
  /** The unit every quantity of the cell is in (an unidentified position's own unit). */
  unit: string;
  unidentifiedRef: string | null;
  start: StartOutcome;
  end: EndOutcome;
}

const STOCK_SIGNS: readonly SignMeaning[] = ["asset-positive", "liability-positive"];

function orient(quantity: Quantity, signMeaning: SignMeaning | null): Quantity {
  if (signMeaning !== "liability-positive" || quantity.value.status !== "exact") return quantity;
  return exactQuantity(quantity.unitRef, negateDecimal(quantity.value.value));
}

function balanceRow(row: ReconstructionReportedBalance): ReconstructionStart {
  return {
    ref: row.ref,
    snapshotRef: row.snapshotRef,
    capturedAt: row.capturedAt,
    metricId: row.metricId,
    signMeaning: row.signMeaning,
    reported: row.quantity,
    oriented: orient(row.quantity, row.signMeaning),
  };
}

function positionRow(row: ReconstructionReportedPosition): ReconstructionStart {
  return {
    ref: row.ref,
    snapshotRef: row.snapshotRef,
    capturedAt: row.capturedAt,
    metricId: null,
    signMeaning: null,
    reported: row.quantity,
    oriented: row.quantity,
  };
}

/**
 * One start (or end) per cell: one stock balance with a known sign, or one
 * identified position. A chosen row may still be absent-valued; the caller
 * names that (`start_value_not_exact`, `reported_end_not_exact`).
 */
function pickRow(
  balances: readonly ReconstructionReportedBalance[],
  positions: readonly ReconstructionReportedPosition[],
): StartOutcome {
  if (balances.length > 0 && positions.length > 0)
    return { kind: "gap", gap: "start_ambiguous_metrics" };
  if (positions.length > 1) return { kind: "gap", gap: "start_ambiguous_positions" };
  if (positions.length === 1) return { kind: "row", start: positionRow(positions[0]!) };
  if (balances.length === 0) return { kind: "gap", gap: "no_start_snapshot" };
  const eligible = balances.filter(
    (row) => row.measurementKind === "stock" && STOCK_SIGNS.includes(row.signMeaning),
  );
  if (eligible.length > 1) return { kind: "gap", gap: "start_ambiguous_metrics" };
  if (eligible.length === 1) return { kind: "row", start: balanceRow(eligible[0]!) };
  return balances.some((row) => row.measurementKind === "stock")
    ? { kind: "gap", gap: "start_sign_unknown" }
    : { kind: "gap", gap: "start_metric_not_stock" };
}

function endOutcome(pick: StartOutcome): EndOutcome {
  if (pick.kind === "row") return { kind: "row", end: pick.start };
  // Rows exist but none is one stock figure with a known sign: not the start's terms.
  return pick.gap === "no_start_snapshot" ? { kind: "missing" } : { kind: "unusable" };
}

interface LegView {
  selected: SelectedRevision;
  leg: ProvisionalLeg;
  ref: string;
}

interface Classified {
  disposition: LegDisposition;
  gap: ReconstructionGap | null;
  placement: Placement | null;
}

const classified = (
  disposition: LegDisposition,
  gap: ReconstructionGap | null = null,
  placement: Placement | null = null,
): Classified => ({ disposition, gap, placement });

/**
 * Steps 2 and 3 for one leg. Holds that come from the knowledge, the chain or
 * an adapter flag do not depend on the date; every other hold (an unmapped
 * state, an unresolved account, an own transfer, an inexact or negative value)
 * applies only to a leg inside the window, on its boundary, or without a time
 * to place it by. `accountKnown` is false for a leg no account resolves,
 * classified against each requested cell of its unit.
 */
function classifyLeg(
  view: LegView,
  policy: FoldPolicy,
  basis: ReconstructionBasis,
  place: (row: ProvisionalEventRevision) => Placement,
  accountKnown: boolean,
): Classified {
  const { leg, selected } = view;
  const row = selected.revision;
  const legBasis = policy.bases[basis].legBasis;
  if (selected.status === "recorded_after_cut") return classified("recorded_after_knowledge_time");
  if (selected.status === "superseded_at_cut") return classified("superseded_at_knowledge_time");
  if (leg.basis !== legBasis && leg.basis !== "unknown") return classified("other_basis");
  if (selected.status === "knowledge_unlogged")
    return classified("knowledge_unlogged", "knowledge_unlogged");
  if (selected.status === "chain_inconsistent")
    return classified("unknown_effect", "revision_chain_inconsistent");
  const flag = FLAG_ORDER.find((code) => row.flags.includes(code));
  if (flag !== undefined) return classified(flag, flag);
  // On an unknown basis even the time role to place it by is unknown.
  if (leg.basis === "unknown") return classified("unknown_effect", "leg_effect_unknown");
  const placement = place(row);
  const rule = policy.legEffects[leg.effect];
  if (rule === "link-never-added") return classified("correspondence_link", null, placement);
  if (rule === "attribution-never-added")
    return negative(leg.quantity) && placement !== "outside"
      ? classified("unknown_effect", "leg_sign_unknown", placement)
      : classified("breakdown_attribution", null, placement);
  const effect = policy.stateEffects[row.kind][row.state];
  if (effect === "no-effect") return classified("state_no_effect", null, placement);
  if (placement === "outside") return classified("outside_range", null, placement);
  if (effect === undefined) return classified("unknown_effect", "leg_effect_unknown", placement);
  if (!accountKnown) return classified("unknown_effect", "leg_subject_unrecognized", placement);
  const ownAccounts = new Set(
    row.legs.flatMap((other) =>
      other.effect === "movement" && other.basis === legBasis && other.accountId !== null
        ? [other.accountId]
        : [],
    ),
  );
  if (ownAccounts.size > 1) return classified("unknown_effect", "own_transfer_held", placement);
  if (placement === "unknown") return classified("unknown_effect", "event_time_unknown", placement);
  if (leg.quantity.value.status !== "exact")
    return classified("unknown_effect", "leg_value_not_exact", placement);
  if (negative(leg.quantity)) return classified("unknown_effect", "leg_sign_unknown", placement);
  if (placement !== "inside") return classified("boundary_same_day", null, placement);
  return classified(effect === "applied" ? "applied" : "pending_shown_apart", null, placement);
}

/**
 * The direction of a movement is its role; its value is a magnitude. A
 * negative value would be negated a second time by a decrease, so its sign is
 * unknown rather than guessed (0032 stores signed coefficients).
 */
function negative(quantity: Quantity): boolean {
  return quantity.value.status === "exact" && quantity.value.value.coefficient.startsWith("-");
}

function signed(leg: ProvisionalLeg): Quantity {
  const value = leg.quantity.value;
  if (value.status !== "exact") return leg.quantity;
  return leg.role === "decrease"
    ? exactQuantity(leg.quantity.unitRef, negateDecimal(value.value))
    : exactQuantity(leg.quantity.unitRef, value.value);
}

function total(unitRef: string, legs: readonly LegView[]): Quantity {
  const summed = sumQuantities(
    unitRef,
    legs.map((view) => signed(view.leg)),
  );
  // Only exact movements of the cell's unit reach a total.
  if (!summed.ok) throw new Error(summed.error.code);
  return summed.quantity;
}

function isZero(quantity: Quantity): boolean {
  return quantity.value.status === "exact" && quantity.value.value.coefficient === "0";
}

function equalQuantities(a: Quantity, b: Quantity): boolean {
  const compared = compareQuantities(a, b);
  return compared.ok && compared.order === 0;
}

function emptyIgnored(): Record<IgnoredDisposition, number> {
  return Object.fromEntries(IGNORED_DISPOSITIONS.map((code) => [code, 0])) as Record<
    IgnoredDisposition,
    number
  >;
}

function placer(
  policy: FoldPolicy,
  basis: ReconstructionBasis,
  from: ReconstructionWindowBound,
  to: ReconstructionWindowBound,
): (row: ProvisionalEventRevision) => Placement {
  const role = policy.bases[basis].timeRole;
  const fromValue =
    from.kind === "capture" ? tokyoInstantValue(from.capturedAt) : tokyoDate(from.date);
  const toValue = to.kind === "capture" ? tokyoInstantValue(to.capturedAt) : tokyoDate(to.date);
  return (row) => {
    const times = row.times.filter((time) => time.role === role);
    // No fallback to another role, and two times of one role are not chosen between.
    if (times.length !== 1) return "unknown";
    const time = projectEventTime(times[0]!.time);
    const before = compareTemporal(time, fromValue);
    if (before.kind === "incomparable") {
      if (before.reasonCode !== "within_day") return "unknown";
      // On the start capture's Tokyo day: either side of it. On the start date itself: in the start.
      return from.kind === "capture" ? "boundary-start" : "outside";
    }
    if (before.order < 0) return "outside";
    if (before.order === 0) return from.kind === "capture" ? "boundary-start" : "outside";
    const after = compareTemporal(time, toValue);
    if (after.kind === "incomparable") {
      if (after.reasonCode !== "within_day") return "unknown";
      return to.kind === "capture" ? "boundary-end" : "inside";
    }
    if (after.order > 0) return "outside";
    if (after.order === 0) return to.kind === "capture" ? "boundary-end" : "inside";
    return "inside";
  };
}

/** Civil days `[from, to]` covered by `complete` rows, and whether any `gap` row overlaps. */
function historyGaps(
  rows: readonly ProvisionalHistoryCoverage[],
  from: string,
  to: string,
): ReconstructionGap[] {
  const first = daysFromCivil(parseLocalDate(from)!);
  const last = daysFromCivil(parseLocalDate(to)!);
  const span = (row: ProvisionalHistoryCoverage) => ({
    start: daysFromCivil(parseLocalDate(row.from)!),
    end: daysFromCivil(parseLocalDate(row.to)!),
  });
  if (
    rows.some((row) => {
      if (row.status !== "gap") return false;
      const s = span(row);
      return s.start <= last && s.end >= first;
    })
  )
    return ["history_gap"];
  const complete = rows
    .filter((row) => row.status === "complete")
    .map(span)
    .sort((a, b) => a.start - b.start);
  let next = first;
  for (const s of complete) {
    if (s.start > next) break;
    next = Math.max(next, s.end + 1);
  }
  return next > last ? [] : ["history_coverage_unknown"];
}

interface FlagReach {
  /** `account\u0000unit` → flags of an active revision whose chain moved it. */
  cells: Map<string, Set<ProvisionalRevisionFlag>>;
  /** unit → flags, for chain legs no account resolves: every requested cell of the unit. */
  units: Map<string, Set<ProvisionalRevisionFlag>>;
}

/**
 * An active revision's adapter flags reach every cell its chain touched: its
 * own legs and those of every revision it superseded, directly or not. A
 * flagged withdrawal without legs therefore still blocks the cell of the
 * movement it withdrew.
 */
function flagReach(
  selection: KnowledgeSelection,
  legBasis: RecognitionBasis,
  requested: ReadonlySet<string>,
): FlagReach {
  const predecessors = new Map<string, ProvisionalEventRevision[]>();
  for (const { revision: row } of selection.revisions)
    if (row.supersededBy !== null) {
      const list = predecessors.get(row.supersededBy) ?? [];
      list.push(row);
      predecessors.set(row.supersededBy, list);
    }
  const reach: FlagReach = { cells: new Map(), units: new Map() };
  const add = <K>(
    map: Map<K, Set<ProvisionalRevisionFlag>>,
    key: K,
    flags: readonly ProvisionalRevisionFlag[],
  ) => {
    const set = map.get(key) ?? new Set();
    for (const flag of flags) set.add(flag);
    map.set(key, set);
  };
  for (const { revision: head, status } of selection.revisions) {
    if (status !== "active" || head.flags.length === 0) continue;
    const seen = new Set<string>();
    const queue = [head];
    while (queue.length > 0) {
      const row = queue.pop()!;
      if (seen.has(refOf(row))) continue;
      seen.add(refOf(row));
      for (const leg of row.legs) {
        if (leg.basis !== legBasis && leg.basis !== "unknown") continue;
        if (leg.accountId === null) add(reach.units, leg.quantity.unitRef, head.flags);
        else if (requested.has(leg.accountId))
          add(reach.cells, `${leg.accountId}\u0000${leg.quantity.unitRef}`, head.flags);
      }
      queue.push(...(predecessors.get(refOf(row)) ?? []));
    }
  }
  return reach;
}

/** Legs of a selection by cell key, `account\u0000unit`, or `\u0001unit` for no account. */
type LegIndex = Map<string, LegView[]>;

function indexLegs(selection: KnowledgeSelection): LegIndex {
  const index: LegIndex = new Map();
  for (const selected of selection.revisions)
    for (const leg of selected.revision.legs) {
      const key =
        leg.accountId === null
          ? `\u0001${leg.quantity.unitRef}`
          : `${leg.accountId}\u0000${leg.quantity.unitRef}`;
      const list = index.get(key) ?? [];
      list.push({ selected, leg, ref: `${refOf(selected.revision)}#${leg.legIndex}` });
      index.set(key, list);
    }
  return index;
}

function byAccount<T extends { accountId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.accountId) ?? [];
    list.push(row);
    out.set(row.accountId, list);
  }
  return out;
}

function frames(
  request: ReconstructionRequest,
  policy: FoldPolicy,
  start: StartSnapshot,
  end: EndReported,
  legs: LegIndex,
  reach: FlagReach,
): CellFrame[] {
  const legBasis = policy.bases[request.basis].legBasis;
  const sides = [start, end].map((side) => ({
    balances: byAccount(side.balances),
    positions: byAccount(side.positions),
  }));
  const legUnits = new Map<string, LegView[][]>();
  for (const [key, views] of legs) {
    if (key.startsWith("\u0001")) continue;
    const owner = key.slice(0, key.indexOf("\u0000"));
    const list = legUnits.get(owner) ?? [];
    list.push(views);
    legUnits.set(owner, list);
  }
  const out: CellFrame[] = [];
  for (const accountId of request.accountIds) {
    const keyed = new Map<string, CellFrame["measure"]>();
    const note = (unit: string, measure: CellFrame["measure"]) => {
      const seen = keyed.get(unit);
      if (seen === undefined || seen === "flow-only") keyed.set(unit, measure);
    };
    for (const side of sides) {
      for (const row of side.balances.get(accountId) ?? []) note(row.quantity.unitRef, "balance");
      for (const row of side.positions.get(accountId) ?? [])
        if (row.instrumentId !== null) note(row.instrumentId, "position");
    }
    // A leg not superseded and not after the cut opens its cell on the
    // selected basis; a superseded or later leg alone does not.
    for (const views of legUnits.get(accountId) ?? [])
      for (const { selected, leg } of views)
        if (
          selected.status !== "superseded_at_cut" &&
          selected.status !== "recorded_after_cut" &&
          (leg.basis === legBasis || leg.basis === "unknown")
        )
          note(leg.quantity.unitRef, "flow-only");
    // A cell a flagged chain touched is opened even when nothing in force moves it.
    for (const key of reach.cells.keys()) {
      const [owner, unit] = key.split("\u0000") as [string, string];
      if (owner === accountId) note(unit, "flow-only");
    }
    const [startSide, endSide] = sides as [(typeof sides)[number], (typeof sides)[number]];
    for (const [unit, measure] of keyed) {
      const pick = (side: (typeof sides)[number]) =>
        pickRow(
          (side.balances.get(accountId) ?? []).filter((row) => row.quantity.unitRef === unit),
          (side.positions.get(accountId) ?? []).filter((row) => row.instrumentId === unit),
        );
      out.push({
        accountId,
        measure,
        unitRef: unit,
        unit,
        unidentifiedRef: null,
        start: pick(startSide),
        end: endOutcome(pick(endSide)),
      });
    }
    for (const side of sides)
      for (const row of side.positions.get(accountId) ?? [])
        if (row.instrumentId === null)
          out.push({
            accountId,
            measure: "position",
            unitRef: null,
            unit: row.quantity.unitRef,
            unidentifiedRef: row.ref,
            start: { kind: "gap", gap: "instrument_not_identified" },
            end: { kind: "unusable" },
          });
  }
  return out;
}

function boundOf(capturedAt: string | null, date: string): ReconstructionWindowBound {
  return capturedAt === null ? { kind: "end-of-date", date } : { kind: "capture", capturedAt };
}

const ABSENT_GAPS: readonly ReconstructionGap[] = RECONSTRUCTION_GAPS.filter(
  (gap) => !SCOPE_GAPS.includes(gap),
);

interface CellFold {
  views: { view: LegView; classified: Classified }[];
}

function foldCell(
  frame: CellFrame,
  request: ReconstructionRequest,
  policy: FoldPolicy,
  legs: LegIndex,
  window: { from: ReconstructionWindowBound; to: ReconstructionWindowBound },
): CellFold {
  const place = placer(policy, request.basis, window.from, window.to);
  const views: CellFold["views"] = [];
  if (frame.unitRef === null) return { views };
  for (const key of [`${frame.accountId}\u0000${frame.unitRef}`, `\u0001${frame.unitRef}`])
    for (const view of legs.get(key) ?? []) {
      const known = view.leg.accountId !== null;
      views.push({ view, classified: classifyLeg(view, policy, request.basis, place, known) });
    }
  return { views };
}

function appliedOf(fold: CellFold): LegView[] {
  return fold.views
    .filter((item) => item.classified.disposition === "applied")
    .map((item) => item.view);
}

function isBlocking(disposition: LegDisposition): boolean {
  return (
    !COUNTED.includes(disposition) &&
    !(IGNORED_DISPOSITIONS as readonly string[]).includes(disposition)
  );
}

const COUNTED: readonly LegDisposition[] = ["applied", "pending_shown_apart", "boundary_same_day"];

/**
 * Steps 2–8. Pure and synchronous; the caller digests `manifest` with
 * `canonicalDigest`. `selection` is the selector's output at
 * `request.knowledgeCut`; `baseline`, when given, is the selection of the same
 * scope at the cut of the end capture, and yields `lateRecorded`.
 */
export function reconstructState(input: {
  request: ReconstructionRequest;
  policy: FoldPolicy;
  start: StartSnapshot;
  end: EndReported;
  selection: KnowledgeSelection;
  baseline: KnowledgeSelection | null;
}): ReconstructionResult {
  const { request, policy, start, end, selection, baseline } = input;
  if (!validReconstructionRequest(request))
    return { ok: false, error: { code: "invalid_request", refs: ["request"] } };
  if (!validFoldPolicy(policy))
    return { ok: false, error: { code: "invalid_policy", refs: ["policy"] } };
  const startProblem = checkReportedSide(start, request.startDate, "invalid_start_snapshot");
  if (startProblem !== null) return { ok: false, error: startProblem };
  const endProblem = checkReportedSide(end, request.endDate, "invalid_end_reported");
  if (endProblem !== null) return { ok: false, error: endProblem };
  const selectionProblem = checkSelection(selection);
  if (selectionProblem !== null) return { ok: false, error: selectionProblem };
  if (!sameCut(selection.knowledgeCut, request.knowledgeCut))
    return { ok: false, error: { code: "selection_mismatch", refs: ["selection.knowledgeCut"] } };
  if (baseline !== null) {
    const baselineProblem = checkSelection(baseline);
    if (baselineProblem !== null)
      return { ok: false, error: { code: "baseline_mismatch", refs: baselineProblem.refs } };
    const late = lateUnchecked(baseline, selection);
    if (!late.ok) return { ok: false, error: { code: "baseline_mismatch", refs: late.error.refs } };
  }

  const legBasis = policy.bases[request.basis].legBasis;
  const requested = new Set(request.accountIds);
  const reach = flagReach(selection, legBasis, requested);
  const legs = indexLegs(selection);
  const baselineLegs = baseline === null ? null : indexLegs(baseline);
  const cellFrames = frames(request, policy, start, end, legs, reach);
  const cellKey = (accountId: string, unit: string) => `${accountId}\u0000${unit}`;
  const cellKeys = new Set(
    cellFrames.flatMap((frame) =>
      frame.unitRef === null ? [] : [cellKey(frame.accountId, frame.unitRef)],
    ),
  );
  const duplicated = new Set(selection.duplicateClaims.flatMap((claim) => claim.holders));

  const cellUnits = new Set(
    cellFrames.flatMap((frame) => (frame.unitRef === null ? [] : [frame.unitRef])),
  );
  const requestPlace = placer(
    policy,
    request.basis,
    { kind: "end-of-date", date: request.startDate },
    { kind: "end-of-date", date: request.endDate },
  );
  // Legs outside every cell are recorded here; a leg of a cell is recorded
  // with its cell below, and a leg no account resolves once after the cells
  // (it is classified against every requested cell of its unit), so every
  // leg has exactly one record.
  const records: LegDispositionRecord[] = [];
  const strays = new Map<string, { record: LegDispositionRecord; outcomes: Classified[] }>();
  for (const selected of selection.revisions) {
    const row = selected.revision;
    const effect = policy.stateEffects[row.kind][row.state];
    const flag = FLAG_ORDER.find((code) => row.flags.includes(code)) ?? null;
    const base = { eventId: row.eventId, revision: row.revision, conflict: null };
    const statusDisposition: LegDisposition | null =
      selected.status === "recorded_after_cut"
        ? "recorded_after_knowledge_time"
        : selected.status === "superseded_at_cut"
          ? "superseded_at_knowledge_time"
          : null;
    if (row.legs.length === 0) {
      const disposition: LegDisposition =
        statusDisposition ??
        (selected.status === "knowledge_unlogged"
          ? "knowledge_unlogged"
          : selected.status === "chain_inconsistent"
            ? "unknown_effect"
            : (flag ?? (effect === "no-effect" ? "state_no_effect" : "unknown_effect")));
      records.push({
        ...base,
        ref: refOf(row),
        legIndex: null,
        accountId: null,
        unitRef: null,
        disposition,
        gap:
          selected.status === "chain_inconsistent"
            ? "revision_chain_inconsistent"
            : selected.status === "knowledge_unlogged"
              ? "knowledge_unlogged"
              : statusDisposition !== null
                ? null
                : (flag ?? (effect === "no-effect" ? null : "leg_effect_unknown")),
      });
      continue;
    }
    for (const leg of row.legs) {
      const unitRef = leg.quantity.unitRef;
      const ref = `${refOf(row)}#${leg.legIndex}`;
      const common = { ...base, ref, legIndex: leg.legIndex, accountId: leg.accountId, unitRef };
      if (leg.accountId === null) {
        const record = { ...common, disposition: "unknown_effect" as LegDisposition, gap: null };
        if (cellUnits.has(unitRef)) strays.set(ref, { record, outcomes: [] });
        else {
          const view = { selected, leg, ref };
          const outcome = classifyLeg(view, policy, request.basis, requestPlace, false);
          records.push({ ...record, disposition: outcome.disposition, gap: outcome.gap });
        }
        continue;
      }
      if (cellKeys.has(cellKey(leg.accountId, unitRef))) continue;
      if (statusDisposition !== null)
        records.push({ ...common, disposition: statusDisposition, gap: null });
      else if (leg.basis !== legBasis && leg.basis !== "unknown")
        records.push({ ...common, disposition: "other_basis", gap: null });
      // A requested account's leg on the selected basis, not superseded and
      // not after the cut, always opens a cell, so only another account's
      // leg reaches here (a test checks that every leg has one record).
      else records.push({ ...common, disposition: "other_account", gap: null });
    }
  }

  const familyByAccount = byAccount(selection.familyCoverage);
  const historyByAccount = byAccount(selection.historyCoverage);
  const familyRows = (accountId: string) => familyByAccount.get(accountId) ?? [];
  const cells: ReconstructedCell[] = [];
  for (const frame of cellFrames) {
    const startRow = frame.start.kind === "row" ? frame.start.start : null;
    const endRow = frame.end.kind === "row" ? frame.end.end : null;
    const inverted =
      startRow !== null &&
      endRow !== null &&
      compareInstants(endRow.capturedAt, startRow.capturedAt) < 0;
    const from = boundOf(startRow?.capturedAt ?? null, request.startDate);
    const to = boundOf(endRow === null || inverted ? null : endRow.capturedAt, request.endDate);
    const window = { from, to };
    const fold = foldCell(frame, request, policy, legs, window);
    const unit = frame.unit;

    // Step 4: a (book, key) held by two active events, on a leg that reaches a total.
    const conflicted = new Set(
      fold.views
        .filter(
          (item) =>
            COUNTED.includes(item.classified.disposition) &&
            duplicated.has(refOf(item.view.selected.revision)),
        )
        .map((item) => item.view.ref),
    );

    const gaps = new Set<ReconstructionGap>();
    if (frame.start.kind === "gap") gaps.add(frame.start.gap);
    else if (frame.start.start.reported.value.status !== "exact") gaps.add("start_value_not_exact");
    if (start.accountsWithoutContainer.includes(frame.accountId)) gaps.add("no_start_snapshot");
    for (const item of fold.views) if (item.classified.gap !== null) gaps.add(item.classified.gap);
    if (conflicted.size > 0) gaps.add("duplicate_claim");
    if (frame.unitRef !== null)
      for (const flag of [
        ...(reach.cells.get(cellKey(frame.accountId, frame.unitRef)) ?? []),
        ...(reach.units.get(frame.unitRef) ?? []),
      ])
        gaps.add(flag);
    const family = familyRows(frame.accountId);
    if (family.length === 0 || family.some((row) => row.status !== "evented"))
      gaps.add("family_not_evented");
    const fromDate =
      from.kind === "capture"
        ? captureTokyoDate(from.capturedAt)!
        : formatLocalDate(addDays(parseLocalDate(from.date)!, 1));
    const toDate = to.kind === "capture" ? captureTokyoDate(to.capturedAt)! : to.date;
    if (fromDate <= toDate)
      for (const gap of historyGaps(historyByAccount.get(frame.accountId) ?? [], fromDate, toDate))
        gaps.add(gap);

    const by = (disposition: LegDisposition) =>
      fold.views
        .filter((item) => item.classified.disposition === disposition)
        .map((item) => item.view);
    const appliedViews = by("applied");
    const pendingViews = by("pending_shown_apart");
    const boundaryItems = fold.views.filter(
      (item) => item.classified.disposition === "boundary_same_day",
    );
    const boundaryViews = boundaryItems.map((item) => item.view);
    const blockedRefs = fold.views
      .filter(
        (item) =>
          !COUNTED.includes(item.classified.disposition) &&
          !(IGNORED_DISPOSITIONS as readonly string[]).includes(item.classified.disposition),
      )
      .map((item) => item.view.ref);
    const unknownRefs = blockedRefs.sort(cmp);
    const appliedTotal = total(unit, appliedViews);
    const ignored = emptyIgnored();
    for (const item of fold.views)
      if ((IGNORED_DISPOSITIONS as readonly string[]).includes(item.classified.disposition))
        ignored[item.classified.disposition as IgnoredDisposition] += 1;

    // Step 5: the figure, or its absence with the first blocking reason. A
    // blocked leg always carries its gap; this keeps the rule if one does not.
    if (unknownRefs.length > 0 && ![...gaps].some((gap) => ABSENT_GAPS.includes(gap)))
      gaps.add("leg_effect_unknown");
    const sortedGaps = RECONSTRUCTION_GAPS.filter((gap) => gaps.has(gap));
    const blocking = sortedGaps.find((gap) => ABSENT_GAPS.includes(gap));
    let reconstructed: Quantity;
    if (blocking !== undefined) reconstructed = absentQuantity(unit, "missing", blocking);
    else {
      const summed = sumQuantities(unit, [startRow!.oriented, appliedTotal]);
      reconstructed = summed.ok
        ? summed.quantity
        : absentQuantity(unit, "missing", summed.error.code);
    }
    const partition: ResultPartition =
      reconstructed.value.status !== "exact"
        ? "not-computable"
        : sortedGaps.length > 0
          ? "partial-verified-scope"
          : "complete";

    // Step 7: the explanation against the reported end.
    const pendingTotal = total(unit, pendingViews);
    const boundaryTotal = total(unit, boundaryViews);
    let status: ExplanationStatus;
    let reasonCode: ReconstructionExplanation["reasonCode"] = null;
    if (end.accountsWithoutContainer.includes(frame.accountId)) {
      status = "unavailable";
      reasonCode = "no_reported_container";
    } else if (frame.unitRef === null) {
      status = "not_comparable";
      reasonCode = "reconstruction_incomplete";
    } else if (frame.end.kind === "missing") {
      status = "not_comparable";
      reasonCode = "reported_end_missing";
    } else if (
      startRow !== null &&
      endRow !== null &&
      startRow.snapshotRef === endRow.snapshotRef &&
      compareInstants(startRow.capturedAt, endRow.capturedAt) === 0
    ) {
      // No capture after the start: the end would compare a snapshot with itself.
      status = "not_comparable";
      reasonCode = "same_capture_as_start";
    } else if (
      frame.end.kind === "unusable" ||
      request.basis !== "cash" ||
      inverted ||
      (startRow !== null && endRow !== null && startRow.metricId !== endRow.metricId)
    ) {
      status = "not_comparable";
      reasonCode = "snapshot_basis_unknown";
    } else if (endRow!.oriented.value.status !== "exact") {
      status = "not_comparable";
      reasonCode = "reported_end_not_exact";
    } else if (partition !== "complete") {
      status = "not_comparable";
      reasonCode = "reconstruction_incomplete";
    } else {
      status = "difference_unexplained";
    }
    // The remainder is shown whenever both figures are exact on the same
    // terms, an incomplete reconstruction included; it is never absorbed.
    const difference =
      endRow !== null && (reasonCode === null || reasonCode === "reconstruction_incomplete")
        ? subtractQuantities(endRow.oriented, reconstructed)
        : null;
    const remainder: Quantity =
      difference !== null && difference.ok
        ? difference.quantity
        : absentQuantity(unit, "missing", reasonCode ?? "reconstruction_incomplete");
    if (status === "difference_unexplained") {
      if (boundaryViews.length === 0) {
        if (isZero(remainder)) status = "reconciled";
      } else if (isZero(remainder)) status = "consistent_with_boundary_exclusion";
      else if (equalQuantities(remainder, boundaryTotal))
        status = "consistent_with_boundary_inclusion";
    }
    let lateRecorded: ReconstructionExplanation["lateRecorded"] = null;
    if (baseline !== null && endRow !== null && reasonCode !== "no_reported_container") {
      const earlier = appliedOf(foldCell(frame, request, policy, baselineLegs!, window));
      const late = subtractQuantities(appliedTotal, total(unit, earlier));
      const now = new Set(appliedViews.map((view) => view.ref));
      const then = new Set(earlier.map((view) => view.ref));
      lateRecorded = {
        total: late.ok ? late.quantity : absentQuantity(unit, "missing", late.error.code),
        refs: [
          ...[...now].filter((ref) => !then.has(ref)),
          ...[...then].filter((ref) => !now.has(ref)),
        ].sort(cmp),
      };
    }

    for (const { view, classified: item } of fold.views)
      if (view.leg.accountId === null) strays.get(view.ref)?.outcomes.push(item);
      else
        records.push({
          ref: view.ref,
          eventId: view.selected.revision.eventId,
          revision: view.selected.revision.revision,
          legIndex: view.leg.legIndex,
          accountId: view.leg.accountId,
          unitRef: view.leg.quantity.unitRef,
          disposition: item.disposition,
          gap: item.gap,
          conflict: conflicted.has(view.ref) ? "duplicate_claim" : null,
        });

    const refsOf = (views: readonly LegView[]) => views.map((view) => view.ref).sort(cmp);
    cells.push({
      accountId: frame.accountId,
      measure: frame.measure,
      unitRef: frame.unitRef,
      unidentifiedRef: frame.unidentifiedRef,
      orientation: "asset-positive",
      window,
      start: startRow,
      reconstructed,
      applied: { count: appliedViews.length, total: appliedTotal, refs: refsOf(appliedViews) },
      pending: { count: pendingViews.length, total: pendingTotal, refs: refsOf(pendingViews) },
      boundary: {
        count: boundaryViews.length,
        total: boundaryTotal,
        refs: refsOf(boundaryViews),
        atStart: boundaryItems.filter((item) => item.classified.placement === "boundary-start")
          .length,
        atEnd: boundaryItems.filter((item) => item.classified.placement === "boundary-end").length,
      },
      ignored,
      unknown: { count: unknownRefs.length, refs: unknownRefs },
      gaps: sortedGaps,
      partition,
      needsReview: sortedGaps.some((gap) => REVIEW_GAPS.includes(gap)),
      explanation: {
        status,
        reasonCode,
        reported: endRow,
        remainder,
        lateRecorded,
        pendingShownApart: { total: pendingTotal, refs: refsOf(pendingViews) },
        sameDayBoundary: { total: boundaryTotal, refs: refsOf(boundaryViews) },
      },
    });
  }
  // A leg no account resolves: the most severe of its outcomes over the cells
  // of its unit, chosen by the closed code order so input order cannot matter.
  const rank = (item: Classified) =>
    (isBlocking(item.disposition) ? 0 : 1) * 10_000 +
    (item.gap === null ? RECONSTRUCTION_GAPS.length : RECONSTRUCTION_GAPS.indexOf(item.gap)) * 100 +
    LEG_DISPOSITIONS.indexOf(item.disposition);
  for (const { record, outcomes } of strays.values()) {
    const chosen = [...outcomes].sort((a, b) => rank(a) - rank(b))[0]!;
    records.push({ ...record, disposition: chosen.disposition, gap: chosen.gap });
  }
  cells.sort(
    (a, b) =>
      cmp(a.accountId, b.accountId) ||
      cmp(a.measure, b.measure) ||
      cmp(a.unitRef ?? "", b.unitRef ?? "") ||
      cmp(a.unidentifiedRef ?? "", b.unidentifiedRef ?? ""),
  );
  records.sort(
    (a, b) =>
      cmp(a.eventId, b.eventId) ||
      a.revision - b.revision ||
      (a.legIndex ?? -1) - (b.legIndex ?? -1),
  );
  const accountIds = [...request.accountIds].sort(cmp);
  const accounts: ReconstructedAccount[] = accountIds.map((accountId) => {
    const family = familyRows(accountId);
    return {
      accountId,
      startContainer: !start.accountsWithoutContainer.includes(accountId),
      endContainer: !end.accountsWithoutContainer.includes(accountId),
      familyCoverage:
        family.length === 0
          ? "not-declared"
          : family.some((row) => row.status === "not-evented")
            ? "not-evented"
            : family.some((row) => row.status === "unknown")
              ? "unknown"
              : "evented",
      cells: cells.filter((cell) => cell.accountId === accountId).length,
    };
  });
  const manifest: ReconstructionManifest = {
    schemaVersion: RECONSTRUCTED_STATE_SCHEMA,
    engineRelease: RECONSTRUCTION_ENGINE_RELEASE,
    inputContract: PROVISIONAL_EVENT_CONTRACT,
    resolution: selection.resolution,
    policies: [policy.policyId],
    zone: RECONSTRUCTION_ZONE,
    basis: request.basis,
    range: { startDate: request.startDate, endDate: request.endDate },
    accountIds,
    knowledgeAt: request.knowledgeAt,
    knowledgeCut: copyCut(request.knowledgeCut),
    baselineCut: baseline === null ? null : copyCut(baseline.knowledgeCut),
    baselineSetVersion: baseline === null ? null : baseline.setVersion,
    startContextId: start.contextId,
    endContextId: end.contextId,
    eventSetVersion: selection.setVersion,
    adapterRelease: selection.adapterRelease,
    writers: selection.writers,
    identityRelease: selection.pins.identityRelease,
    evidenceAliasRelease: selection.pins.evidenceAliasRelease,
    coverageRelease: selection.pins.coverageRelease,
    coverage: canonicalCoverage(selection),
    fxReferenceRef: selection.pins.fxReferenceRef,
    policyRefs: selection.pins.policyRefs,
  };
  return {
    ok: true,
    state: {
      schemaVersion: RECONSTRUCTED_STATE_SCHEMA,
      basis: request.basis,
      knowledgeCut: copyCut(request.knowledgeCut),
      zone: RECONSTRUCTION_ZONE,
      accounts,
      cells,
      dispositions: records,
      netWorth: "not-computed",
      manifest,
    },
  };
}

function canonicalCoverage(selection: KnowledgeSelection): ReconstructionManifest["coverage"] {
  const family = selection.familyCoverage
    .map((row) => ({ ...row, families: [...row.families].sort(cmp) }))
    .sort(
      (a, b) =>
        cmp(a.accountId, b.accountId) ||
        cmp(a.status, b.status) ||
        cmp(a.families.join("\u0000"), b.families.join("\u0000")),
    );
  const history = selection.historyCoverage
    .map((row) => ({ ...row }))
    .sort(
      (a, b) =>
        cmp(a.accountId, b.accountId) ||
        cmp(a.from, b.from) ||
        cmp(a.to, b.to) ||
        cmp(a.status, b.status) ||
        cmp(a.reasonCode ?? "", b.reasonCode ?? ""),
    );
  return { family, history };
}

/**
 * Step 8: the canonical text of a manifest (`canonical-json-v1`). The caller
 * digests it (`canonicalDigest(manifest)` is `sha256Hex` of this text); the
 * fold itself stays synchronous.
 */
export function canonicalReconstructionManifest(manifest: ReconstructionManifest): string {
  return canonicalJson(manifest);
}

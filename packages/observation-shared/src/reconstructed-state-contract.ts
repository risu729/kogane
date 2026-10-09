// The wire shape of `GET /api/v2/reconstructed-state` and of the agent tool
// `kogane.reconstructed-state.read` (docs/reconstructed-state.md, ADR 0058).
// Shape only: the client recalculates nothing. Every object has exactly the
// fields the query returns, so an answer that carries a figure the contract
// does not name (an adjustment, a total, a net worth) is refused rather than
// displayed; every status, reason and disposition is a closed code; and an
// answer without a reconstruction must say why (`economic_guard_missing`).
//
// The status and reason lists are restated here rather than imported from
// `packages/application`, whose query module carries the selector's SQL: the
// client bundle reads the HTTP contract, never a query builder. A test pins
// both lists to the query's own (apps/web/test/reconstructed-state-contract.test.ts).
import { RESULT_PARTITIONS } from "../../domain/src/calculation.ts";
import { SIGN_MEANINGS } from "../../domain/src/metrics.ts";
import {
  IDENTITY_CHANGE_REASONS,
  INCONSISTENCY_REASONS,
  KNOWLEDGE_COVERAGE_REASONS,
  KNOWLEDGE_COVERAGE_STATUSES,
  CUT_STANDINGS,
  UNLOGGED_REASONS,
  UNSUPPORTED_REASONS,
} from "../../domain/src/knowledge-selector.ts";
import { ADAPTER_NOTES } from "../../domain/src/reconstruction-adapter.ts";
import {
  EXPLANATION_STATUSES,
  FAMILY_COVERAGE_STATUSES,
  IGNORED_DISPOSITIONS,
  LEG_DISPOSITIONS,
  NOT_COMPARABLE_REASONS,
  RECONSTRUCTED_STATE_SCHEMA,
  RECONSTRUCTION_GAPS,
  RECONSTRUCTION_ZONE,
  UNAVAILABLE_REASONS as FOLD_UNAVAILABLE_REASONS,
} from "../../domain/src/reconstruction.ts";
import { validInstantText, validLocalDateText } from "../../domain/src/time.ts";
import { validQuantity } from "../../domain/src/values.ts";

export const RECONSTRUCTED_STATE_QUERY_SCHEMA = "reconstructed-state-query-v1";
/** `RECONSTRUCTED_STATE_STATUSES` of the query, in precedence order. */
export const RECONSTRUCTED_STATE_WIRE_STATUSES = [
  "unavailable",
  "indeterminate",
  "needs_review",
  "incomplete",
  "complete",
] as const;
/** `RECONSTRUCTED_STATE_REASONS` of the query, in its order. */
export const RECONSTRUCTED_STATE_WIRE_REASONS = [
  "economic_guard_missing",
  "no_reported_container",
  "log_empty",
  "cut_before_log_start",
  "knowledge_unlogged",
  "snapshot_boundary_unknown",
  "identity_changed",
  "claim_conflict",
  "alias_conflict",
  "revision_chain_inconsistent",
  "writer_unsupported",
  "revision_left_out",
  "no_start_snapshot",
  "start_metric_not_stock",
  "start_sign_unknown",
  "start_ambiguous_metrics",
  "start_ambiguous_positions",
  "start_value_not_exact",
  "instrument_not_identified",
  "leg_value_not_exact",
  "leg_sign_unknown",
  "event_time_unknown",
  "own_transfer_held",
  "leg_subject_unrecognized",
  "leg_effect_unknown",
  "family_not_evented",
  "history_coverage_unknown",
  "history_gap",
  "nothing_to_reconstruct",
  "positions_not_folded",
] as const;
/** `LATE_UNAVAILABLE_REASONS` of the query. */
export const RECONSTRUCTED_STATE_LATE_UNAVAILABLE = [
  "no_end_capture",
  "end_captures_differ",
  "baseline_after_cut",
] as const;

const BOUND = 20_000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Exactly these fields: a figure the contract does not name is refused, not ignored. */
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const nullableText = (value: unknown): boolean => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bool = (value: unknown): boolean => typeof value === "boolean";
const member =
  (choices: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === "string" && choices.includes(value);
const list = <T>(value: unknown, each: (entry: unknown) => boolean): value is T[] =>
  Array.isArray(value) && value.length <= BOUND && value.every(each);
const digest = (value: unknown): boolean =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const date = (value: unknown): boolean => validLocalDateText(value);
const instant = (value: unknown): boolean => validInstantText(value);

const resolvedCut = (value: unknown): boolean =>
  record(value) &&
  exactKeys(value, ["coreEpoch", "commitSeq"]) &&
  text(value.coreEpoch) &&
  count(value.commitSeq);
const knowledgeCut = (value: unknown): boolean =>
  resolvedCut(value) ||
  (record(value) &&
    exactKeys(value, ["coreEpoch", "instant"]) &&
    text(value.coreEpoch) &&
    instant(value.instant));

function validCut(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["requested", "resolved", "knownAt"]) &&
    knowledgeCut(value.requested) &&
    resolvedCut(value.resolved) &&
    (value.knownAt === null || instant(value.knownAt))
  );
}

const revisionRef = (value: Record<string, unknown>): boolean =>
  text(value.eventId) && count(value.revision);

function validKnowledge(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "setVersion",
      "coverage",
      "revisions",
      "unlogged",
      "inconsistent",
      "identityChanged",
      "conflicts",
      "unsupported",
      "adapterNotes",
    ]) &&
    digest(value.setVersion) &&
    record(value.coverage) &&
    exactKeys(value.coverage, ["status", "reasons", "logStart"]) &&
    member(KNOWLEDGE_COVERAGE_STATUSES)(value.coverage.status) &&
    list(value.coverage.reasons, member(KNOWLEDGE_COVERAGE_REASONS)) &&
    (value.coverage.logStart === null ||
      (record(value.coverage.logStart) &&
        exactKeys(value.coverage.logStart, ["commitSeq", "knownAt"]) &&
        count(value.coverage.logStart.commitSeq) &&
        instant(value.coverage.logStart.knownAt))) &&
    count(value.revisions) &&
    list(
      value.unlogged,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["eventId", "revision", "reasonCode"]) &&
        revisionRef(entry) &&
        member(UNLOGGED_REASONS)(entry.reasonCode),
    ) &&
    list(
      value.inconsistent,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["eventId", "reasonCode"]) &&
        text(entry.eventId) &&
        member(INCONSISTENCY_REASONS)(entry.reasonCode),
    ) &&
    list(
      value.identityChanged,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["eventId", "revision", "reasons"]) &&
        revisionRef(entry) &&
        list(entry.reasons, member(IDENTITY_CHANGE_REASONS)),
    ) &&
    list(
      value.conflicts,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["dimension", "book", "ref", "holders"]) &&
        member(["key", "alias"])(entry.dimension) &&
        text(entry.book) &&
        text(entry.ref) &&
        list(entry.holders, text),
    ) &&
    list(
      value.unsupported,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["eventId", "revision", "reasonCode"]) &&
        revisionRef(entry) &&
        member(UNSUPPORTED_REASONS)(entry.reasonCode),
    ) &&
    list(
      value.adapterNotes,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["ref", "code"]) &&
        text(entry.ref) &&
        member(ADAPTER_NOTES)(entry.code),
    )
  );
}

const side = (value: unknown): boolean =>
  record(value) &&
  exactKeys(value, ["date", "contextId"]) &&
  date(value.date) &&
  digest(value.contextId);

function validStart(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "snapshotRef",
      "capturedAt",
      "metricId",
      "signMeaning",
      "reported",
      "oriented",
    ]) &&
    text(value.ref) &&
    text(value.snapshotRef) &&
    instant(value.capturedAt) &&
    nullableText(value.metricId) &&
    (value.signMeaning === null || member(SIGN_MEANINGS)(value.signMeaning)) &&
    validQuantity(value.reported) &&
    validQuantity(value.oriented)
  );
}

const totalRefs = (value: unknown): boolean =>
  record(value) &&
  exactKeys(value, ["total", "refs"]) &&
  validQuantity(value.total) &&
  list(value.refs, text);
const componentKeys = ["count", "total", "refs"];
const component = (value: unknown, extra: string[] = []): boolean =>
  record(value) &&
  exactKeys(value, [...componentKeys, ...extra]) &&
  count(value.count) &&
  validQuantity(value.total) &&
  list(value.refs, text) &&
  extra.every((key) => count(value[key]));

function validExplanation(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "status",
      "reasonCode",
      "reported",
      "remainder",
      "lateRecorded",
      "pendingShownApart",
      "sameDayBoundary",
    ]) &&
    member(EXPLANATION_STATUSES)(value.status) &&
    (value.reasonCode === null ||
      member([...NOT_COMPARABLE_REASONS, ...FOLD_UNAVAILABLE_REASONS])(value.reasonCode)) &&
    (value.reported === null || validStart(value.reported)) &&
    validQuantity(value.remainder) &&
    (value.lateRecorded === null || totalRefs(value.lateRecorded)) &&
    totalRefs(value.pendingShownApart) &&
    totalRefs(value.sameDayBoundary)
  );
}

const windowBound = (value: unknown): boolean =>
  record(value) &&
  ((exactKeys(value, ["kind", "capturedAt"]) &&
    value.kind === "capture" &&
    instant(value.capturedAt)) ||
    (exactKeys(value, ["kind", "date"]) && value.kind === "end-of-date" && date(value.date)));

function validCell(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "accountId",
      "measure",
      "unitRef",
      "unidentifiedRef",
      "orientation",
      "window",
      "start",
      "reconstructed",
      "applied",
      "pending",
      "boundary",
      "ignored",
      "unknown",
      "gaps",
      "partition",
      "needsReview",
      "explanation",
    ]) &&
    text(value.accountId) &&
    member(["balance", "position", "flow-only"])(value.measure) &&
    nullableText(value.unitRef) &&
    nullableText(value.unidentifiedRef) &&
    value.orientation === "asset-positive" &&
    record(value.window) &&
    exactKeys(value.window, ["from", "to"]) &&
    windowBound(value.window.from) &&
    windowBound(value.window.to) &&
    (value.start === null || validStart(value.start)) &&
    validQuantity(value.reconstructed) &&
    component(value.applied) &&
    component(value.pending) &&
    component(value.boundary, ["atStart", "atEnd"]) &&
    record(value.ignored) &&
    exactKeys(value.ignored, IGNORED_DISPOSITIONS) &&
    IGNORED_DISPOSITIONS.every((key) => count((value.ignored as Record<string, unknown>)[key])) &&
    record(value.unknown) &&
    exactKeys(value.unknown, ["count", "refs"]) &&
    count(value.unknown.count) &&
    list(value.unknown.refs, text) &&
    list(value.gaps, member(RECONSTRUCTION_GAPS)) &&
    member(RESULT_PARTITIONS)(value.partition) &&
    bool(value.needsReview) &&
    validExplanation(value.explanation)
  );
}

function validDisposition(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "eventId",
      "revision",
      "legIndex",
      "accountId",
      "unitRef",
      "disposition",
      "gap",
      "conflict",
    ]) &&
    text(value.ref) &&
    revisionRef(value) &&
    (value.legIndex === null || count(value.legIndex)) &&
    nullableText(value.accountId) &&
    nullableText(value.unitRef) &&
    member(LEG_DISPOSITIONS)(value.disposition) &&
    (value.gap === null || member(RECONSTRUCTION_GAPS)(value.gap)) &&
    (value.conflict === null || value.conflict === "duplicate_claim")
  );
}

function validReconstruction(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "schemaVersion",
      "basis",
      "knowledgeCut",
      "zone",
      "accounts",
      "cells",
      "dispositions",
      "netWorth",
      "manifest",
    ]) &&
    value.schemaVersion === RECONSTRUCTED_STATE_SCHEMA &&
    value.basis === "cash" &&
    resolvedCut(value.knowledgeCut) &&
    value.zone === RECONSTRUCTION_ZONE &&
    list(
      value.accounts,
      (entry) =>
        record(entry) &&
        exactKeys(entry, [
          "accountId",
          "startContainer",
          "endContainer",
          "familyCoverage",
          "cells",
        ]) &&
        text(entry.accountId) &&
        bool(entry.startContainer) &&
        bool(entry.endContainer) &&
        member([...FAMILY_COVERAGE_STATUSES, "not-declared"])(entry.familyCoverage) &&
        count(entry.cells),
    ) &&
    list(value.cells, validCell) &&
    list(value.dispositions, validDisposition) &&
    // Nothing is totalled across accounts.
    value.netWorth === "not-computed" &&
    record(value.manifest) &&
    value.manifest.schemaVersion === RECONSTRUCTED_STATE_SCHEMA
  );
}

function validLate(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["baselineCut", "cut", "entered", "left"]) &&
    resolvedCut(value.baselineCut) &&
    resolvedCut(value.cut) &&
    list(value.entered, text) &&
    list(value.left, text)
  );
}

function validManifest(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "schemaVersion",
      "selectorRelease",
      "adapterRelease",
      "engineRelease",
      "foldPolicy",
      "account",
      "range",
      "basis",
      "cut",
      "setVersion",
      "baseline",
      "identity",
      "aliasRuleVersions",
      "coverageProducer",
      "snapshots",
      "innerManifestDigest",
    ]) &&
    value.schemaVersion === RECONSTRUCTED_STATE_QUERY_SCHEMA &&
    text(value.selectorRelease) &&
    text(value.adapterRelease) &&
    text(value.engineRelease) &&
    text(value.foldPolicy) &&
    text(value.account) &&
    record(value.range) &&
    exactKeys(value.range, ["from", "to"]) &&
    value.basis === "cash" &&
    validCut(value.cut) &&
    digest(value.setVersion) &&
    (value.baseline === null ||
      (record(value.baseline) &&
        exactKeys(value.baseline, ["cut", "setVersion"]) &&
        resolvedCut(value.baseline.cut) &&
        digest(value.baseline.setVersion))) &&
    record(value.identity) &&
    exactKeys(value.identity, ["epoch", "pins"]) &&
    text(value.identity.epoch) &&
    list(
      value.identity.pins,
      (pin) =>
        Array.isArray(pin) && pin.length === 3 && text(pin[0]) && text(pin[1]) && count(pin[2]),
    ) &&
    list(value.aliasRuleVersions, text) &&
    text(value.coverageProducer) &&
    record(value.snapshots) &&
    exactKeys(value.snapshots, ["startContextId", "endContextId"]) &&
    digest(value.snapshots.startContextId) &&
    digest(value.snapshots.endContextId) &&
    digest(value.innerManifestDigest)
  );
}

/** The API body: `apiVersion` 2 and the query's answer, nothing else. */
export function validReconstructedState(value: unknown): boolean {
  if (
    !(
      record(value) &&
      exactKeys(value, [
        "apiVersion",
        "schemaVersion",
        "status",
        "reasons",
        "account",
        "range",
        "basis",
        "cut",
        "cutStanding",
        "knowledge",
        "reported",
        "reconstruction",
        "late",
        "lateUnavailable",
        "manifest",
        "contextId",
      ]) &&
      value.apiVersion === 2 &&
      value.schemaVersion === RECONSTRUCTED_STATE_QUERY_SCHEMA &&
      member(RECONSTRUCTED_STATE_WIRE_STATUSES)(value.status) &&
      list(value.reasons, member(RECONSTRUCTED_STATE_WIRE_REASONS)) &&
      text(value.account) &&
      record(value.range) &&
      exactKeys(value.range, ["from", "to"]) &&
      date(value.range.from) &&
      date(value.range.to) &&
      value.basis === "cash"
    )
  )
    return false;
  // Without CORE 0070 nothing is computed, and the answer says exactly that.
  if (value.reconstruction === null)
    return (
      value.status === "unavailable" &&
      value.reasons.length === 1 &&
      value.reasons[0] === "economic_guard_missing" &&
      [
        value.cut,
        value.cutStanding,
        value.knowledge,
        value.reported,
        value.late,
        value.lateUnavailable,
        value.manifest,
        value.contextId,
      ].every((field) => field === null)
    );
  // A computed answer is never `complete` with a reason, nor anything else without one.
  if ((value.status === "complete") !== (value.reasons.length === 0)) return false;
  return (
    validCut(value.cut) &&
    member(CUT_STANDINGS)(value.cutStanding) &&
    validKnowledge(value.knowledge) &&
    record(value.reported) &&
    exactKeys(value.reported, ["start", "end", "positionsNotFolded"]) &&
    side(value.reported.start) &&
    side(value.reported.end) &&
    count(value.reported.positionsNotFolded) &&
    validReconstruction(value.reconstruction) &&
    (value.late === null || validLate(value.late)) &&
    (value.lateUnavailable === null ||
      member(RECONSTRUCTED_STATE_LATE_UNAVAILABLE)(value.lateUnavailable)) &&
    (value.late === null) !== (value.lateUnavailable === null) &&
    validManifest(value.manifest) &&
    digest(value.contextId)
  );
}

// The wire shape of `GET /api/identity/instrument-candidates` (ADR 0055,
// amendment 2026-10-09), checked by the browser before it renders a page.
// Every code is checked against the domain's closed lists, so a page never
// shows a status, hold, conflict or gap it does not know as if it did; the
// client recomputes nothing.
import {
  CANDIDATE_AGREEMENTS,
  CANDIDATE_CONFLICTS,
  CANDIDATE_EVIDENCE,
  CANDIDATE_GAPS,
  CANDIDATE_HOLDS,
  CANDIDATE_STATUSES,
  IDENTIFIER_RESOLUTION_STATES,
} from "../../domain/src/instrument-candidates.ts";

/** The path the browser reads the review from. */
export const INSTRUMENT_CANDIDATES_PATH = "/api/identity/instrument-candidates";
/** Items one page may hold, as the service pages them. */
const PAGE_LIMIT = 50;
/** Identifiers one page may name: both sides of every item and a separated pair's `via`. */
const IDENTIFIER_LIMIT = 1_000;

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf =
  (values: readonly string[]) =>
  (value: unknown): boolean =>
    text(value) && values.includes(value);
const listOf = (values: readonly string[], value: unknown): boolean =>
  Array.isArray(value) && value.length <= values.length && value.every(oneOf(values));
const texts = (value: unknown, limit = 100): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(text);
const pair = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && value.every(text);
const VIEWS = ["open", "held", "decided", "separated", "hints"];

function validCommands(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || !record(value.keepApart)) return false;
  const adopt = value.adopt;
  if (
    adopt !== null &&
    !(
      record(adopt) &&
      adopt.kind === "identity.assign" &&
      record(adopt.payload) &&
      adopt.payload.subject === "instrument" &&
      text(adopt.payload.referenceId) &&
      text(adopt.payload.targetId)
    )
  )
    return false;
  const keep = value.keepApart;
  return (
    keep.kind === "relation.reject" &&
    record(keep.payload) &&
    keep.payload.relationKind === "listed_as" &&
    text(keep.payload.fromRef) &&
    text(keep.payload.toRef) &&
    keep.payload.validFrom === null &&
    keep.payload.validTo === null &&
    texts(keep.payload.evidenceRefs, 2)
  );
}

function validItem(view: string, item: unknown): boolean {
  if (!record(item) || !texts(item.evidenceRefs, 1_000)) return false;
  if (view === "separated")
    return (
      text(item.pairId) &&
      pair(item.identifierIds) &&
      listOf(CANDIDATE_EVIDENCE, item.evidence) &&
      listOf(CANDIDATE_CONFLICTS, item.conflicts) &&
      texts(item.via, 1_000) &&
      typeof item.sharedInstrument === "boolean"
    );
  if (view === "hints")
    return (
      text(item.pairId) &&
      pair(item.identifierIds) &&
      item.reason === "same-display-name" &&
      listOf(CANDIDATE_CONFLICTS, item.conflicts)
    );
  const status = item.status;
  return (
    text(item.candidateId) &&
    text(item.anchorIdentifierId) &&
    text(item.subjectIdentifierId) &&
    listOf(CANDIDATE_EVIDENCE, item.evidence) &&
    listOf(CANDIDATE_AGREEMENTS, item.agreements) &&
    listOf(CANDIDATE_GAPS, item.gaps) &&
    typeof item.crossSource === "boolean" &&
    oneOf(CANDIDATE_STATUSES)(status) &&
    (item.hold === null || oneOf(CANDIDATE_HOLDS)(item.hold)) &&
    validCommands(item.commands) &&
    // Commands exist exactly while a candidate is proposed, and the view matches the status.
    (status === "proposed") === (item.commands !== null) &&
    (view === "decided" ? status !== "proposed" : status === "proposed") &&
    (view === "held") === (item.hold !== null) &&
    // A held candidate names no adoption: re-mapping a settled subject is a correction.
    (item.hold === null || item.commands?.adopt === null)
  );
}

function validIdentifier(row: unknown): boolean {
  return (
    record(row) &&
    [
      row.identifierId,
      row.instrumentId,
      row.kind,
      row.namespace,
      row.scope,
      row.value,
      row.label,
    ].every(text) &&
    ["rule", "manual"].includes(String(row.mappingMethod)) &&
    text(row.mappingStatus) &&
    count(row.mappingRevision) &&
    texts(row.sources) &&
    texts(row.currencies) &&
    typeof row.currencyUnconfirmed === "boolean" &&
    (row.providerMarket === null || text(row.providerMarket)) &&
    oneOf(IDENTIFIER_RESOLUTION_STATES)(row.state) &&
    texts(row.sharedWith, 10_000) &&
    texts(row.candidateIds, 10_000)
  );
}

/** Validate the wire shape only. */
export function validInstrumentCandidateReview(value: unknown): boolean {
  if (
    !record(value) ||
    value.schemaVersion !== "kogane-instrument-candidates-v1" ||
    value.decisions !== "change-lifecycle" ||
    !record(value.query) ||
    !oneOf(VIEWS)(value.query.view) ||
    !count(value.query.offset) ||
    !(value.query.identifierId === null || text(value.query.identifierId)) ||
    !record(value.manifest) ||
    value.manifest.policy !== "instrument-candidates-v1" ||
    !record(value.summary) ||
    ![
      "identifiers",
      "unresolved",
      "proposed",
      "adopted",
      "rejected",
      "separated",
      "hints",
      "held",
    ].every((key) => count(value.summary[key])) ||
    !count(value.total) ||
    !Array.isArray(value.items) ||
    value.items.length > PAGE_LIMIT ||
    !(value.nextOffset === null || count(value.nextOffset)) ||
    !Array.isArray(value.identifiers) ||
    value.identifiers.length > IDENTIFIER_LIMIT
  )
    return false;
  const view = value.query.view as string;
  return (
    value.items.every((item) => validItem(view, item)) && value.identifiers.every(validIdentifier)
  );
}

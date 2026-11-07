// The wire shape of `GET /api/identity/account-candidates` (ADR 0077), checked
// by the browser before it renders a page. Every code is checked against the
// domain's closed lists, so a page never shows a status, hold or reason it
// does not know as if it did; the client recomputes nothing.
import {
  ACCOUNT_CANDIDATE_EVIDENCE,
  ACCOUNT_CANDIDATE_HOLDS,
  ACCOUNT_CANDIDATE_STATUSES,
  ACCOUNT_CONNECTION_STATES,
  CONTAINMENT_REFERENCES,
  SAME_ACCOUNT_REASONS,
  UNREVIEWED_REASONS,
} from "../../domain/src/account-candidates.ts";
import { STORED_RELATION_STATUSES } from "../../domain/src/decisions.ts";

/** The path the browser reads the review from. */
export const ACCOUNT_CANDIDATES_PATH = "/api/identity/account-candidates";
/** Items one page may hold, as the service pages them. */
const PAGE_LIMIT = 50;
/** Source accounts one page may name: a connection names at most 100 direct accounts and its aggregators. */
const SOURCE_ACCOUNT_LIMIT = 60_000;
const VIEWS = ["open", "held", "decided", "connections", "unreviewed"];

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): boolean => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf =
  (values: readonly string[]) =>
  (value: unknown): boolean =>
    text(value) && values.includes(value);
const listOf = (values: readonly string[], value: unknown): boolean =>
  Array.isArray(value) && value.length <= values.length && value.every(oneOf(values));
const texts = (value: unknown, limit = 1_000): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(text);

function validCommand(
  value: unknown,
  kind: "relation.accept" | "relation.reject",
  item: Record<string, any>,
): boolean {
  if (value === null) return true;
  return (
    record(value) &&
    value.kind === kind &&
    record(value.payload) &&
    value.payload.relationKind === "connection_contains" &&
    value.payload.fromRef === item.connectionRef &&
    value.payload.toRef === `source_account:${String(item.directSourceAccountId)}` &&
    value.payload.validFrom === null &&
    value.payload.validTo === null &&
    texts(value.payload.evidenceRefs, 4) &&
    JSON.stringify(value.payload.evidenceRefs) === JSON.stringify(item.evidenceRefs)
  );
}

function validCandidate(view: string, item: Record<string, any>): boolean {
  const status = item.status;
  return (
    text(item.candidateId) &&
    text(item.connectionRef) &&
    text(item.producerId) &&
    text(item.connectionKey) &&
    count(item.reviewRevision) &&
    nullableText(item.relatedSourceId) &&
    text(item.directSourceAccountId) &&
    texts(item.aggregatorSourceAccountIds) &&
    item.relation === "connection_contains" &&
    listOf(ACCOUNT_CANDIDATE_EVIDENCE, item.evidence) &&
    typeof item.evidenceEligible === "boolean" &&
    oneOf(ACCOUNT_CANDIDATE_STATUSES)(status) &&
    (item.hold === null || oneOf(ACCOUNT_CANDIDATE_HOLDS)(item.hold)) &&
    Array.isArray(item.recordedContainment) &&
    item.recordedContainment.length <= 1_000 &&
    item.recordedContainment.every(
      (row: unknown) =>
        record(row) &&
        text(row.fromRef) &&
        oneOf(CONTAINMENT_REFERENCES)(row.reference) &&
        oneOf(STORED_RELATION_STATUSES)(row.status),
    ) &&
    // A pair with no recorded containment has not been decided.
    (item.recordedContainment.length > 0 || status === "proposed") &&
    record(item.sameAccount) &&
    // This policy never proposes `same_account`.
    item.sameAccount.proposed === false &&
    listOf(SAME_ACCOUNT_REASONS, item.sameAccount.reasons) &&
    Array.isArray(item.sameAccount.recorded) &&
    item.sameAccount.recorded.every(
      (row: unknown) =>
        record(row) &&
        text(row.fromRef) &&
        text(row.toRef) &&
        oneOf(STORED_RELATION_STATUSES)(row.status),
    ) &&
    record(item.commands) &&
    validCommand(item.commands.accept, "relation.accept", item) &&
    validCommand(item.commands.reject, "relation.reject", item) &&
    // A held or accepted candidate names no acceptance; a rejected one names no rejection.
    (item.hold === null && status !== "accepted") === (item.commands.accept !== null) &&
    (status !== "rejected") === (item.commands.reject !== null) &&
    (view === "decided" ? status !== "proposed" : status === "proposed") &&
    (view === "decided" || (view === "held") === (item.hold !== null)) &&
    texts(item.evidenceRefs, 4)
  );
}

function validItem(view: string, item: unknown): boolean {
  if (!record(item)) return false;
  if (view === "connections")
    return (
      text(item.connectionRef) &&
      text(item.producerId) &&
      text(item.connectionKey) &&
      count(item.revision) &&
      text(item.label) &&
      oneOf(ACCOUNT_CONNECTION_STATES)(item.state) &&
      nullableText(item.relatedSourceId) &&
      texts(item.directSourceAccountIds, 100) &&
      texts(item.aggregatorSourceAccountIds) &&
      texts(item.evidenceRefs, 4)
    );
  if (view === "unreviewed")
    return (
      text(item.sourceAccountId) &&
      text(item.producerId) &&
      nullableText(item.connectionKey) &&
      oneOf(UNREVIEWED_REASONS)(item.reason)
    );
  return validCandidate(view, item);
}

function validSourceAccount(row: unknown): boolean {
  return (
    record(row) &&
    text(row.sourceAccountId) &&
    text(row.sourceId) &&
    text(row.producerId) &&
    [row.accountId, row.label, row.status, row.method].every(nullableText) &&
    (row.mappingRevision === null || count(row.mappingRevision))
  );
}

/** Validate the wire shape only. */
export function validAccountCandidateReview(value: unknown): boolean {
  if (
    !record(value) ||
    value.schemaVersion !== "kogane-account-candidates-v1" ||
    value.decisions !== "change-lifecycle" ||
    !record(value.query) ||
    !oneOf(VIEWS)(value.query.view) ||
    !count(value.query.offset) ||
    !nullableText(value.query.sourceAccountId) ||
    !record(value.manifest) ||
    value.manifest.policy !== "account-candidates-v1" ||
    !record(value.summary) ||
    !record(value.summary.connections) ||
    !ACCOUNT_CONNECTION_STATES.every((key) => count(value.summary.connections[key])) ||
    !record(value.summary.candidates) ||
    !ACCOUNT_CANDIDATE_STATUSES.every((key) => count(value.summary.candidates[key])) ||
    !["held", "unreviewedAggregatorAccounts", "sameAccountRecorded"].every((key) =>
      count(value.summary[key]),
    ) ||
    value.summary.sameAccountProposed !== 0 ||
    !count(value.total) ||
    !Array.isArray(value.items) ||
    value.items.length > PAGE_LIMIT ||
    !(value.nextOffset === null || count(value.nextOffset)) ||
    !Array.isArray(value.sourceAccounts) ||
    value.sourceAccounts.length > SOURCE_ACCOUNT_LIMIT
  )
    return false;
  const view = value.query.view as string;
  return (
    value.items.every((item) => validItem(view, item)) &&
    value.sourceAccounts.every(validSourceAccount)
  );
}

// The wire check for one source account's correction history (ADR 0077,
// amendment 2026-11-08). The browser shows the server's entries in the
// server's order and derives no mapping or relation state from them.
import { isDecisionOrigin } from "./decision-origin-contract.ts";
import { RELATION_KINDS, STORED_RELATION_STATUSES } from "../../domain/src/decisions.ts";
import { isRecord, isText } from "../../domain/src/guards.ts";

export const ACCOUNT_HISTORY_PATH = "/api/identity/account-history";
const DECISION_KINDS = ["assign", "release-override", "propose", "accept", "reject", "supersede"];
const MAPPING_STATUSES = ["identified", "provider-local", "aggregate", "unresolved"];
const nullableText = (value: unknown) => value === null || typeof value === "string";
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf = (values: readonly string[], value: unknown) =>
  typeof value === "string" && values.includes(value);

function validEntry(entry: unknown, ref: string): boolean {
  if (
    !isRecord(entry) ||
    !count(entry.revision) ||
    !isDecisionOrigin(entry.decisionOrigin) ||
    ![entry.createdAt, entry.method, entry.reason, entry.recordId].every(
      (text) => typeof text === "string",
    ) ||
    ![
      entry.decisionKind,
      entry.accountId,
      entry.status,
      entry.label,
      entry.supersededBy,
      entry.relationKind,
      entry.relationStatus,
      entry.fromRef,
      entry.toRef,
    ].every(nullableText) ||
    !(entry.policyVersion === null || count(entry.policyVersion))
  )
    return false;
  switch (entry.entry) {
    case "mapping":
      return (
        isText(entry.accountId) &&
        oneOf(MAPPING_STATUSES, entry.status) &&
        entry.decisionKind === null &&
        entry.relationKind === null
      );
    case "decision":
      return oneOf(DECISION_KINDS, entry.decisionKind) && entry.relationKind === null;
    case "relation":
      // Every relation entry names this account on exactly one side.
      return (
        oneOf(DECISION_KINDS, entry.decisionKind) &&
        oneOf(RELATION_KINDS, entry.relationKind) &&
        oneOf(STORED_RELATION_STATUSES, entry.relationStatus) &&
        isText(entry.fromRef, 512) &&
        isText(entry.toRef, 512) &&
        (entry.fromRef === ref) !== (entry.toRef === ref)
      );
    default:
      return false;
  }
}

/** The server's complete history, oldest first, or nothing. */
export function validAccountHistoryRead(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "kogane-account-history-v1" ||
    !isText(value.sourceAccountId, 256) ||
    !Array.isArray(value.entries) ||
    !count(value.total) ||
    value.total !== value.entries.length ||
    value.entries.length > 1000
  )
    return false;
  const ref = `source_account:${value.sourceAccountId}`;
  return value.entries.every((entry) => validEntry(entry, ref));
}

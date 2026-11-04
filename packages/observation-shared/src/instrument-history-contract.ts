import { isDecisionOrigin } from "./decision-origin-contract.ts";
import { isRecord, isText } from "../../domain/src/guards.ts";

export const INSTRUMENT_HISTORY_PATH = "/api/identity/instrument-history";
const nullableText = (value: unknown) => value === null || typeof value === "string";
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The server's complete history, oldest first; the browser derives no mapping. */
export function validInstrumentHistoryRead(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "kogane-instrument-history-v1" ||
    !isText(value.identifierId, 128) ||
    !Array.isArray(value.entries) ||
    !count(value.total) ||
    value.total !== value.entries.length ||
    value.entries.length > 1000
  )
    return false;
  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      ["mapping", "decision", "relation"].includes(String(entry.entry)) &&
      count(entry.revision) &&
      (entry.decisionOrigin === undefined || isDecisionOrigin(entry.decisionOrigin)) &&
      [entry.createdAt, entry.method, entry.reason, entry.recordId].every(
        (text) => typeof text === "string",
      ) &&
      [
        entry.decisionKind,
        entry.instrumentId,
        entry.status,
        entry.label,
        entry.supersededBy,
        entry.relationStatus,
        entry.fromRef,
      ].every(nullableText) &&
      (entry.policyVersion === null || count(entry.policyVersion)),
  );
}

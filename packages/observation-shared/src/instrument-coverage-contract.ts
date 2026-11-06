// The wire shape of `GET /api/identity/instrument-coverage` (ADR 0073),
// checked by the browser before it renders the counts. Every state key is
// the domain's closed list, and a row's states must add up to its identifier
// count, so a page never shows a state it does not know or a count that
// does not hold together. The client recomputes and totals nothing.
import {
  IDENTIFIER_RESOLUTION_STATES,
  INSTRUMENT_CANDIDATE_POLICY,
} from "../../domain/src/instrument-candidates.ts";

/** The path the browser reads the per-source instrument counts from. */
export const INSTRUMENT_COVERAGE_PATH = "/api/identity/instrument-coverage";
/**
 * Rows one answer may hold: one per source, and every source row rests on at
 * least one fact row of the candidate read, which refuses past 10,000.
 */
const ROW_LIMIT = 10_000;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const source = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

export function validInstrumentCoverage(value: unknown): boolean {
  if (
    !record(value) ||
    value.schemaVersion !== "kogane-instrument-coverage-v1" ||
    value.policy !== INSTRUMENT_CANDIDATE_POLICY ||
    !record(value.query) ||
    !(value.query.source === null || source(value.query.source)) ||
    !Array.isArray(value.rows) ||
    value.rows.length > ROW_LIMIT
  )
    return false;
  const filter = value.query.source;
  let previous: string | null = null;
  for (const row of value.rows) {
    if (
      !record(row) ||
      !source(row.source) ||
      (filter !== null && row.source !== filter) ||
      // Sorted and unique: one row per source.
      (previous !== null && !(previous < row.source)) ||
      !count(row.identifiers) ||
      row.identifiers < 1 ||
      !record(row.states)
    )
      return false;
    previous = row.source;
    const states = row.states;
    const keys = Object.keys(states);
    if (
      keys.length !== IDENTIFIER_RESOLUTION_STATES.length ||
      !IDENTIFIER_RESOLUTION_STATES.every((state) => count(states[state]))
    )
      return false;
    const total = IDENTIFIER_RESOLUTION_STATES.reduce(
      (sum, state) => sum + (states[state] as number),
      0,
    );
    if (total !== row.identifiers) return false;
  }
  return true;
}

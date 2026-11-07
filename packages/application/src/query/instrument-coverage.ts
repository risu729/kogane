// Per-source instrument resolution counts (ADR 0073): for each source, how
// many security, crypto and product identifiers its current published
// identity observations use, and how many stand in each identifier state of
// the cross-identifier candidate read (ADR 0055 §9). Counts only: no
// identifier, label, amount or rate is in the answer, and nothing is written.
//
// The counts are the candidate read's own states (`queryInstrumentResolution`),
// grouped by every source that uses each identifier, so this answer and the
// `銘柄の同一性の候補` page cannot disagree. An identifier used by two sources
// is counted under each, so the rows have no meaningful total and none is
// given (INV06).
//
// - `summary.read` is required: the answer is counts.
// - The whole store or nothing: an identifier's state depends on identifiers
//   of other sources (a candidate pairs across sources), so a grant listed on
//   either axis would be given counts shaped by sources it may not see; it is
//   refused before anything is read (SC18), as the candidate review is.
// - Bounded exactly as the candidate review: the observation count is checked
//   before the walk, and a read past its own bounds is refused whole
//   (`budget_exceeded`), never answered in part or as zero.
import {
  IDENTIFIER_RESOLUTION_STATES,
  INSTRUMENT_CANDIDATE_POLICY,
  type IdentifierResolutionState,
} from "../../../domain/src/instrument-candidates.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import { readIdentityObservationCount } from "../../../read-model/src/instrument-resolution.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";
import { CURRENT_IDENTITY_OBSERVATION_BOUND } from "./instrument-candidates-review.ts";
import {
  type InstrumentResolution,
  InstrumentResolutionLimitError,
  queryInstrumentResolution,
} from "./instrument-resolution.ts";

/** The capability the counts need. */
const INSTRUMENT_COVERAGE_CAPABILITY: AgentCapability = "summary.read";
/** Errors of this service carry this request id: no context is opened for it. */
const REQUEST_ID = "instruments.coverage";
/** Every key a request may carry. */
export const INSTRUMENT_COVERAGE_KEYS = ["source"] as const;

export interface InstrumentCoverageRow {
  source: string;
  /** Distinct in-scope identifiers this source's current observations use; at least 1. */
  identifiers: number;
  /** Those identifiers by state; the five counts add up to `identifiers`. */
  states: Record<IdentifierResolutionState, number>;
}

export interface InstrumentCoverage {
  schemaVersion: "kogane-instrument-coverage-v1";
  /** The candidate policy whose identifier states are counted. */
  policy: typeof INSTRUMENT_CANDIDATE_POLICY;
  /** The request as the server resolved it. */
  query: { source: string | null };
  /**
   * One row per source that uses at least one in-scope identifier, sorted by
   * source. A source with no row uses none in its current organized records;
   * that is not a count of zero resolved instruments.
   */
  rows: InstrumentCoverageRow[];
}

export type InstrumentCoverageOutcome =
  | { ok: true; coverage: InstrumentCoverage }
  | { ok: false; error: FinancialError };

const emptyStates = (): Record<IdentifierResolutionState, number> =>
  Object.fromEntries(IDENTIFIER_RESOLUTION_STATES.map((state) => [state, 0])) as Record<
    IdentifierResolutionState,
    number
  >;

/**
 * The per-source counts of one resolution read: each identifier counts once
 * under every source that uses it, in its one state.
 */
export function instrumentCoverageBySource(
  resolution: Pick<InstrumentResolution, "identifiers">,
): InstrumentCoverageRow[] {
  const bySource = new Map<string, InstrumentCoverageRow>();
  for (const identifier of resolution.identifiers)
    for (const source of new Set(identifier.sources)) {
      const row = bySource.get(source) ?? { source, identifiers: 0, states: emptyStates() };
      row.identifiers += 1;
      row.states[identifier.state] += 1;
      bySource.set(source, row);
    }
  return [...bySource.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );
}

/** A source as the identity catalogue accepts one: 1 to 128 characters, no control character. */
function validSource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f]/u.test(value)
  );
}

/**
 * The counts for one request, or the typed refusal. The capability and
 * perimeter refusals and a malformed source are decided before the store is
 * read; the read's own bound can only be known after it.
 */
export async function readInstrumentCoverage(input: {
  grant: Grant;
  sql: SqlExecutor;
  /** Only this source's row; null for every source. */
  source: unknown;
}): Promise<InstrumentCoverageOutcome> {
  const { grant, sql, source } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): InstrumentCoverageOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, refs),
  });
  if (!grantAllows(grant, INSTRUMENT_COVERAGE_CAPABILITY))
    return fail("unauthorized", [`capability:${INSTRUMENT_COVERAGE_CAPABILITY}`]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  if (source !== null && !validSource(source)) return fail("invalid_query", ["source"]);
  const wanted = source as string | null;

  // The candidate review's own bound, checked the same way: a count of one
  // row per published parse, an upper bound, so the refusal fails closed.
  if ((await readIdentityObservationCount(sql)) > CURRENT_IDENTITY_OBSERVATION_BOUND)
    return fail("budget_exceeded", [
      `budget:identityObservations=${String(CURRENT_IDENTITY_OBSERVATION_BOUND)}`,
    ]);
  let resolution: InstrumentResolution;
  try {
    resolution = await queryInstrumentResolution(sql);
  } catch (error) {
    if (error instanceof InstrumentResolutionLimitError)
      return fail("budget_exceeded", ["budget:instrumentResolution"]);
    throw error;
  }
  const rows = instrumentCoverageBySource(resolution).filter(
    (row) => wanted === null || row.source === wanted,
  );
  return {
    ok: true,
    coverage: {
      schemaVersion: "kogane-instrument-coverage-v1",
      policy: resolution.policy,
      query: { source: wanted },
      rows,
    },
  };
}

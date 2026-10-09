// The instrument candidate review (ADR 0055, its 2026-10-09 amendment): one
// bounded page of the cross-identifier candidate read
// (`queryInstrumentResolution`) for whoever the grant allows, whether the
// caller is the `銘柄の同一性の候補` page (`GET /api/identity/instrument-candidates`,
// under the reader grant a signed-in browser has) or an agent
// (`kogane.instruments.candidates`, under its `AGENT_API_GRANTS` entry). Both
// transports call this function and nothing else, so a page and an agent read
// one answer.
//
// It reads, and nothing else. A proposed candidate carries the payloads of
// the existing commands that would decide it (`identity.assign` to adopt,
// `relation.reject` of `listed_as` to keep apart); planning, approving and
// committing them is the change lifecycle's (`/api/command/v1/*`), graded by
// its own grant lists exactly as for any other plan. Nothing here adopts.
//
// - The grant decides. `records.read` is required: the answer is structured
//   identifier records and the codes computed over them.
// - The whole store or nothing. Candidates pair identifiers across sources;
//   a grant listed on either axis would either be shown a pair with an
//   identifier of a source it may not see or be given counts over pairs it
//   cannot see, so it is refused before anything is read (SC18).
// - Bounded. The read itself refuses past its bounds (5,000 pairs, 1,000
//   hints, 10,000 fact rows, 10,000 relations: `budget_exceeded`, never cut);
//   the page is `INSTRUMENT_CANDIDATES_PAGE_SIZE` items, and the grant's
//   `maxRows` bounds how deep a caller pages.
import type { NameHint, SeparatedPair } from "../../../domain/src/instrument-candidates.ts";
import {
  CANDIDATE_AGREEMENTS,
  CANDIDATE_CONFLICTS,
  CANDIDATE_EVIDENCE,
  CANDIDATE_GAPS,
  CANDIDATE_HINT_LIMIT,
  CANDIDATE_HOLDS,
  CANDIDATE_PAIR_LIMIT,
  CANDIDATE_STATUSES,
  IDENTIFIER_RESOLUTION_STATES,
} from "../../../domain/src/instrument-candidates.ts";
import { isRecord } from "../../../domain/src/guards.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import {
  INSTRUMENT_FACTS_ROW_BOUND,
  LISTED_AS_ROW_BOUND,
} from "../../../read-model/src/instrument-resolution.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";
import {
  type InstrumentResolution,
  InstrumentResolutionLimitError,
  queryInstrumentResolution,
  type ResolutionCandidate,
  type ResolutionIdentifier,
} from "./instrument-resolution.ts";

/** The capability the review needs. */
export const INSTRUMENT_CANDIDATES_CAPABILITY: AgentCapability = "records.read";
/**
 * Which list a page holds:
 * - `open`: proposed candidates a command may decide now (no hold);
 * - `held`: proposed candidates whose adoption is withheld (`hold` names why);
 *   keeping them apart is still offered;
 * - `decided`: adopted and rejected candidates;
 * - `separated`: pairs that share a value but state a conflicting fact;
 * - `hints`: equal display names without shared evidence (never a candidate).
 */
export const INSTRUMENT_CANDIDATE_VIEWS = [
  "open",
  "held",
  "decided",
  "separated",
  "hints",
] as const;
export type InstrumentCandidateView = (typeof INSTRUMENT_CANDIDATE_VIEWS)[number];
/** Items one page holds. */
export const INSTRUMENT_CANDIDATES_PAGE_SIZE = 50;
/** The largest offset a request may name: past every pair the read may hold. */
export const INSTRUMENT_CANDIDATES_MAX_OFFSET = CANDIDATE_PAIR_LIMIT;
/** Every key a request may carry; any other key is refused, never ignored. */
export const INSTRUMENT_CANDIDATES_KEYS = ["view", "offset", "identifierId"] as const;
/** An identifier id as the identity writer stores one (`ii_<sha256>`), or a test fixture's. */
export const INSTRUMENT_IDENTIFIER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
/** Errors of this service carry this request id: no context is opened for it. */
const REQUEST_ID = "instruments.candidates";

export interface InstrumentCandidatesRequest {
  view: InstrumentCandidateView;
  offset: number;
  /** Only the pairs naming this identifier; null for every pair. */
  identifierId: string | null;
}

/** A candidate with the identifiers it rests on, as refs. */
export interface ReviewCandidate extends ResolutionCandidate {
  evidenceRefs: string[];
}
export interface ReviewSeparated extends SeparatedPair {
  evidenceRefs: string[];
}
export interface ReviewHint extends NameHint {
  evidenceRefs: string[];
}
export type ReviewItem = ReviewCandidate | ReviewSeparated | ReviewHint;

/** The policy, the bounds and every closed code an answer may carry. */
export interface InstrumentCandidatesManifest {
  policy: InstrumentResolution["policy"];
  bounds: {
    pairs: number;
    hints: number;
    factRows: number;
    relations: number;
    pageSize: number;
    maxOffset: number;
  };
  codes: {
    evidence: readonly string[];
    agreements: readonly string[];
    conflicts: readonly string[];
    gaps: readonly string[];
    statuses: readonly string[];
    holds: readonly string[];
    identifierStates: readonly string[];
  };
  /** The command kinds a candidate may name; each is planned through the change lifecycle. */
  commands: { adopt: "identity.assign"; keepApart: "relation.reject" };
}

export interface InstrumentCandidateReview {
  schemaVersion: "kogane-instrument-candidates-v1";
  /** The request as the server resolved it. */
  query: InstrumentCandidatesRequest;
  manifest: InstrumentCandidatesManifest;
  /** Counts over the whole read, whatever the view; `held` is part of `proposed`. */
  summary: InstrumentResolution["summary"] & { held: number };
  /**
   * A decision is a plan of the named command through the change lifecycle
   * (`/api/command/v1/plan`), graded there; this answer changes nothing.
   */
  decisions: "change-lifecycle";
  /** Items in this view (after the identifier filter), of which `items` is one page. */
  total: number;
  items: ReviewItem[];
  nextOffset: number | null;
  /** Every identifier the page's items name (both sides and every `via`), sorted by id. */
  identifiers: ResolutionIdentifier[];
}

export type InstrumentCandidatesOutcome =
  | { ok: true; review: InstrumentCandidateReview }
  | { ok: false; error: FinancialError };

type Rejection = { ok: false; code: FinancialErrorCode; refs: string[] };

export const INSTRUMENT_CANDIDATES_MANIFEST: InstrumentCandidatesManifest = {
  policy: "instrument-candidates-v1",
  bounds: {
    pairs: CANDIDATE_PAIR_LIMIT,
    hints: CANDIDATE_HINT_LIMIT,
    factRows: INSTRUMENT_FACTS_ROW_BOUND,
    relations: LISTED_AS_ROW_BOUND,
    pageSize: INSTRUMENT_CANDIDATES_PAGE_SIZE,
    maxOffset: INSTRUMENT_CANDIDATES_MAX_OFFSET,
  },
  codes: {
    evidence: CANDIDATE_EVIDENCE,
    agreements: CANDIDATE_AGREEMENTS,
    conflicts: CANDIDATE_CONFLICTS,
    gaps: CANDIDATE_GAPS,
    statuses: CANDIDATE_STATUSES,
    holds: CANDIDATE_HOLDS,
    identifierStates: IDENTIFIER_RESOLUTION_STATES,
  },
  commands: { adopt: "identity.assign", keepApart: "relation.reject" },
};

/**
 * Validate an untrusted body: at most `view`, `offset` and `identifierId`.
 * An unknown key is `unsupported_semantics`; a malformed value is
 * `invalid_query` naming the key. An absent body is the first page of `open`.
 */
export function parseInstrumentCandidatesRequest(
  value: unknown,
): { ok: true; value: InstrumentCandidatesRequest } | Rejection {
  const request: InstrumentCandidatesRequest = { view: "open", offset: 0, identifierId: null };
  if (value === undefined || value === null) return { ok: true, value: request };
  if (!isRecord(value)) return { ok: false, code: "invalid_query", refs: [] };
  const unknown = Object.keys(value).filter(
    (key) => !(INSTRUMENT_CANDIDATES_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0)
    return {
      ok: false,
      code: "unsupported_semantics",
      refs: unknown.slice(0, 10).map((key) => key.slice(0, 64)),
    };
  const { view, offset, identifierId } = value;
  if (view !== undefined) {
    if (
      typeof view !== "string" ||
      !(INSTRUMENT_CANDIDATE_VIEWS as readonly string[]).includes(view)
    )
      return { ok: false, code: "invalid_query", refs: ["view"] };
    request.view = view as InstrumentCandidateView;
  }
  if (offset !== undefined) {
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > INSTRUMENT_CANDIDATES_MAX_OFFSET
    )
      return { ok: false, code: "invalid_query", refs: ["offset"] };
    request.offset = offset;
  }
  if (identifierId !== undefined) {
    if (typeof identifierId !== "string" || !INSTRUMENT_IDENTIFIER_ID.test(identifierId))
      return { ok: false, code: "invalid_query", refs: ["identifierId"] };
    request.identifierId = identifierId;
  }
  return { ok: true, value: request };
}

const refs = (ids: readonly string[]): string[] => ids.map((id) => `identifier:${id}`);

function viewItems(resolution: InstrumentResolution, view: InstrumentCandidateView): ReviewItem[] {
  const candidates = (keep: (candidate: ResolutionCandidate) => boolean): ReviewCandidate[] =>
    resolution.candidates.filter(keep).map((candidate) => ({
      ...candidate,
      evidenceRefs: refs([candidate.anchorIdentifierId, candidate.subjectIdentifierId]),
    }));
  switch (view) {
    case "open":
      return candidates((candidate) => candidate.status === "proposed" && candidate.hold === null);
    case "held":
      return candidates((candidate) => candidate.status === "proposed" && candidate.hold !== null);
    case "decided":
      return candidates((candidate) => candidate.status !== "proposed");
    case "separated":
      return resolution.separated.map((pair) => ({
        ...pair,
        evidenceRefs: refs([...pair.identifierIds, ...pair.via]),
      }));
    case "hints":
      return resolution.hints.map((hint) => ({ ...hint, evidenceRefs: refs(hint.identifierIds) }));
  }
}

/** Identifier ids an item names: both sides and, for a separated pair, every `via`. */
function namedIdentifiers(item: ReviewItem): string[] {
  if ("anchorIdentifierId" in item) return [item.anchorIdentifierId, item.subjectIdentifierId];
  return "via" in item ? [...item.identifierIds, ...item.via] : [...item.identifierIds];
}

/**
 * One page of the review for one validated request, or the typed refusal.
 * The capability and perimeter refusals and the paging budget are decided
 * before the store is read; the read's own bound and an identifier that names
 * nothing can only be known after it.
 */
export async function reviewInstrumentCandidates(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: InstrumentCandidatesRequest;
}): Promise<InstrumentCandidatesOutcome> {
  const { grant, sql, request } = input;
  const fail = (code: FinancialErrorCode, failureRefs: string[]): InstrumentCandidatesOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, failureRefs),
  });
  if (!grantAllows(grant, INSTRUMENT_CANDIDATES_CAPABILITY))
    return fail("unauthorized", [`capability:${INSTRUMENT_CANDIDATES_CAPABILITY}`]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  if (request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);

  let resolution: InstrumentResolution;
  try {
    resolution = await queryInstrumentResolution(sql);
  } catch (error) {
    // A store past the read's bounds is refused whole, never answered in part.
    if (error instanceof InstrumentResolutionLimitError)
      return fail("budget_exceeded", ["budget:instrumentResolution"]);
    throw error;
  }
  const { identifierId } = request;
  if (
    identifierId !== null &&
    !resolution.identifiers.some((row) => row.identifierId === identifierId)
  )
    return fail("evidence_restricted", ["identifierId"]);

  const all = viewItems(resolution, request.view).filter(
    (item) => identifierId === null || namedIdentifiers(item).includes(identifierId),
  );
  const items = all.slice(request.offset, request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE);
  const named = new Set(items.flatMap(namedIdentifiers));
  const nextOffset =
    request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE < all.length
      ? request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE
      : null;
  return {
    ok: true,
    review: {
      schemaVersion: "kogane-instrument-candidates-v1",
      query: { ...request },
      manifest: INSTRUMENT_CANDIDATES_MANIFEST,
      summary: {
        ...resolution.summary,
        held: resolution.candidates.filter(
          (candidate) => candidate.status === "proposed" && candidate.hold !== null,
        ).length,
      },
      decisions: "change-lifecycle",
      total: all.length,
      items,
      nextOffset,
      identifiers: resolution.identifiers
        .filter((row) => named.has(row.identifierId))
        .sort((a, b) =>
          a.identifierId < b.identifierId ? -1 : a.identifierId > b.identifierId ? 1 : 0,
        ),
    },
  };
}

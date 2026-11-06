// The account correspondence candidate review (ADR 0077): one bounded page of
// the candidates between an aggregator connection (a MoneyForward account
// identity) and the direct provider's source accounts, for whoever the grant
// allows, whether the caller is the `口座の対応候補` page
// (`GET /api/identity/account-candidates`, under the reader grant a signed-in
// browser has) or an agent (`kogane.accounts.candidates`, under its own
// grant). Both transports call `reviewAccountCandidates` and nothing else, so
// a page and an agent read one answer.
//
// It reads, and nothing else. A candidate carries the payloads of the existing
// commands that would decide it (`relation.accept` / `relation.reject` of
// `connection_contains`); planning, approving and committing them is the
// change lifecycle's (`/api/command/v1/*`), graded by its own grant lists
// exactly as for any other plan. No `same_account` is ever proposed.
//
// - The grant decides. `records.read` is required: the answer is structured
//   identity records and the codes computed over them.
// - The whole store or nothing. A candidate pairs an aggregator's source
//   account with a direct provider's, so a grant listed on either axis is
//   refused before anything is read (SC18), as for instrument candidates.
// - Bounded. The read refuses past its bounds (64 reviews, 1,000 aggregator
//   source accounts, 10,000 relations: `budget_exceeded`, never cut); the page
//   is `ACCOUNT_CANDIDATES_PAGE_SIZE` items, and the grant's `maxRows` bounds
//   how deep a caller pages.
import {
  ACCOUNT_CANDIDATE_EVIDENCE,
  ACCOUNT_CANDIDATE_HOLDS,
  ACCOUNT_CANDIDATE_POLICY,
  ACCOUNT_CANDIDATE_STATUSES,
  ACCOUNT_CONNECTION_REVIEW_LIMIT,
  ACCOUNT_CONNECTION_STATES,
  ACCOUNT_RELATION_LIMIT,
  AccountCandidateLimitError,
  accountCandidates,
  AGGREGATOR_ACCOUNT_LIMIT,
  CONTAINMENT_REFERENCES,
  SAME_ACCOUNT_REASONS,
  UNREVIEWED_REASONS,
  type AccountCandidate,
  type AccountCandidateSet,
  type AccountConnectionEntry,
  type ConnectionReviewFact,
  type UnreviewedAggregatorAccount,
} from "../../../domain/src/account-candidates.ts";
import { isRecord } from "../../../domain/src/guards.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import {
  readAccountConnectionReviews,
  readAccountRelations,
  readAccountSourceFacts,
  readAggregatorSourceAccounts,
  readLegacyConnectionRelations,
  type AccountConnectionReviewRow,
  type AccountSourceFactsRow,
} from "../../../read-model/src/account-candidates.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";

export type { AccountCandidate, AccountConnectionEntry, UnreviewedAggregatorAccount };
export type AccountSourceFacts = AccountSourceFactsRow;

const ACCOUNT_CANDIDATES_CAPABILITY: AgentCapability = "records.read";
/**
 * Which list a page holds:
 * - `open`: proposed candidates a command may accept now (no hold);
 * - `held`: proposed candidates whose acceptance is withheld (`hold` names
 *   why); keeping them apart is still offered;
 * - `decided`: accepted and rejected candidates;
 * - `connections`: every current connection review with its state;
 * - `unreviewed`: aggregator source accounts no current review names.
 */
export const ACCOUNT_CANDIDATE_VIEWS = [
  "open",
  "held",
  "decided",
  "connections",
  "unreviewed",
] as const;
export type AccountCandidateView = (typeof ACCOUNT_CANDIDATE_VIEWS)[number];
/** Items one page holds. */
export const ACCOUNT_CANDIDATES_PAGE_SIZE = 50;
/** The largest offset a request may name: past every pair the read may hold (64 reviews of 100 references). */
export const ACCOUNT_CANDIDATES_MAX_OFFSET = ACCOUNT_CONNECTION_REVIEW_LIMIT * 100;
/** Every key a request may carry; any other key is refused, never ignored. */
export const ACCOUNT_CANDIDATES_KEYS = ["view", "offset", "sourceAccountId"] as const;
/** A source account id as the identity writer stores one, or a test fixture's (at most 256 characters, as a review pins it). */
export const ACCOUNT_SOURCE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const REQUEST_ID = "accounts.candidates";

export interface AccountCandidatesRequest {
  view: AccountCandidateView;
  offset: number;
  /** Only the items naming this source account (either side); null for every item. */
  sourceAccountId: string | null;
}

export type AccountCandidateItem =
  | AccountCandidate
  | AccountConnectionEntry
  | UnreviewedAggregatorAccount;

interface AccountCandidatesManifest {
  policy: typeof ACCOUNT_CANDIDATE_POLICY;
  bounds: {
    reviews: number;
    aggregatorAccounts: number;
    relations: number;
    pageSize: number;
    maxOffset: number;
  };
  codes: {
    evidence: readonly string[];
    statuses: readonly string[];
    holds: readonly string[];
    sameAccountReasons: readonly string[];
    containmentReferences: readonly string[];
    connectionStates: readonly string[];
    unreviewedReasons: readonly string[];
  };
  /** The command kinds a candidate may name, all of `connection_contains`; planned through the change lifecycle. */
  commands: {
    accept: "relation.accept";
    reject: "relation.reject";
    relationKind: "connection_contains";
  };
}

export interface AccountCandidateReview {
  schemaVersion: "kogane-account-candidates-v1";
  query: AccountCandidatesRequest;
  manifest: AccountCandidatesManifest;
  /** Counts over the whole read, whatever the view. */
  summary: AccountCandidateSet["summary"];
  /** A decision is a plan of the named command through the change lifecycle; this answer changes nothing. */
  decisions: "change-lifecycle";
  /** Items in this view (after the source account filter), of which `items` is one page. */
  total: number;
  items: AccountCandidateItem[];
  nextOffset: number | null;
  /** Every source account the page's items name, with its current mapping, sorted by id. */
  sourceAccounts: AccountSourceFacts[];
}

export type AccountCandidatesOutcome =
  | { ok: true; review: AccountCandidateReview }
  | { ok: false; error: FinancialError };

type Rejection = { ok: false; code: FinancialErrorCode; refs: string[] };

const ACCOUNT_CANDIDATES_MANIFEST: AccountCandidatesManifest = {
  policy: ACCOUNT_CANDIDATE_POLICY,
  bounds: {
    reviews: ACCOUNT_CONNECTION_REVIEW_LIMIT,
    aggregatorAccounts: AGGREGATOR_ACCOUNT_LIMIT,
    relations: ACCOUNT_RELATION_LIMIT,
    pageSize: ACCOUNT_CANDIDATES_PAGE_SIZE,
    maxOffset: ACCOUNT_CANDIDATES_MAX_OFFSET,
  },
  codes: {
    evidence: ACCOUNT_CANDIDATE_EVIDENCE,
    statuses: ACCOUNT_CANDIDATE_STATUSES,
    holds: ACCOUNT_CANDIDATE_HOLDS,
    sameAccountReasons: SAME_ACCOUNT_REASONS,
    containmentReferences: CONTAINMENT_REFERENCES,
    connectionStates: ACCOUNT_CONNECTION_STATES,
    unreviewedReasons: UNREVIEWED_REASONS,
  },
  commands: {
    accept: "relation.accept",
    reject: "relation.reject",
    relationKind: "connection_contains",
  },
};

/** Thrown when a stored review's reference set is not the shape its CHECK and trigger admit. */
class AccountCandidateStoreError extends Error {}

function directReferences(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new AccountCandidateStoreError("connection_direct_reference_invalid");
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  )
    throw new AccountCandidateStoreError("connection_direct_reference_invalid");
  return value as string[];
}

function reviewFact(row: AccountConnectionReviewRow): ConnectionReviewFact {
  return {
    producerId: row.producerId,
    connectionKey: row.connectionKey,
    revision: row.revision,
    status: row.status,
    evidenceEligible: row.evidenceEligible === 1,
    label: row.label,
    relatedSourceId: row.relatedSourceId,
    directProducerId: row.directProducerId,
    directSourceAccountIds: directReferences(row.directReferenceIdsJson),
    artifactIds: [row.detailArtifactId, row.directArtifactId, row.branchArtifactId].filter(
      (id): id is number => id !== null,
    ),
  };
}

const MONEYFORWARD_PREFIX = "moneyforward-me:";

/** The identity value a `moneyforward-me` reference names, or null when it names none. */
function connectionKeyOf(referenceJson: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(referenceJson);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") return null;
  const reference = value[0];
  return reference.startsWith(MONEYFORWARD_PREFIX) && reference.length > MONEYFORWARD_PREFIX.length
    ? reference.slice(MONEYFORWARD_PREFIX.length)
    : null;
}

/**
 * The whole candidate set of the store. Throws `AccountCandidateLimitError`
 * past a bound; the caller refuses the answer whole.
 */
export async function queryAccountCandidates(sql: SqlExecutor): Promise<AccountCandidateSet> {
  const reviews = await readAccountConnectionReviews(sql);
  const aggregators = await readAggregatorSourceAccounts(sql);
  const relations = await readAccountRelations(sql);
  const legacyRelations = await readLegacyConnectionRelations(sql);
  // Each read returns one row past its bound; the domain refuses that row
  // count before it interprets any of them.
  return accountCandidates({
    reviews: reviews.map(reviewFact),
    aggregatorAccounts: aggregators.map((row) => ({
      sourceAccountId: row.sourceAccountId,
      producerId: row.producerId,
      connectionKey: connectionKeyOf(row.referenceJson),
    })),
    relations,
    legacyRelations,
  });
}

/**
 * Validate an untrusted body: at most `view`, `offset` and `sourceAccountId`.
 * An unknown key is `unsupported_semantics`; a malformed value is
 * `invalid_query` naming the key. An absent body is the first page of `open`.
 */
export function parseAccountCandidatesRequest(
  value: unknown,
): { ok: true; value: AccountCandidatesRequest } | Rejection {
  const request: AccountCandidatesRequest = { view: "open", offset: 0, sourceAccountId: null };
  if (value === undefined || value === null) return { ok: true, value: request };
  if (!isRecord(value)) return { ok: false, code: "invalid_query", refs: [] };
  const unknown = Object.keys(value).filter(
    (key) => !(ACCOUNT_CANDIDATES_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0)
    return {
      ok: false,
      code: "unsupported_semantics",
      refs: unknown.slice(0, 10).map((key) => key.slice(0, 64)),
    };
  const { view, offset, sourceAccountId } = value;
  if (view !== undefined) {
    if (typeof view !== "string" || !(ACCOUNT_CANDIDATE_VIEWS as readonly string[]).includes(view))
      return { ok: false, code: "invalid_query", refs: ["view"] };
    request.view = view as AccountCandidateView;
  }
  if (offset !== undefined) {
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > ACCOUNT_CANDIDATES_MAX_OFFSET
    )
      return { ok: false, code: "invalid_query", refs: ["offset"] };
    request.offset = offset;
  }
  if (sourceAccountId !== undefined) {
    if (typeof sourceAccountId !== "string" || !ACCOUNT_SOURCE_ACCOUNT_ID.test(sourceAccountId))
      return { ok: false, code: "invalid_query", refs: ["sourceAccountId"] };
    request.sourceAccountId = sourceAccountId;
  }
  return { ok: true, value: request };
}

function viewItems(set: AccountCandidateSet, view: AccountCandidateView): AccountCandidateItem[] {
  switch (view) {
    case "open":
      return set.candidates.filter((item) => item.status === "proposed" && item.hold === null);
    case "held":
      return set.candidates.filter((item) => item.status === "proposed" && item.hold !== null);
    case "decided":
      return set.candidates.filter((item) => item.status !== "proposed");
    case "connections":
      return set.connections;
    case "unreviewed":
      return set.unreviewed;
  }
}

/** Source account ids an item names: both sides of a candidate or connection, or the account itself. */
function namedSourceAccounts(item: AccountCandidateItem): string[] {
  if ("candidateId" in item)
    return [item.directSourceAccountId, ...item.aggregatorSourceAccountIds];
  if ("connectionRef" in item)
    return [...item.directSourceAccountIds, ...item.aggregatorSourceAccountIds];
  return [item.sourceAccountId];
}

/**
 * One page of the review for one validated request, or the typed refusal.
 * The capability and perimeter refusals and the paging budget are decided
 * before the store is read.
 */
export async function reviewAccountCandidates(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: AccountCandidatesRequest;
}): Promise<AccountCandidatesOutcome> {
  const { grant, sql, request } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): AccountCandidatesOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, refs),
  });
  if (!grantAllows(grant, ACCOUNT_CANDIDATES_CAPABILITY))
    return fail("unauthorized", [`capability:${ACCOUNT_CANDIDATES_CAPABILITY}`]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  if (request.offset + ACCOUNT_CANDIDATES_PAGE_SIZE > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);

  let set: AccountCandidateSet;
  try {
    set = await queryAccountCandidates(sql);
  } catch (error) {
    if (error instanceof AccountCandidateLimitError)
      return fail("budget_exceeded", [`budget:accountCandidates.${error.bound}`]);
    throw error;
  }
  const { sourceAccountId } = request;
  const all = viewItems(set, request.view);
  if (
    sourceAccountId !== null &&
    ![...set.candidates, ...set.connections, ...set.unreviewed].some((item) =>
      namedSourceAccounts(item).includes(sourceAccountId),
    )
  )
    return fail("evidence_restricted", ["sourceAccountId"]);
  const filtered = all.filter(
    (item) => sourceAccountId === null || namedSourceAccounts(item).includes(sourceAccountId),
  );
  const items = filtered.slice(request.offset, request.offset + ACCOUNT_CANDIDATES_PAGE_SIZE);
  const named = [...new Set(items.flatMap(namedSourceAccounts))].sort();
  const following = request.offset + ACCOUNT_CANDIDATES_PAGE_SIZE;
  const nextOffset =
    following < filtered.length && following + ACCOUNT_CANDIDATES_PAGE_SIZE <= grant.budget.maxRows
      ? following
      : null;
  return {
    ok: true,
    review: {
      schemaVersion: "kogane-account-candidates-v1",
      query: { ...request },
      manifest: ACCOUNT_CANDIDATES_MANIFEST,
      summary: set.summary,
      decisions: "change-lifecycle",
      total: filtered.length,
      items,
      nextOffset,
      sourceAccounts: await readAccountSourceFacts(sql, named),
    },
  };
}

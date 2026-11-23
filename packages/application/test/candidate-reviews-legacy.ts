// `reviewAccountCandidates` and `reviewInstrumentCandidates` as they shipped
// before ADR 0128 slice S6 added `next` and `paging` (main at b9f53571a,
// #1457), frozen: the differential test runs them beside the shipped readers
// and asserts every answer is the same but for those two fields. They call the
// shipped helpers the S6 change did not touch (the candidate set, the view,
// the source facts, the bounded resolution); the paging and the answer's
// shape are this file's own text. Do not edit it to follow a later change of
// the shipped readers.
import {
  ACCOUNT_CANDIDATE_EVIDENCE,
  ACCOUNT_CANDIDATE_HOLDS,
  ACCOUNT_CANDIDATE_POLICY,
  ACCOUNT_CANDIDATE_STATUSES,
  ACCOUNT_CONNECTION_REVIEW_LIMIT,
  ACCOUNT_CONNECTION_STATES,
  ACCOUNT_RELATION_LIMIT,
  AccountCandidateLimitError,
  AGGREGATOR_ACCOUNT_LIMIT,
  CONTAINMENT_REFERENCES,
  SAME_ACCOUNT_REASONS,
  UNREVIEWED_REASONS,
  type AccountCandidateSet,
} from "../../domain/src/account-candidates.ts";
import type { FinancialErrorCode } from "../../domain/src/result.ts";
import { readAccountSourceFacts } from "../../read-model/src/account-candidates.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { financialError } from "../src/errors.ts";
import { type Grant, grantAllows } from "../src/grants.ts";
import {
  ACCOUNT_CANDIDATES_MAX_OFFSET,
  ACCOUNT_CANDIDATES_PAGE_SIZE,
  accountCandidateView,
  queryAccountCandidates,
  type AccountCandidateItem,
  type AccountCandidatesRequest,
} from "../src/query/account-candidates.ts";
import {
  boundedInstrumentResolution,
  INSTRUMENT_CANDIDATES_MANIFEST,
  INSTRUMENT_CANDIDATES_PAGE_SIZE,
  instrumentCandidateView,
  type InstrumentCandidatesRequest,
  type ReviewItem,
} from "../src/query/instrument-candidates-review.ts";

const ACCOUNT_CANDIDATES_MANIFEST = {
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

function namedSourceAccounts(item: AccountCandidateItem): string[] {
  if ("candidateId" in item)
    return [item.directSourceAccountId, ...item.aggregatorSourceAccountIds];
  if ("connectionRef" in item)
    return [...item.directSourceAccountIds, ...item.aggregatorSourceAccountIds];
  return [item.sourceAccountId];
}

export async function legacyReviewAccountCandidates(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: AccountCandidatesRequest;
}) {
  const { grant, sql, request } = input;
  const fail = (code: FinancialErrorCode, refs: string[]) => ({
    ok: false as const,
    error: financialError(code, "accounts.candidates", refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
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
  const all = accountCandidateView(set, request.view);
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
    ok: true as const,
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

function namedIdentifiers(item: ReviewItem): string[] {
  if ("anchorIdentifierId" in item) return [item.anchorIdentifierId, item.subjectIdentifierId];
  return "via" in item ? [...item.identifierIds, ...item.via] : [...item.identifierIds];
}

export async function legacyReviewInstrumentCandidates(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: InstrumentCandidatesRequest;
}) {
  const { grant, sql, request } = input;
  const fail = (code: FinancialErrorCode, failureRefs: string[]) => ({
    ok: false as const,
    error: financialError(code, "instruments.candidates", failureRefs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  if (request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);

  const read = await boundedInstrumentResolution(sql);
  if (!read.ok) return fail("budget_exceeded", [read.bound]);
  const { resolution } = read;
  const { identifierId } = request;
  if (
    identifierId !== null &&
    !resolution.identifiers.some((row) => row.identifierId === identifierId)
  )
    return fail("evidence_restricted", ["identifierId"]);

  const all = instrumentCandidateView(resolution, request.view).filter(
    (item) => identifierId === null || namedIdentifiers(item).includes(identifierId),
  );
  const items = all.slice(request.offset, request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE);
  const named = new Set(items.flatMap(namedIdentifiers));
  const following = request.offset + INSTRUMENT_CANDIDATES_PAGE_SIZE;
  const nextOffset =
    following < all.length && following + INSTRUMENT_CANDIDATES_PAGE_SIZE <= grant.budget.maxRows
      ? following
      : null;
  return {
    ok: true as const,
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

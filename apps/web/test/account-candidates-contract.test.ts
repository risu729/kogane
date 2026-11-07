// The account correspondence candidate review's wire contract (ADR 0077)
// against pages the application service itself produces from the synthetic
// account candidate world, and the route that serves the page. Every value is
// synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  ACCOUNT_CANDIDATE_VIEWS,
  reviewAccountCandidates,
  type AccountCandidateReview,
} from "../../../packages/application/src/query/account-candidates.ts";
import { world, type Store } from "../../../packages/application/test/account-candidates-world.ts";
import { stubDatabase } from "../../../packages/application/test/instrument-resolution-world.ts";
import { ACCOUNT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/account-candidates-contract.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { matchRoute } from "../src/router.tsx";

const pages = new Map<string, AccountCandidateReview>();

async function read(of: Store, view: (typeof ACCOUNT_CANDIDATE_VIEWS)[number]) {
  const outcome = await reviewAccountCandidates({
    grant: {
      principal: "synthetic-reader",
      scopes: { sources: "*", accounts: "*" },
      capabilities: ["records.read"],
      budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
    },
    sql: of.sql,
    request: { view, offset: 0, sourceAccountId: null },
  });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.review;
}

beforeAll(async () => {
  stubDatabase().close();
  const store = world();
  for (const view of ACCOUNT_CANDIDATE_VIEWS) pages.set(view, await read(store, view));
}, 60_000);

const copy = (view: string): any => structuredClone(pages.get(view));

describe("the account candidate review contract", () => {
  test("every page the service produces is accepted", () => {
    for (const view of ACCOUNT_CANDIDATE_VIEWS)
      expect(validApiResponse(ACCOUNT_CANDIDATES_PATH, pages.get(view)), view).toBe(true);
    for (const view of ["open", "held", "connections", "unreviewed"])
      expect(pages.get(view)!.items.length, view).toBeGreaterThan(0);
  });

  test("an unknown code, a proposed same_account, a held acceptance or a foreign payload is refused", () => {
    const unknownHold = copy("held");
    unknownHold.items[0].hold = "name-similar";
    const sameAccount = copy("open");
    sameAccount.items[0].sameAccount.proposed = true;
    const sameAccountCount = copy("open");
    sameAccountCount.summary.sameAccountProposed = 1;
    const unknownReason = copy("open");
    unknownReason.items[0].sameAccount.reasons.push("names-match");
    const heldWithAccept = copy("held");
    heldWithAccept.items[0].commands.accept = copy("open").items[0].commands.accept;
    const otherKind = copy("open");
    otherKind.items[0].commands.accept.payload.relationKind = "same_account";
    const otherTarget = copy("open");
    otherTarget.items[0].commands.reject.payload.toRef = "source_account:other";
    const wrongView = copy("open");
    wrongView.query.view = "decided";
    const unknownState = copy("connections");
    unknownState.items[0].state = "matched";
    const unknownUnreviewed = copy("unreviewed");
    unknownUnreviewed.items[0].reason = "same-name";
    const unknownReference = copy("open");
    unknownReference.items[0].recordedContainment = [
      { fromRef: "connection:x/y", reference: "label-match", status: "accepted" },
    ];
    const unknownRelationStatus = copy("open");
    unknownRelationStatus.items[0].recordedContainment = [
      { fromRef: "connection:x/y", reference: "legacy-connection-key", status: "merged" },
    ];
    const decidedWithoutRelation = copy("open");
    decidedWithoutRelation.query.view = "decided";
    decidedWithoutRelation.items[0].status = "rejected";
    decidedWithoutRelation.items[0].commands.reject = null;
    const otherEvidence = copy("open");
    otherEvidence.items[0].commands.accept.payload.evidenceRefs = ["fetch_artifact:1"];
    const tooMany = copy("open");
    tooMany.items = Array.from({ length: 51 }, () => tooMany.items[0]);
    for (const value of [
      unknownHold,
      sameAccount,
      sameAccountCount,
      unknownReason,
      heldWithAccept,
      otherKind,
      otherTarget,
      wrongView,
      unknownState,
      unknownUnreviewed,
      unknownReference,
      unknownRelationStatus,
      decidedWithoutRelation,
      otherEvidence,
      tooMany,
      { ...copy("open"), decisions: "operator-only" },
      null,
    ])
      expect(validApiResponse(ACCOUNT_CANDIDATES_PATH, value)).toBe(false);
  });

  test("the page has its own route under the identity pages", () => {
    expect(matchRoute("/identities/account-candidates")).toEqual({ name: "accountCandidates" });
    expect(matchRoute("/identities/account-candidates/x").name).toBe("notFound");
  });
});

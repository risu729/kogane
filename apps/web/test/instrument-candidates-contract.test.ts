// The instrument candidate review's wire contract against pages the
// application service itself produces from the synthetic resolution world,
// and the route that serves the page. Every value is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  INSTRUMENT_CANDIDATE_VIEWS,
  reviewInstrumentCandidates,
  type InstrumentCandidateReview,
} from "../../../packages/application/src/query/instrument-candidates-review.ts";
import {
  world,
  type World,
} from "../../../packages/application/test/instrument-resolution-world.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { INSTRUMENT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/instrument-candidates-contract.ts";
import { matchRoute } from "../src/router.tsx";

let store: World;
const pages = new Map<string, InstrumentCandidateReview>();

beforeAll(async () => {
  store = await world();
  for (const view of INSTRUMENT_CANDIDATE_VIEWS) {
    const outcome = await reviewInstrumentCandidates({
      grant: {
        principal: "synthetic-reader",
        scopes: { sources: "*", accounts: "*" },
        capabilities: ["records.read"],
        budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
      },
      sql: store.sql,
      request: { view, offset: 0, identifierId: null },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    pages.set(view, outcome.review);
  }
}, 60_000);

const copy = (view: string): any => structuredClone(pages.get(view));

describe("the instrument candidate review contract", () => {
  test("every page the service produces is accepted", () => {
    for (const view of INSTRUMENT_CANDIDATE_VIEWS)
      expect(validApiResponse(INSTRUMENT_CANDIDATES_PATH, pages.get(view)), view).toBe(true);
    expect(pages.get("open")!.items.length).toBeGreaterThan(0);
    expect(pages.get("separated")!.items.length).toBeGreaterThan(0);
    expect(pages.get("hints")!.items.length).toBeGreaterThan(0);
  });

  test("an unknown code, a status in the wrong view or a decided candidate with commands is refused", () => {
    const unknownGap = copy("open");
    unknownGap.items[0].gaps.push("market-guessed");
    const wrongView = copy("open");
    wrongView.query.view = "decided";
    const decidedWithCommands = copy("open");
    decidedWithCommands.items[0].status = "adopted";
    decidedWithCommands.query.view = "decided";
    const unknownHold = copy("open");
    unknownHold.items[0].hold = "subject-busy";
    const unknownConflict = copy("separated");
    unknownConflict.items[0].conflicts.push("name-differs");
    const tooMany = copy("open");
    tooMany.items = Array.from({ length: 51 }, () => tooMany.items[0]);
    const otherCommand = copy("open");
    otherCommand.items[0].commands.adopt.kind = "identity.release-override";
    const unknownState = copy("open");
    unknownState.identifiers[0].state = "resolved";
    for (const value of [
      unknownGap,
      wrongView,
      decidedWithCommands,
      unknownHold,
      unknownConflict,
      tooMany,
      otherCommand,
      unknownState,
      { ...copy("open"), decisions: "operator-only" },
      null,
    ])
      expect(validApiResponse(INSTRUMENT_CANDIDATES_PATH, value)).toBe(false);
  });

  test("the page has its own route under the identity pages", () => {
    expect(matchRoute("/identities/instrument-candidates")).toEqual({
      name: "instrumentCandidates",
    });
    expect(matchRoute("/identities/instrument-candidates/x").name).toBe("notFound");
    expect(matchRoute("/identities").name).toBe("identities");
  });
});

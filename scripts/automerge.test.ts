// Unit tests for the trusted auto-merge decisions (U13,
// acceptance G5-01, G5-03, G5-04, G5-08). The workflows themselves are
// verified on the first live pull request; everything decidable offline is
// decided by the pure modules under tasks/_lib/ci and tested here.
import { describe, expect, test } from "bun:test";
import {
  AUTOMERGE_LABEL,
  appBotLogin,
  armedByApp,
  evaluateAutomerge,
  labelApprovedByOwner,
  pickBranchUpdate,
  trustedAuthor,
} from "../tasks/_lib/ci/automerge-policy.mjs";
import { nextLink, paginate } from "../tasks/_lib/ci/github-api.mjs";
import renovate from "../.github/renovate.json5";

const OWNER = "risu729";
const HEAD = "1111111111111111111111111111111111111111";

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    state: "open",
    draft: false,
    merged: false,
    mergeable_state: "clean",
    node_id: "PR_node",
    head: { sha: HEAD },
    labels: [],
    user: { login: OWNER, type: "User" },
    ...overrides,
  };
}

describe("auto-merge eligibility", () => {
  test("a ready pull request by the repository owner is eligible (G5-03)", () => {
    const decision = evaluateAutomerge({ pullRequest: pullRequest(), ownerLogin: OWNER });
    expect(decision.eligible).toBe(true);
    expect(decision.trustedBy).toBe("owner");
    expect(decision.shouldUpdateBranch).toBe(false);
  });
  test("a Renovate pull request is eligible only with the bot account type", () => {
    const bot = { login: "renovate[bot]", type: "Bot" };
    expect(trustedAuthor(pullRequest({ user: bot }), { ownerLogin: OWNER })).toBe("renovate");
    const impostor = { login: "renovate[bot]", type: "User" };
    expect(trustedAuthor(pullRequest({ user: impostor }), { ownerLogin: OWNER })).toBeUndefined();
  });
  test("an external pull request is not eligible without an owner label", () => {
    const external = pullRequest({ user: { login: "someone-else", type: "User" } });
    const decision = evaluateAutomerge({ pullRequest: external, ownerLogin: OWNER });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toContain(AUTOMERGE_LABEL);
  });
  const external = pullRequest({
    user: { login: "someone-else", type: "User" },
    labels: [{ name: AUTOMERGE_LABEL }],
  });
  const labeledByOwner = {
    event: "labeled",
    label: { name: AUTOMERGE_LABEL },
    actor: { login: OWNER },
  };
  const labeledByStranger = {
    event: "labeled",
    label: { name: AUTOMERGE_LABEL },
    actor: { login: "someone-else" },
  };
  const unlabeled = {
    event: "unlabeled",
    label: { name: AUTOMERGE_LABEL },
    actor: { login: OWNER },
  };

  test("the approval label counts only when the owner applied it last", () => {
    const byOwner = [labeledByOwner];
    const byStranger = [labeledByStranger];
    const removedAgain = [labeledByOwner, unlabeled];
    // Applied by a stranger, removed, applied by the owner: in force. Then a
    // stranger removes and re-applies it: no longer in force.
    const relabelledByOwner = [labeledByStranger, unlabeled, labeledByOwner];
    const relabelledByStranger = [...relabelledByOwner, unlabeled, labeledByStranger];
    const options = { label: AUTOMERGE_LABEL, ownerLogin: OWNER };
    expect(labelApprovedByOwner(byOwner, options)).toBe(true);
    expect(labelApprovedByOwner(byStranger, options)).toBe(false);
    expect(labelApprovedByOwner(removedAgain, options)).toBe(false);
    expect(labelApprovedByOwner(relabelledByOwner, options)).toBe(true);
    expect(labelApprovedByOwner(relabelledByStranger, options)).toBe(false);
    expect(labelApprovedByOwner(byOwner, { label: "other-label", ownerLogin: OWNER })).toBe(false);
    expect(
      evaluateAutomerge({
        pullRequest: external,
        ownerLogin: OWNER,
        labelEvents: byStranger,
      }).eligible,
    ).toBe(false);
  });
  test("owner labels delegate review requirements to native branch protection", () => {
    for (const state of ["clean", "blocked", "unstable", "unknown", "behind"]) {
      const decision = evaluateAutomerge({
        pullRequest: { ...external, mergeable_state: state },
        ownerLogin: OWNER,
        labelEvents: [labeledByOwner],
      });
      expect(decision.eligible).toBe(true);
      expect(decision.trustedBy).toBe("label");
    }
    expect(
      evaluateAutomerge({
        pullRequest: external,
        ownerLogin: OWNER,
        labelEvents: [labeledByOwner, unlabeled],
      }).eligible,
    ).toBe(false);
  });
  test("only what the app armed may the app disarm", () => {
    const appLogin = appBotLogin("kogane-automation");
    expect(appLogin).toBe("kogane-automation[bot]");
    expect(appBotLogin(undefined)).toBeUndefined();
    const armed = pullRequest({ auto_merge: { enabled_by: { login: appLogin } } });
    const armedByOwner = pullRequest({ auto_merge: { enabled_by: { login: OWNER } } });
    expect(armedByApp(armed, { appLogin })).toBe(true);
    expect(armedByApp(armedByOwner, { appLogin })).toBe(false);
    expect(armedByApp(pullRequest({ auto_merge: null }), { appLogin })).toBe(false);
    // Without a known app login nothing is ever disarmed.
    expect(armedByApp(armed, { appLogin: undefined })).toBe(false);
  });
  test("the sweep after a push updates the oldest armed, eligible, behind pull request", () => {
    const candidate = (number: number, overrides: Record<string, unknown>) => ({
      number,
      armed: true,
      decision: { eligible: true, shouldUpdateBranch: true },
      ...overrides,
    });
    expect(
      pickBranchUpdate([
        candidate(1, { decision: { eligible: true, shouldUpdateBranch: false } }),
        candidate(2, { armed: false }),
        candidate(3, { decision: { eligible: false, shouldUpdateBranch: true } }),
        candidate(4, {}),
        candidate(5, {}),
      ]),
    ).toBe(4);
    expect(pickBranchUpdate([candidate(1, { armed: false })])).toBeUndefined();
    expect(pickBranchUpdate([])).toBeUndefined();
  });
  test("draft, closed and conflicted pull requests never auto-merge (G5-04)", () => {
    for (const overrides of [
      { draft: true },
      { state: "closed" },
      { merged: true },
      { mergeable_state: "dirty" },
    ]) {
      const decision = evaluateAutomerge({
        pullRequest: pullRequest(overrides),
        ownerLogin: OWNER,
      });
      expect(decision.eligible).toBe(false);
      expect(decision.shouldUpdateBranch).toBe(false);
    }
  });
  test("a behind branch stays eligible and asks for a branch update (G5-02, G5-06)", () => {
    const decision = evaluateAutomerge({
      pullRequest: pullRequest({ mergeable_state: "behind" }),
      ownerLogin: OWNER,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.shouldUpdateBranch).toBe(true);
  });
  test("pending checks are left to the ruleset, not decided here (G5-01)", () => {
    for (const state of ["blocked", "unstable", "unknown"]) {
      expect(
        evaluateAutomerge({
          pullRequest: pullRequest({ mergeable_state: state }),
          ownerLogin: OWNER,
        }).eligible,
      ).toBe(true);
    }
  });
});

describe("GitHub API pagination fails closed", () => {
  const page = (items: unknown[], next?: string) =>
    new Response(JSON.stringify(items), {
      status: 200,
      headers: next ? { link: `<${next}>; rel="next"` } : {},
    });
  test("Link headers are followed to the end", async () => {
    const pages = new Map([
      ["https://api/a?page=1", page([1, 2], "https://api/a?page=2")],
      ["https://api/a?page=2", page([3])],
    ]);
    const fetchImpl = ((url: string) => Promise.resolve(pages.get(url)!)) as typeof fetch;
    const items = await paginate("https://api/a?page=1", { token: "t", fetchImpl });
    expect(items).toEqual([1, 2, 3]);
    expect(nextLink('<https://api/a?page=2>; rel="next", <https://api/a?page=9>; rel="last"')).toBe(
      "https://api/a?page=2",
    );
    expect(nextLink(null)).toBeUndefined();
  });
  test("a collection longer than the page limit throws instead of returning a prefix", async () => {
    // The latest label event decides; a silent prefix would hide an
    // `unlabeled` event that came after page 1.
    const fetchImpl = ((url: string) =>
      Promise.resolve(page([url], "https://api/a?next"))) as typeof fetch;
    await expect(paginate("https://api/a", { token: "t", limit: 2, fetchImpl })).rejects.toThrow(
      "more than 2 pages",
    );
  });
  test("a non-list body is an error, not an empty collection", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "x" }), { status: 200 }),
      )) as typeof fetch;
    await expect(paginate("https://api/a", { token: "t", fetchImpl })).rejects.toThrow(
      "did not return a list",
    );
  });
});

describe("Renovate configuration", () => {
  const rules = renovate.packageRules as {
    matchPackageNames?: string[];
    matchFileNames?: string[];
    groupName?: string;
    addLabels?: string[];
  }[];
  test("extends the shared preset at the pinned tag and parses as JSON5", () => {
    expect(renovate.extends).toEqual(["github>risu729/renovate-config#3.19.0"]);
    expect(rules.length).toBeGreaterThan(0);
  });
  test("the typescript group name matches the preset's, so the rules merge instead of competing", () => {
    // risu729/renovate-config 3.19.0 declares `matchDepNames: ["typescript",
    // "npm:typescript"], groupName: "typescript"`; a different local name would
    // split one update into two branches.
    const localGroup = rules.find((rule) =>
      rule.matchPackageNames?.includes("typescript"),
    )?.groupName;
    expect(localGroup).toBe("typescript");
  });
  test("dependency groups have distinct names", () => {
    const groups = rules.map((rule) => rule.groupName).filter(Boolean);
    expect(new Set(groups).size).toBe(groups.length);
  });
});

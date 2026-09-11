// Unit tests for the trusted auto-merge and Risk Gate decisions (U13,
// acceptance G5-01, G5-03, G5-04, G5-05, G5-08). The workflows themselves are
// verified on the first live pull request; everything decidable offline is
// decided by the pure modules under .github/scripts and tested here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AUTOMERGE_LABEL,
  appBotLogin,
  armedByApp,
  evaluateAutomerge,
  labelApprovedByOwner,
  pickBranchUpdate,
  trustedAuthor,
} from "../.github/scripts/automerge-policy.mjs";
import { nextLink, paginate } from "../.github/scripts/github-api.mjs";
import {
  assessRisk,
  changedPaths,
  explainFailure,
  matchesPattern,
  ownerApprovalForHead,
} from "../.github/scripts/risk-paths.mjs";
import renovate from "../.github/renovate.json5";
import { REPO_ROOT } from "../tasks/_lib/repo-root.ts";

const OWNER = "risu729";
const HEAD = "1111111111111111111111111111111111111111";
const STALE = "2222222222222222222222222222222222222222";

const LEDGER = JSON.parse(readFileSync(join(REPO_ROOT, "infra/risk-paths.json"), "utf8")) as {
  labels: { name: string }[];
  rules: { id: string; reason: string; paths: string[] }[];
};

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
  const ownerApprovedHead = { state: "APPROVED", commit_id: HEAD, user: { login: OWNER } };

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
        reviews: [ownerApprovedHead],
      }).eligible,
    ).toBe(false);
  });
  test("the label path is bound to the head the owner approved (G5-05)", () => {
    const labelled = { pullRequest: external, ownerLogin: OWNER, labelEvents: [labeledByOwner] };
    // Label alone: not enough, it would carry over to whatever is pushed next.
    const unreviewed = evaluateAutomerge(labelled);
    expect(unreviewed.eligible).toBe(false);
    expect(unreviewed.reason).toContain(HEAD);
    // Label plus the owner's approval of this exact head: eligible.
    const reviewed = evaluateAutomerge({ ...labelled, reviews: [ownerApprovedHead] });
    expect(reviewed.eligible).toBe(true);
    expect(reviewed.trustedBy).toBe("label");
    // The author pushed again after the approval (synchronize): not eligible.
    const stale = evaluateAutomerge({
      ...labelled,
      reviews: [{ ...ownerApprovedHead, commit_id: STALE }],
    });
    expect(stale.eligible).toBe(false);
    expect(stale.reason).toContain("no review by");
    // A stranger's approval of the head does not count.
    expect(
      evaluateAutomerge({
        ...labelled,
        reviews: [{ ...ownerApprovedHead, user: { login: "someone-else" } }],
      }).eligible,
    ).toBe(false);
    // The owner's own pull requests need neither the label nor a review.
    expect(evaluateAutomerge({ pullRequest: pullRequest(), ownerLogin: OWNER }).eligible).toBe(
      true,
    );
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
    // The latest label event or review is what decides; a silent prefix would
    // hide an `unlabeled` or a CHANGES_REQUESTED that came after page 1.
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

describe("risk path ledger", () => {
  test("patterns match by segment and support ** and *", () => {
    expect(matchesPattern("infra/risk-paths.json", "infra/**")).toBe(true);
    expect(matchesPattern("services/app/wrangler.jsonc", "**/wrangler*.jsonc")).toBe(true);
    expect(matchesPattern("wrangler.jsonc", "**/wrangler*.jsonc")).toBe(true);
    expect(matchesPattern("docs/wrangler.md", "**/wrangler*.jsonc")).toBe(false);
    expect(matchesPattern("poc/vpass-json/src/index.ts", "poc/*-worker/src/**")).toBe(false);
    expect(matchesPattern("poc/vpoint-worker/src/deep/file.ts", "poc/*-worker/src/**")).toBe(true);
  });
  test("the shipped ledger classifies the paths chapter 10 calls high risk", () => {
    const highRisk = [
      "services/raw-evidence/migrations/0001_initial.sql",
      "packages/storage-d1/migrations/core/0038_source_revision.sql",
      "services/evidence-browser/src/auth.ts",
      "services/app/src/auth.ts",
      "poc/moneyforward-worker/src/index.ts",
      "poc/moneyforward-worker/package.json",
      "poc/moneyforward-worker/bun.lock",
      "services/collector-moneyforward/src/index.ts",
      "services/collector-moneyforward/package.json",
      // The container image and the operator scripts of a promoted collector
      // run with the same credentials as its Worker (plan 12 §5).
      "services/collector-globalpass/container/server.mjs",
      "services/collector-globalpass/Dockerfile",
      "services/collector-sbi-shinsei/scripts/set-credentials.sh",
      // Every collector bundles the diagnostics helper; it decides what an
      // error is allowed to leave behind in the logs.
      "packages/collector-diagnostics/src/index.ts",
      ".github/workflows/ci.yml",
      ".github/scripts/automerge.mjs",
      "services/processor/wrangler.ops.jsonc",
      "infra/risk-paths.json",
    ];
    for (const path of highRisk) {
      const assessment = assessRisk({ changedFiles: [path], ledger: LEDGER });
      expect([path, assessment.level]).toEqual([path, "high"]);
    }
  });
  test("ordinary reader, UI and documentation changes stay low risk", () => {
    const assessment = assessRisk({
      changedFiles: [
        "docs/ci-cd.md",
        "packages/read-model/src/queries.ts",
        "packages/read-model/package.json",
        "apps/web/package.json",
        "poc/moneyforward-worker/README.md",
        "services/collector-moneyforward/README.md",
        "services/collector-globalpass/docs/turnstile-local-analysis.md",
        "packages/collector-diagnostics/README.md",
        "poc/observation-pipeline/web/src/App.tsx",
        "apps/web/src/app.tsx",
        "services/app/src/routes.ts",
      ],
      ledger: LEDGER,
    });
    expect(assessment.level).toBe("low");
    expect(assessment.paths).toEqual([]);
  });
  test("a declared high-risk label raises the gate without a high-risk path", () => {
    const label = LEDGER.labels[0]?.name ?? "high-risk";
    const assessment = assessRisk({
      changedFiles: ["packages/parsers/package.json"],
      labels: [label],
      ledger: LEDGER,
    });
    expect(assessment.level).toBe("high");
    expect(assessment.labels[0]?.label).toBe(label);
  });
  test("a truncated changed-file list fails closed", () => {
    const assessment = assessRisk({ changedFiles: ["README.md"], ledger: LEDGER, truncated: true });
    expect(assessment.level).toBe("high");
  });
  test("a rename keeps both the new and the previous path, so moving out is high risk", () => {
    const files = [
      { filename: "docs/auth.md", previous_filename: "services/evidence-browser/src/auth.ts" },
      { filename: "README.md" },
    ];
    const paths = changedPaths(files);
    expect(paths).toEqual(["docs/auth.md", "services/evidence-browser/src/auth.ts", "README.md"]);
    expect(assessRisk({ changedFiles: paths, ledger: LEDGER }).level).toBe("high");
  });
});

describe("owner approval on the current head (G5-05)", () => {
  const approvedHead = {
    state: "APPROVED",
    commit_id: HEAD,
    user: { login: OWNER },
  };
  test("an approval of the current head by the owner passes the gate", () => {
    expect(
      ownerApprovalForHead([approvedHead], { ownerLogin: OWNER, headSha: HEAD }).approved,
    ).toBe(true);
  });
  test("an approval of an older head does not carry over to the new head", () => {
    const stale = { ...approvedHead, commit_id: STALE };
    const result = ownerApprovalForHead([stale], { ownerLogin: OWNER, headSha: HEAD });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain(HEAD);
  });
  test("an approval by anyone but the owner does not count", () => {
    const other = { ...approvedHead, user: { login: "someone-else" } };
    expect(ownerApprovalForHead([other], { ownerLogin: OWNER, headSha: HEAD }).approved).toBe(
      false,
    );
  });
  test("a later non-approving review by the owner supersedes the approval", () => {
    const reviews = [
      approvedHead,
      { state: "CHANGES_REQUESTED", commit_id: HEAD, user: { login: OWNER } },
    ];
    const result = ownerApprovalForHead(reviews, { ownerLogin: OWNER, headSha: HEAD });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("CHANGES_REQUESTED");
  });
  test("plain comments and dismissed approvals do not approve", () => {
    const comments = [{ state: "COMMENTED", commit_id: HEAD, user: { login: OWNER } }];
    expect(ownerApprovalForHead(comments, { ownerLogin: OWNER, headSha: HEAD }).approved).toBe(
      false,
    );
    const dismissed = [{ state: "DISMISSED", commit_id: HEAD, user: { login: OWNER } }];
    expect(ownerApprovalForHead(dismissed, { ownerLogin: OWNER, headSha: HEAD }).approved).toBe(
      false,
    );
  });
  test("the failure message lists the paths and never the pull request title", () => {
    const assessment = assessRisk({
      changedFiles: ["services/evidence-browser/src/auth.ts"],
      ledger: LEDGER,
    });
    const message = explainFailure(assessment, {
      ownerLogin: OWNER,
      headSha: HEAD,
      approvalReason: "no review",
    });
    expect(message).toContain("services/evidence-browser/src/auth.ts");
    expect(message).toContain("authorization");
    expect(message).toContain(HEAD);
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
  test("the high-risk label Renovate adds is the one the ledger gates on", () => {
    const labelled = rules.filter((rule) => rule.addLabels?.includes("high-risk"));
    expect(labelled.length).toBe(1);
    expect(LEDGER.labels.map((label) => label.name)).toContain("high-risk");
    const groups = rules.map((rule) => rule.groupName).filter(Boolean);
    expect(new Set(groups).size).toBe(groups.length);
  });
});

// Unit tests for the trusted auto-merge and Risk Gate decisions (U13,
// acceptance G5-01, G5-03, G5-04, G5-05, G5-08). The workflows themselves are
// verified on the first live pull request; everything decidable offline is
// decided by the pure modules under .github/scripts and tested here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AUTOMERGE_LABEL,
  evaluateAutomerge,
  labelApprovedByOwner,
  trustedAuthor,
} from "../.github/scripts/automerge-policy.mjs";
import {
  assessRisk,
  changedPaths,
  explainFailure,
  matchesPattern,
  ownerApprovalForHead,
} from "../.github/scripts/risk-paths.mjs";
import { REPO_ROOT } from "./ci-package.ts";

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
  test("the approval label counts only when the owner applied it last", () => {
    const external = pullRequest({
      user: { login: "someone-else", type: "User" },
      labels: [{ name: AUTOMERGE_LABEL }],
    });
    const byOwner = [
      { event: "labeled", label: { name: AUTOMERGE_LABEL }, actor: { login: OWNER } },
    ];
    const byStranger = [
      { event: "labeled", label: { name: AUTOMERGE_LABEL }, actor: { login: "someone-else" } },
    ];
    const removedAgain = [
      ...byOwner,
      { event: "unlabeled", label: { name: AUTOMERGE_LABEL }, actor: { login: OWNER } },
    ];
    expect(
      evaluateAutomerge({ pullRequest: external, ownerLogin: OWNER, labelEvents: byOwner })
        .eligible,
    ).toBe(true);
    expect(
      evaluateAutomerge({ pullRequest: external, ownerLogin: OWNER, labelEvents: byStranger })
        .eligible,
    ).toBe(false);
    expect(labelApprovedByOwner(removedAgain, { label: AUTOMERGE_LABEL, ownerLogin: OWNER })).toBe(
      false,
    );
    expect(labelApprovedByOwner(byOwner, { label: "other-label", ownerLogin: OWNER })).toBe(false);
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
      "services/collector-moneyforward/src/index.ts",
      ".github/workflows/ci.yml",
      ".github/scripts/automerge.mjs",
      "services/observation-pipeline/wrangler.ops.jsonc",
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
        "poc/observation-pipeline/web/src/App.tsx",
        "services/evidence-browser/src/routes.ts",
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

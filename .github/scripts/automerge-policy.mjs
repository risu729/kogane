// Trusted auto-merge policy. Pure decision functions only: no network, no
// process state, no shell. Every value handed in here comes from the GitHub
// API and is treated as data (G5-08); nothing is ever interpolated into a
// command line.

import { ownerApprovalForHead } from "./risk-paths.mjs";

/** Label an owner applies to let an otherwise untrusted pull request auto-merge. */
export const AUTOMERGE_LABEL = "automerge-approved";

/** Renovate's bot login. Verified together with the account type. */
export const RENOVATE_LOGIN = "renovate[bot]";

/**
 * Decide whether the automerge label is currently in force, i.e. whether the
 * repository owner is the actor who last applied it. The labels array alone
 * cannot answer this: anyone with triage rights can add a label, so the issue
 * event log has to say who did.
 *
 * @param {readonly {event?: string, actor?: {login?: string} | null, label?: {name?: string} | null}[]} events
 * @param {{label: string, ownerLogin: string}} options
 * @returns {boolean}
 */
export function labelApprovedByOwner(events, { label, ownerLogin }) {
  let approved = false;
  for (const event of events) {
    if (event.label?.name !== label) continue;
    if (event.event === "labeled") approved = event.actor?.login === ownerLogin;
    if (event.event === "unlabeled") approved = false;
  }
  return approved;
}

/**
 * Names of the labels currently on the pull request.
 *
 * @param {{labels?: readonly ({name?: string} | string)[] | null}} pullRequest
 * @returns {string[]}
 */
export function labelNames(pullRequest) {
  return (pullRequest.labels ?? []).flatMap((label) => {
    if (typeof label === "string") return [label];
    return label.name ? [label.name] : [];
  });
}

/**
 * Which trusted principal, if any, authored the pull request.
 *
 * @param {{user?: {login?: string, type?: string} | null}} pullRequest
 * @param {{ownerLogin: string}} options
 * @returns {"owner" | "renovate" | undefined}
 */
export function trustedAuthor(pullRequest, { ownerLogin }) {
  const login = pullRequest.user?.login;
  if (!login) return undefined;
  if (login === ownerLogin) return "owner";
  // zizmor bot-conditions: never trust a display name alone; the account type
  // comes from the same freshly fetched pull request object.
  if (login === RENOVATE_LOGIN && pullRequest.user?.type === "Bot") return "renovate";
  return undefined;
}

/**
 * The auto-merge decision for one pull request.
 *
 * A pull request by an untrusted author is eligible only through the label
 * path, and that path binds the permission to the exact head commit: the
 * label must have been applied by the owner *and* the owner must have an
 * APPROVED review whose commit_id is the current head. The label alone would
 * carry over to whatever the author pushes next (G5-05 for auto-merge; plan
 * 10 §6, "a label must not reuse an old head's approval for new code").
 *
 * @param {object} options
 * @param {Record<string, any>} options.pullRequest Freshly fetched pull request.
 * @param {string} options.ownerLogin Repository owner login.
 * @param {readonly object[]} [options.labelEvents] `issues/{n}/events` entries.
 * @param {readonly object[]} [options.reviews] `pulls/{n}/reviews` entries.
 * @param {string} [options.label] Manual approval label.
 * @returns {{eligible: boolean, reason: string, trustedBy?: string, shouldUpdateBranch: boolean}}
 */
export function evaluateAutomerge({
  pullRequest,
  ownerLogin,
  labelEvents = [],
  reviews = [],
  label = AUTOMERGE_LABEL,
}) {
  const mergeableState = pullRequest["mergeable_state"];
  const shouldUpdateBranch = mergeableState === "behind";
  const reject = (reason) => ({ eligible: false, reason, shouldUpdateBranch: false });

  if (pullRequest["state"] !== "open") return reject("the pull request is not open");
  if (pullRequest["merged"] === true) return reject("the pull request is already merged");
  if (pullRequest["draft"] === true) return reject("the pull request is a draft");

  let trustedBy = trustedAuthor(pullRequest, { ownerLogin });
  if (!trustedBy) {
    if (
      !labelNames(pullRequest).includes(label) ||
      !labelApprovedByOwner(labelEvents, { label, ownerLogin })
    ) {
      return reject(`the author is not a trusted principal and ${label} was not set by the owner`);
    }
    const headSha = String(pullRequest["head"]?.sha ?? "");
    const approval = ownerApprovalForHead(reviews, { ownerLogin, headSha });
    if (!approval.approved) {
      return reject(`${label} is set by the owner but ${approval.reason}`);
    }
    trustedBy = "label";
  }

  // `dirty` is the only state that means the merge can never succeed as-is.
  // `blocked`, `unstable` and `unknown` are left to native auto-merge and the
  // branch ruleset, which is what keeps the ruleset in charge of the decision.
  if (mergeableState === "dirty") return reject("the pull request has merge conflicts");

  return {
    eligible: true,
    reason: `trusted by ${trustedBy}`,
    trustedBy,
    shouldUpdateBranch,
  };
}

/**
 * Whether native auto-merge is currently armed on the pull request by the
 * automation app itself. Only what the app armed may the app disarm: an
 * auto-merge the owner enabled by hand is the owner's decision.
 *
 * @param {{auto_merge?: {enabled_by?: {login?: string} | null} | null}} pullRequest
 * @param {{appLogin: string | undefined}} options
 * @returns {boolean}
 */
export function armedByApp(pullRequest, { appLogin }) {
  const enabledBy = pullRequest.auto_merge?.enabled_by?.login;
  return Boolean(appLogin) && Boolean(enabledBy) && enabledBy === appLogin;
}

/**
 * The bot login of a GitHub App, as it appears in `enabled_by`, `actor` and
 * `user` fields.
 *
 * @param {string | undefined} slug `app-slug` output of create-github-app-token.
 * @returns {string | undefined}
 */
export function appBotLogin(slug) {
  return slug ? `${slug}[bot]` : undefined;
}

/**
 * Choose the one pull request to update after `main` moved. With the ruleset's
 * "require branches to be up to date" on, every armed pull request falls
 * behind at once; updating them all would run CI on each and only the first
 * to finish could merge, so this updates the oldest eligible one and lets the
 * next push to `main` pick up the next (a one-at-a-time merge queue, plan 10
 * §4). Candidates must already be in creation order.
 *
 * @param {readonly {number: number, armed: boolean, decision: {eligible: boolean, shouldUpdateBranch: boolean}}[]} candidates
 * @returns {number | undefined}
 */
export function pickBranchUpdate(candidates) {
  const chosen = candidates.find(
    (candidate) =>
      candidate.armed && candidate.decision.eligible && candidate.decision.shouldUpdateBranch,
  );
  return chosen?.number;
}

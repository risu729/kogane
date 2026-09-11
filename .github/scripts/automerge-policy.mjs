// Trusted auto-merge policy. Pure decision functions only: no network, no
// process state, no shell. Every value handed in here comes from the GitHub
// API and is treated as data (G5-08); nothing is ever interpolated into a
// command line.

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
 * @param {object} options
 * @param {Record<string, unknown>} options.pullRequest Freshly fetched pull request.
 * @param {string} options.ownerLogin Repository owner login.
 * @param {readonly object[]} [options.labelEvents] `issues/{n}/events` entries.
 * @param {string} [options.label] Manual approval label.
 * @returns {{eligible: boolean, reason: string, trustedBy?: string, shouldUpdateBranch: boolean}}
 */
export function evaluateAutomerge({
  pullRequest,
  ownerLogin,
  labelEvents = [],
  label = AUTOMERGE_LABEL,
}) {
  const mergeableState = pullRequest["mergeable_state"];
  const shouldUpdateBranch = mergeableState === "behind";
  const reject = (reason) => ({ eligible: false, reason, shouldUpdateBranch: false });

  if (pullRequest["state"] !== "open") return reject("the pull request is not open");
  if (pullRequest["merged"] === true) return reject("the pull request is already merged");
  if (pullRequest["draft"] === true) return reject("the pull request is a draft");

  let trustedBy = trustedAuthor(pullRequest, { ownerLogin });
  if (
    !trustedBy &&
    labelNames(pullRequest).includes(label) &&
    labelApprovedByOwner(labelEvents, { label, ownerLogin })
  ) {
    trustedBy = "label";
  }
  if (!trustedBy)
    return reject(`the author is not a trusted principal and ${label} was not set by the owner`);

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

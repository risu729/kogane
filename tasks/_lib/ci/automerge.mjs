// Privileged auto-merge handler (U13, acceptance G5-01..G5-08).
//
// Runs from a checkout of the repository default branch, never from pull
// request code, and only ever reads pull request metadata through the API.
// Pull request titles, bodies, branch names and labels are data: they are
// passed as values into this process and are never interpolated into a shell
// command (G5-08).
//
// Two modes, chosen by the environment the workflow passes:
// - PR_NUMBER set (pull_request_target): decide for that
//   one pull request, arm or disarm native auto-merge, update it when behind.
// - PR_NUMBER empty (push to main): every armed pull request is now behind the
//   ruleset's up-to-date requirement; update the oldest eligible one so CI
//   re-runs on the new base before it merges (G5-02), one at a time.
//
// The decision itself lives in automerge-policy.mjs so it can be unit tested.

import { appendFileSync } from "node:fs";
import { clientFromEnv, graphql, paginate, request, requireEnv } from "./github-api.mjs";
import {
  AUTOMERGE_LABEL,
  appBotLogin,
  armedByApp,
  evaluateAutomerge,
  labelNames,
  pickBranchUpdate,
} from "./automerge-policy.mjs";

const ENABLE_AUTO_MERGE = `
  mutation EnableAutoMerge($pullRequestId: ID!) {
    enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
      pullRequest { number }
    }
  }
`;

const DISABLE_AUTO_MERGE = `
  mutation DisableAutoMerge($pullRequestId: ID!) {
    disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
      pullRequest { number }
    }
  }
`;

/**
 * @param {string} message
 */
function report(message) {
  console.log(message);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `${message}\n`);
}

/**
 * @typedef {{apiUrl: string, graphqlUrl: string, owner: string, repo: string, token: string}} Client
 */

/**
 * GitHub computes `mergeable`/`mergeable_state` asynchronously. Poll briefly so
 * a freshly pushed head is not classified from a stale background computation.
 *
 * @param {Client} client
 * @param {number} number
 * @returns {Promise<any>}
 */
async function fetchPullRequest(client, number) {
  const url = `${client.apiUrl}/repos/${client.owner}/${client.repo}/pulls/${String(number)}`;
  let pullRequest;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(url, { token: client.token });
    pullRequest = response.data;
    if (pullRequest?.["mergeable"] !== null || pullRequest?.["state"] !== "open") break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!pullRequest) throw new Error(`Pull request #${String(number)} could not be read`);
  return pullRequest;
}

/**
 * Evaluate one freshly fetched pull request, reading the label event log
 * only when the label path is the one that could apply.
 *
 * @param {Client} client
 * @param {any} pullRequest
 * @param {{ownerLogin: string, label: string}} options
 */
async function decide(client, pullRequest, { ownerLogin, label }) {
  const base = `${client.apiUrl}/repos/${client.owner}/${client.repo}`;
  const number = String(pullRequest["number"]);
  const labelled = labelNames(pullRequest).includes(label);
  const labelEvents = labelled
    ? await paginate(`${base}/issues/${number}/events?per_page=100`, { token: client.token })
    : [];
  return evaluateAutomerge({ pullRequest, ownerLogin, labelEvents, label });
}

/**
 * @param {Client} client
 * @param {any} pullRequest
 * @returns {Promise<void>}
 */
async function updateBranch(client, pullRequest) {
  const number = String(pullRequest["number"]);
  const updated = await request(
    `${client.apiUrl}/repos/${client.owner}/${client.repo}/pulls/${number}/update-branch`,
    {
      token: client.token,
      method: "PUT",
      body: { expected_head_sha: String(pullRequest["head"]?.sha) },
      // 403: the head lives in a fork the app is not installed on. 409/422:
      // the head moved or the update conflicts. All are left to a human.
      allowStatuses: [403, 409, 422],
    },
  );
  report(
    updated.status === 202
      ? `Updated #${number} from the base; the app token restarts CI on the new head.`
      : `#${number} was not updated (${String(updated.status)}): a fork branch, a moved head, or a conflict.`,
  );
}

/**
 * @param {Client} client
 * @param {number} number
 * @param {{ownerLogin: string, label: string, appLogin: string | undefined}} options
 */
async function handleOne(client, number, { ownerLogin, label, appLogin }) {
  const base = `${client.apiUrl}/repos/${client.owner}/${client.repo}`;
  const pullRequest = await fetchPullRequest(client, number);
  const decision = await decide(client, pullRequest, { ownerLogin, label });
  report(
    `Pull request #${String(number)} by ${String(pullRequest["user"]?.login)} ` +
      `(state ${String(pullRequest["state"])}, mergeable_state ${String(pullRequest["mergeable_state"])}): ` +
      `${decision.eligible ? "eligible" : "not eligible"} — ${decision.reason}`,
  );

  if (!decision.eligible) {
    // Withdrawn eligibility (for example, a removed label or a draft) also
    // disarms what this app armed earlier. GitHub enforces required reviews.
    if (pullRequest["state"] === "open" && armedByApp(pullRequest, { appLogin })) {
      await graphql(client.graphqlUrl, {
        token: client.token,
        query: DISABLE_AUTO_MERGE,
        variables: { pullRequestId: String(pullRequest["node_id"]) },
      });
      report(
        "Disabled native auto-merge: the automation app had armed it and the permission is gone.",
      );
    }
    return;
  }

  if (pullRequest["auto_merge"]) {
    report("Native auto-merge is already enabled.");
  } else {
    try {
      await graphql(client.graphqlUrl, {
        token: client.token,
        query: ENABLE_AUTO_MERGE,
        variables: { pullRequestId: String(pullRequest["node_id"]) },
      });
      report("Enabled native auto-merge (squash).");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // GitHub refuses to arm auto-merge once every requirement is already
      // satisfied. Merge through the same API instead; the ruleset still
      // decides, because this app has no bypass, and `sha` pins the merge to
      // the head this run evaluated.
      if (!/clean status/iu.test(message)) throw error;
      const merge = await request(`${base}/pulls/${String(number)}/merge`, {
        token: client.token,
        method: "PUT",
        body: { merge_method: "squash", sha: String(pullRequest["head"]?.sha) },
        allowStatuses: [405, 409],
      });
      report(
        merge.status === 200
          ? "Merged directly: every requirement was already satisfied."
          : `The ruleset refused the direct merge (${String(merge.status)}); leaving the pull request open.`,
      );
      return;
    }
  }

  if (decision.shouldUpdateBranch) await updateBranch(client, pullRequest);
}

/**
 * After a push to main: update the oldest armed, eligible pull request that
 * is behind. The next push (its merge) brings the next one forward.
 *
 * @param {Client} client
 * @param {{ownerLogin: string, label: string}} options
 */
async function sweep(client, { ownerLogin, label }) {
  const base = `${client.apiUrl}/repos/${client.owner}/${client.repo}`;
  const open = await paginate(`${base}/pulls?state=open&sort=created&direction=asc&per_page=100`, {
    token: client.token,
    limit: 5,
  });
  const candidates = [];
  for (const summary of open) {
    // The list endpoint carries neither mergeable_state nor a settled
    // auto_merge; only armed pull requests are worth the per-item read.
    if (!summary?.["auto_merge"]) continue;
    const pullRequest = await fetchPullRequest(client, Number(summary["number"]));
    const decision = await decide(client, pullRequest, { ownerLogin, label });
    candidates.push({
      number: Number(pullRequest["number"]),
      armed: Boolean(pullRequest["auto_merge"]),
      decision,
      pullRequest,
    });
  }
  const chosen = pickBranchUpdate(candidates);
  report(
    `Sweep after a push to the base: ${String(open.length)} open, ${String(candidates.length)} armed, ` +
      (chosen === undefined ? "none behind and eligible." : `updating #${String(chosen)}.`),
  );
  const candidate = candidates.find((entry) => entry.number === chosen);
  if (candidate) await updateBranch(client, candidate.pullRequest);
}

async function main() {
  const client = clientFromEnv(process.env);
  const ownerLogin = process.env["REPOSITORY_OWNER"] ?? client.owner;
  const label = process.env["AUTOMERGE_LABEL"] ?? AUTOMERGE_LABEL;
  const appLogin = appBotLogin(process.env["AUTOMATION_APP_SLUG"]);
  const rawNumber = process.env["PR_NUMBER"];

  if (!rawNumber) {
    if (process.env["GITHUB_EVENT_NAME"] !== "push") {
      throw new Error(`PR_NUMBER is required for ${requireEnv(process.env, "GITHUB_EVENT_NAME")}`);
    }
    await sweep(client, { ownerLogin, label });
    return;
  }
  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("PR_NUMBER must be a number");
  await handleOne(client, number, { ownerLogin, label, appLogin });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Auto-merge handler failed");
  process.exitCode = 1;
}

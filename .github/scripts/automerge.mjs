// Privileged auto-merge handler (U13, acceptance G5-01..G5-08).
//
// Runs from a checkout of the repository default branch, never from pull
// request code, and only ever reads pull request metadata through the API.
// Pull request titles, bodies, branch names and labels are data: they are
// passed as values into this process and are never interpolated into a shell
// command (G5-08).
//
// The decision itself lives in automerge-policy.mjs so it can be unit tested.

import { appendFileSync } from "node:fs";
import { clientFromEnv, graphql, paginate, request, requireEnv } from "./github-api.mjs";
import { AUTOMERGE_LABEL, evaluateAutomerge, labelNames } from "./automerge-policy.mjs";

const ENABLE_AUTO_MERGE = `
  mutation EnableAutoMerge($pullRequestId: ID!) {
    enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
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
 * GitHub computes `mergeable`/`mergeable_state` asynchronously. Poll briefly so
 * a freshly pushed head is not classified from a stale background computation.
 *
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
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
  return pullRequest;
}

async function main() {
  const client = clientFromEnv(process.env);
  const number = Number.parseInt(requireEnv(process.env, "PR_NUMBER"), 10);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("PR_NUMBER must be a number");
  const ownerLogin = process.env["REPOSITORY_OWNER"] ?? client.owner;
  const label = process.env["AUTOMERGE_LABEL"] ?? AUTOMERGE_LABEL;
  const base = `${client.apiUrl}/repos/${client.owner}/${client.repo}`;

  const pullRequest = await fetchPullRequest(client, number);
  if (!pullRequest) throw new Error("The pull request could not be read");

  // Only the label path needs the event log, and only to learn who applied it.
  const labelEvents = labelNames(pullRequest).includes(label)
    ? await paginate(`${base}/issues/${String(number)}/events?per_page=100`, {
        token: client.token,
      })
    : [];

  const decision = evaluateAutomerge({ pullRequest, ownerLogin, labelEvents, label });
  report(
    `Pull request #${String(number)} by ${String(pullRequest["user"]?.login)} ` +
      `(state ${String(pullRequest["state"])}, mergeable_state ${String(pullRequest["mergeable_state"])}): ` +
      `${decision.eligible ? "eligible" : "not eligible"} — ${decision.reason}`,
  );
  if (!decision.eligible) return;

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
      // decides, because this app has no bypass.
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

  if (decision.shouldUpdateBranch) {
    const updated = await request(`${base}/pulls/${String(number)}/update-branch`, {
      token: client.token,
      method: "PUT",
      body: { expected_head_sha: String(pullRequest["head"]?.sha) },
      allowStatuses: [409, 422],
    });
    report(
      updated.status === 202
        ? "Updated the branch from the base; the app token restarts CI on the new head."
        : `The branch was not updated (${String(updated.status)}); the head moved or the update conflicts.`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Auto-merge handler failed");
  process.exitCode = 1;
}

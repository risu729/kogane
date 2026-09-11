// Risk Gate check (U13, acceptance G5-05).
//
// Runs on `pull_request` with a read-only token and a checkout of the base ref
// only: pull request code is never checked out and never executed. The changed
// file list comes from the REST compare API, the classification from
// infra/risk-paths.json, and the approval from the review list — a review is
// only decisive when its commit_id is the current head.

import { appendFileSync, readFileSync } from "node:fs";
import { clientFromEnv, paginate, request, requireEnv } from "./github-api.mjs";
import { assessRisk, changedPaths, explainFailure, ownerApprovalForHead } from "./risk-paths.mjs";

// The compare API returns at most 300 entries in `files`; beyond that the gate
// must fail closed instead of classifying a partial list.
const COMPARE_FILE_LIMIT = 300;

/**
 * @param {string} message
 */
function report(message) {
  console.log(message);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `${message}\n`);
}

/**
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
 * @param {{baseSha: string, headSha: string, number: number}} pullRequest
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
async function changedFiles(client, { baseSha, headSha, number }) {
  const base = `${client.apiUrl}/repos/${client.owner}/${client.repo}`;
  const compare = await request(`${base}/compare/${baseSha}...${headSha}?per_page=100`, {
    token: client.token,
    allowStatuses: [404, 422],
  });
  const compared = compare.status === 200 ? (compare.data?.files ?? []) : undefined;
  if (compared) {
    return {
      files: changedPaths(compared),
      truncated: compared.length >= COMPARE_FILE_LIMIT,
    };
  }
  // Forks and force-pushed heads can leave the compare endpoint without a
  // merge base; the pull request file list is then the authoritative source.
  const files = await paginate(`${base}/pulls/${String(number)}/files?per_page=100`, {
    token: client.token,
    limit: 30,
  });
  return {
    files: changedPaths(files),
    truncated: false,
  };
}

async function main() {
  const client = clientFromEnv(process.env);
  const number = Number.parseInt(requireEnv(process.env, "PR_NUMBER"), 10);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("PR_NUMBER must be a number");
  const headSha = requireEnv(process.env, "HEAD_SHA");
  const baseSha = requireEnv(process.env, "BASE_SHA");
  const ownerLogin = process.env["REPOSITORY_OWNER"] ?? client.owner;
  const ledgerPath = process.env["RISK_PATHS"] ?? "infra/risk-paths.json";
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const base = `${client.apiUrl}/repos/${client.owner}/${client.repo}`;

  const fresh = await request(`${base}/pulls/${String(number)}`, { token: client.token });
  if (String(fresh.data?.head?.sha) !== headSha) {
    // A newer head exists, so its own Risk Gate run decides. Never let this run
    // report success for a commit it did not classify.
    throw new Error(`The head moved to ${String(fresh.data?.head?.sha)}; this run is stale`);
  }
  const labels = (fresh.data?.labels ?? []).map((label) => String(label.name));

  const { files, truncated } = await changedFiles(client, { baseSha, headSha, number });
  const assessment = assessRisk({ changedFiles: files, labels, ledger, truncated });
  report(`Risk Gate: ${String(files.length)} changed files, risk ${assessment.level}.`);

  if (assessment.level === "low") {
    report("No high-risk path or label changed; no owner approval is required.");
    return;
  }

  const reviews = await paginate(`${base}/pulls/${String(number)}/reviews?per_page=100`, {
    token: client.token,
  });
  const approval = ownerApprovalForHead(reviews, { ownerLogin, headSha });
  if (approval.approved) {
    report(`High-risk change ${approval.reason}.`);
    for (const match of assessment.paths) report(`- ${match.path} [${match.rule}]`);
    for (const match of assessment.labels) report(`- label ${match.label} [${match.rule}]`);
    return;
  }

  report(explainFailure(assessment, { ownerLogin, headSha, approvalReason: approval.reason }));
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Risk Gate failed");
  process.exitCode = 1;
}

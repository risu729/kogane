// The production release ledger, kept in the GitHub Deployments API.
//
// CD must never let a late run overwrite a newer release (unified plan 11 §3,
// acceptance G5-12). GitHub's `concurrency` alone cannot promise that: only one
// run may be *pending* in a group, so with rapid merges an intermediate run is
// cancelled and a run that started earlier can reach the deploy steps after a
// newer one already finished. The interlock therefore has to be a record that
// outlives the run, and it has to be one every actor can read and write without
// pushing a commit — a committed ledger would need a signed push, and the
// Actions cache is evictable. `deployments: write` on `GITHUB_TOKEN` gives
// exactly that, and the deployment payload carries the release record so the
// next run can compare schema state without downloading an artefact.
//
// Decisions are made by `decideRelease`, a pure function over two commit shas
// and an ancestry predicate, so the ordering rules are unit-tested against a
// real git history instead of a live deployment.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { clientFromEnv, request } from "./github-api.mjs";
import { fileURLToPath } from "node:url";

/** The GitHub Environment this repository releases into. There is no other. */
export const ENVIRONMENT = "production";

/**
 * Whether `candidate` is an ancestor of (or identical to) `descendant`.
 *
 * @param {string} candidate
 * @param {string} descendant
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function gitIsAncestor(candidate, descendant, cwd = process.cwd()) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidate, descendant], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    // git answers 1 for "not an ancestor" and anything else for a real failure
    // (an unknown commit, a broken repository). Only the first is an answer.
    if (error?.status === 1) return false;
    throw new Error(`git merge-base --is-ancestor ${candidate} ${descendant} failed`, {
      cause: error,
    });
  }
}

/**
 * What a run may do given the commit it wants to release and the commit the
 * ledger records as live.
 *
 * `proceed: false` without `fail` is the "older run, nothing to do" outcome:
 * the run ends successfully and deploys nothing, which is what makes an
 * overtaken run harmless rather than destructive.
 *
 * @param {{mode: "release" | "rollback", head: string, recorded: string | null, isAncestor: (a: string, b: string) => boolean}} input
 * @returns {{proceed: boolean, fail: boolean, reason: string}}
 */
export function decideRelease({ mode, head, recorded, isAncestor }) {
  if (mode === "rollback") {
    if (recorded === null) {
      return {
        proceed: false,
        fail: true,
        reason:
          "no successful production release is recorded, so there is nothing to roll back from",
      };
    }
    if (recorded === head) {
      return { proceed: false, fail: true, reason: `${head} is already the recorded release` };
    }
    if (isAncestor(head, recorded)) {
      return {
        proceed: true,
        fail: false,
        reason: `${head} is an ancestor of the recorded release ${recorded}`,
      };
    }
    return {
      proceed: false,
      fail: true,
      reason: `${head} is not an ancestor of the recorded release ${recorded}; a roll forward goes through the deploy workflow`,
    };
  }
  if (recorded === null) {
    return { proceed: true, fail: false, reason: "no production release is recorded yet" };
  }
  if (recorded === head) {
    return {
      proceed: false,
      fail: false,
      reason: `${head} is already the recorded release; nothing to do`,
    };
  }
  if (isAncestor(head, recorded)) {
    return {
      proceed: false,
      fail: false,
      reason: `a newer release (${recorded}) is already recorded; this run is older and changes nothing`,
    };
  }
  if (isAncestor(recorded, head)) {
    return { proceed: true, fail: false, reason: `moves the release forward from ${recorded}` };
  }
  return {
    proceed: false,
    fail: true,
    reason: `${head} and the recorded release ${recorded} have diverged; main is expected to be linear`,
  };
}

/**
 * The newest deployment of the production environment whose latest status is
 * `success`, with the release record it carried.
 *
 * Fails closed: a deployment list that cannot be read, or that goes on past
 * the page read here without a successful deployment in it, is an error, never
 * an empty ledger, because an empty ledger means "deploy anything".
 *
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
 * @param {{fetchImpl?: typeof fetch, limit?: number}} [options]
 * @returns {Promise<{sha: string, id: number, record: unknown} | null>}
 */
export async function latestRelease(client, { fetchImpl, limit = 100 } = {}) {
  const { apiUrl, owner, repo, token } = client;
  const listed = await request(
    `${apiUrl}/repos/${owner}/${repo}/deployments?environment=${ENVIRONMENT}&per_page=${String(limit)}`,
    { token, fetchImpl },
  );
  if (!Array.isArray(listed.data)) throw new Error("the deployment list did not return a list");
  const deployments = [...listed.data].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  for (const deployment of deployments) {
    const statuses = await request(
      `${apiUrl}/repos/${owner}/${repo}/deployments/${String(deployment.id)}/statuses?per_page=100`,
      { token, fetchImpl },
    );
    if (!Array.isArray(statuses.data)) throw new Error("the status list did not return a list");
    const latest = [...statuses.data].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    )[0];
    if (latest?.state === "success") {
      return {
        sha: String(deployment.sha),
        id: Number(deployment.id),
        record: deployment.payload ?? null,
      };
    }
  }
  if (listed.next !== undefined) {
    throw new Error(
      `none of the newest ${String(deployments.length)} production deployments succeeded and the list goes on; refusing to treat the ledger as empty`,
    );
  }
  return null;
}

/**
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
 * @param {{sha: string, record: unknown, description: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<number>}
 */
export async function createDeployment(client, { sha, record, description, fetchImpl }) {
  const { apiUrl, owner, repo, token } = client;
  const created = await request(`${apiUrl}/repos/${owner}/${repo}/deployments`, {
    token,
    method: "POST",
    fetchImpl,
    body: {
      ref: sha,
      environment: ENVIRONMENT,
      // Without this the API merges the default branch into the ref and can
      // answer with a merge result instead of a deployment.
      auto_merge: false,
      // CI already decided; re-checking contexts here would race with it.
      required_contexts: [],
      production_environment: true,
      transient_environment: false,
      description,
      payload: record,
    },
  });
  const id = Number(created.data?.id);
  if (!Number.isSafeInteger(id)) throw new Error("the deployment was not created");
  return id;
}

/**
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
 * @param {{id: number, state: string, description: string, logUrl?: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<void>}
 */
export async function setDeploymentStatus(client, { id, state, description, logUrl, fetchImpl }) {
  const { apiUrl, owner, repo, token } = client;
  await request(`${apiUrl}/repos/${owner}/${repo}/deployments/${String(id)}/statuses`, {
    token,
    method: "POST",
    fetchImpl,
    body: {
      state,
      description: description.slice(0, 140),
      ...(logUrl === undefined ? {} : { log_url: logUrl }),
    },
  });
}

/**
 * @param {Record<string, string>} outputs
 * @param {Record<string, string | undefined>} env
 */
function writeOutputs(outputs, env) {
  const file = env["GITHUB_OUTPUT"];
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (file) appendFileSync(file, text);
  else process.stdout.write(text);
}

/**
 * @param {string} line
 * @param {Record<string, string | undefined>} env
 */
function report(line, env) {
  console.log(line);
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${line}\n`);
}

/**
 * @param {readonly string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    options[argument.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }
  return options;
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>}
 */
export async function main(argv, env) {
  const [command] = argv;
  const options = parseArgs(argv.slice(1));
  // Only the ledger commands talk to the API. `decide` is a pure comparison of
  // two commits and must run without a token.
  if (command === "latest") {
    const release = await latestRelease(clientFromEnv(env));
    if (options["record"]) {
      writeFileSync(options["record"], `${JSON.stringify(release?.record ?? null, null, 2)}\n`);
    }
    writeOutputs(
      {
        found: String(release !== null),
        sha: release?.sha ?? "",
        "deployment-id": release === null ? "" : String(release.id),
      },
      env,
    );
    report(
      release === null
        ? "No successful production release is recorded yet."
        : `Recorded production release: ${release.sha} (deployment ${String(release.id)}).`,
      env,
    );
    return 0;
  }
  if (command === "decide") {
    const head = options["head"] ?? "";
    if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error("--head must be a full commit sha");
    const recordedInput = options["recorded"] ?? "";
    const recorded = recordedInput === "" ? null : recordedInput;
    if (recorded !== null && !/^[0-9a-f]{40}$/u.test(recorded)) {
      throw new Error("--recorded must be a full commit sha or empty");
    }
    const mode = options["mode"] === "rollback" ? "rollback" : "release";
    const decision = decideRelease({
      mode,
      head,
      recorded,
      isAncestor: (a, b) => gitIsAncestor(a, b, options["root"] ?? process.cwd()),
    });
    writeOutputs({ proceed: String(decision.proceed) }, env);
    report(`${decision.proceed ? "Proceeding" : "Not deploying"}: ${decision.reason}`, env);
    return decision.fail ? 1 : 0;
  }
  if (command === "create") {
    const record = JSON.parse(readFileSync(options["record"] ?? "release-record.json", "utf8"));
    const id = await createDeployment(clientFromEnv(env), {
      sha: options["sha"] ?? String(record.sha),
      record,
      description: options["description"] ?? "kogane production release",
    });
    await setDeploymentStatus(clientFromEnv(env), {
      id,
      state: "in_progress",
      description: options["description"] ?? "kogane production release",
      ...(options["log-url"] ? { logUrl: options["log-url"] } : {}),
    });
    writeOutputs({ "deployment-id": String(id) }, env);
    report(`Created deployment ${String(id)} for ${String(record.sha)}.`, env);
    return 0;
  }
  if (command === "status") {
    const id = Number(options["deployment"]);
    if (!Number.isSafeInteger(id)) throw new Error("--deployment must be a deployment id");
    await setDeploymentStatus(clientFromEnv(env), {
      id,
      state: options["state"] ?? "failure",
      description: options["description"] ?? "",
      ...(options["log-url"] ? { logUrl: options["log-url"] } : {}),
    });
    report(`Deployment ${String(id)} recorded as ${String(options["state"])}.`, env);
    return 0;
  }
  throw new Error(`Unknown command ${String(command)}`);
}

// Not `import.meta.main`: that is only defined from node 24.2, and the
// runner's preinstalled interpreter must not be able to turn a guard into a
// silent no-op.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release ledger failed");
    process.exitCode = 1;
  }
}

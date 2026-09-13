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
// The record is per-Worker. A partial release used to complete the whole sha in
// the ledger, so a later full release of the same commit was skipped as
// "nothing to do" and left the other Workers behind; and a failed release,
// which may have applied migrations and uploaded some Workers, must never be
// read as the environment's state. So the ledger records for every deployable
// Worker the commit it is at, and a run decides per Worker: it deploys the ones
// that are behind, keeps the ones that are already at this commit or at a newer
// one, and only reports "nothing to do" when nothing is left. That makes a
// re-run a resume rather than a skip (finding 2).
//
// Decisions are made by `decideRelease`, a pure function over two commit shas,
// the previous record and an ancestry predicate, so the ordering rules are
// unit-tested against a real git history instead of a live deployment.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** The first 12 characters of a sha, for a log line. */
function short(sha) {
  return sha.slice(0, 12);
}

/**
 * One release record in the shape the decisions use, whichever version wrote
 * it.
 *
 * A v1 record listed Cloudflare Worker names only (`workers: ["kogane-x"]`),
 * with no per-Worker commit: everything it names was deployed at the record's
 * own sha. A v2 record carries an entry per deployable Worker with the commit
 * that Worker is at. Both are read here so the first release after this change
 * still understands what is live.
 *
 * @param {unknown} record
 * @returns {{sha: string, mode: string, coreMigrations: string[], readMigrations: string[] | null, workers: {name: string | null, worker: string | null, sha: string, outcome: string}[]} | null}
 */
export function normalizeRecord(record) {
  if (record === null || typeof record !== "object") return null;
  const source = /** @type {Record<string, any>} */ (record);
  const sha = typeof source["sha"] === "string" ? source["sha"] : "";
  const listed = Array.isArray(source["workers"]) ? source["workers"] : [];
  return {
    sha,
    mode: typeof source["mode"] === "string" ? source["mode"] : "release",
    coreMigrations: Array.isArray(source["coreMigrations"]) ? source["coreMigrations"] : [],
    readMigrations: Array.isArray(source["readMigrations"]) ? source["readMigrations"] : null,
    workers: listed.map((entry) =>
      // "recorded", not "deployed": what a record says about a Worker is what
      // the run that wrote it intended. Only a `success` status turns that into
      // a statement about Cloudflare, and the record of a run that failed is
      // printed rather than believed.
      typeof entry === "string"
        ? { name: null, worker: entry, sha, outcome: "recorded" }
        : {
            name: typeof entry?.name === "string" ? entry.name : null,
            worker: typeof entry?.worker === "string" ? entry.worker : null,
            // A v2 entry carries its own commit, and an empty one means "not
            // recorded" (a Worker a rollback left alone without ever having
            // been released) — never the record's commit, or a re-run of that
            // commit would keep a Worker that nothing ever deployed.
            sha: typeof entry?.sha === "string" ? entry.sha : sha,
            outcome: typeof entry?.outcome === "string" ? entry.outcome : "recorded",
          },
    ),
  };
}

/**
 * Whether a deployment's payload is one of this repository's release records.
 *
 * It matters because not every `production` deployment is one. A job that
 * declares `environment: production` makes GitHub open a deployment of its own,
 * with an empty payload, and close it with the job's result — so a release job
 * that correctly decides it has nothing to do leaves behind a *successful*
 * production deployment that says nothing about what is deployed. Reading that
 * as the ledger would be the same class of mistake as reading a partial release
 * as a complete one (finding 2): the run before it would look superseded by a
 * record that names no Worker and no migration. Only a payload written by
 * `release-manifest.mjs` counts.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
export function isReleaseRecord(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const version = /** @type {Record<string, unknown>} */ (payload)["manifestVersion"];
  return typeof version === "string" && version.startsWith("release-manifest-");
}

/**
 * The commit each deployable Worker is at, according to a record.
 *
 * Only ever called with the record of a *successful* deployment. That record is
 * written before the uploads (the Deployments API fixes a payload at creation),
 * so its per-Worker `outcome` says "planned"; what makes it true is the
 * `success` status, which only a run whose every planned step succeeded posts.
 * A Worker the record does not name is not live at any commit, and a Worker the
 * record names but the ledger no longer deploys is ignored.
 *
 * @param {unknown} previous
 * @param {readonly {name: string, worker?: string}[]} deployable
 * @returns {Map<string, string>}
 */
export function recordedWorkerShas(previous, deployable) {
  const live = new Map();
  const record = normalizeRecord(previous);
  if (record === null) return live;
  for (const entry of record.workers) {
    const match = deployable.find(
      (worker) =>
        (entry.name !== null && worker.name === entry.name) ||
        (entry.worker !== null && worker.worker === entry.worker),
    );
    if (match === undefined || entry.sha === "") continue;
    live.set(match.name, entry.sha);
  }
  return live;
}

/**
 * What a run may do given the commit it wants to release and the commit the
 * ledger records as live.
 *
 * `proceed: false` without `fail` is the "nothing left to do" outcome: the run
 * ends successfully and deploys nothing, which is what makes an overtaken run
 * harmless rather than destructive. It is only reached when every deployable
 * Worker is recorded at this commit or at a newer one — a partial record makes
 * the run a resume instead (finding 2).
 *
 * A release never deploys a subset by request: `targets` belongs to the
 * rollback workflow, and the release path passes none.
 *
 * @param {{mode: "release" | "rollback", head: string, recorded: string | null, previous?: unknown, deployable?: readonly {name: string, worker?: string}[], targets?: readonly string[], isAncestor: (a: string, b: string) => boolean}} input
 * @returns {{proceed: boolean, fail: boolean, reason: string, selected: string[], kept: {name: string, sha: string}[], notes: string[]}}
 */
export function decideRelease({
  mode,
  head,
  recorded,
  previous = null,
  deployable = [],
  targets = [],
  isAncestor,
}) {
  const names = deployable.map((worker) => worker.name);
  const live = recordedWorkerShas(previous, deployable);
  const refuse = (reason) => ({
    proceed: false,
    fail: true,
    reason,
    selected: [],
    kept: [],
    notes: [],
  });
  const unknown = targets.filter((target) => !names.includes(target));
  if (unknown.length > 0) {
    return refuse(`${unknown.join(", ")} is not a Worker marked deploy in the deployment ledger`);
  }
  if (mode === "rollback") {
    if (recorded === null) {
      return refuse(
        "no successful production release is recorded, so there is nothing to roll back from",
      );
    }
    // A rollback is per target, in the decision as well as in the record. The
    // recorded release's own sha is the commit of the *last* successful run,
    // which after a rollback of one Worker is the older commit; judging every
    // target against it would refuse rolling a second Worker back to the same
    // place ("already the recorded release") or to a commit in between ("not
    // an ancestor"). So each target is judged against the commit the ledger
    // records for *it*: behind that commit → roll it back, at it → leave it,
    // ahead of it or unrecorded → refuse, because that would be a roll forward
    // to a Worker nothing accounts for, and a roll forward goes through the
    // deploy workflow. The Workers a rollback does not name keep the commit
    // the ledger records for them, and the record it writes says so.
    const requested = targets.length === 0 ? [...names] : [...targets];
    const selected = [];
    const kept = [];
    const notes = [];
    for (const name of requested) {
      const at = live.get(name);
      if (at === undefined) {
        return refuse(
          `${name} has no successfully recorded commit to roll back from; a release is what puts it there`,
        );
      }
      if (at === head) {
        kept.push({ name, sha: at });
        notes.push(`${name}: already at ${short(head)}`);
        continue;
      }
      if (!isAncestor(head, at)) {
        return refuse(
          `${head} is not an ancestor of ${short(at)}, the commit ${name} is recorded at; a roll forward goes through the deploy workflow`,
        );
      }
      selected.push(name);
      notes.push(`${name}: recorded at ${short(at)}, rolling back to ${short(head)}`);
    }
    for (const name of names) {
      if (requested.includes(name)) continue;
      const at = live.get(name) ?? "";
      kept.push({ name, sha: at });
      notes.push(`${name}: left at ${short(at) || "an unrecorded commit"}`);
    }
    return {
      proceed: selected.length > 0,
      fail: false,
      reason:
        selected.length === 0
          ? `every requested Worker is already recorded at ${head}; nothing to do`
          : `rolling back ${selected.length === names.length ? "every Worker" : selected.join(", ")} to ${head}`,
      selected,
      kept,
      notes,
    };
  }
  if (targets.length > 0) {
    return refuse(
      "a release deploys every Worker marked deploy in the deployment ledger; a subset is a rollback",
    );
  }
  if (recorded === null) {
    return {
      proceed: names.length > 0,
      fail: false,
      reason: "no production release is recorded yet",
      selected: [...names],
      kept: [],
      notes: names.map((name) => `${name}: no successful deployment is recorded`),
    };
  }
  if (recorded !== head && !isAncestor(recorded, head) && !isAncestor(head, recorded)) {
    return refuse(
      `${head} and the recorded release ${recorded} have diverged; main is expected to be linear`,
    );
  }
  const selected = [];
  const kept = [];
  const notes = [];
  for (const name of names) {
    const at = live.get(name);
    if (at === undefined) {
      selected.push(name);
      notes.push(`${name}: no successful deployment is recorded`);
      continue;
    }
    if (at === head) {
      kept.push({ name, sha: at });
      notes.push(`${name}: already at ${short(head)}`);
      continue;
    }
    // Never backwards: a Worker the ledger records at a descendant of this
    // commit belongs to a newer release, and this run leaves it alone.
    if (isAncestor(head, at)) {
      kept.push({ name, sha: at });
      notes.push(`${name}: at the newer ${short(at)}, left alone`);
      continue;
    }
    selected.push(name);
    notes.push(`${name}: recorded at ${short(at)}, deploying ${short(head)}`);
  }
  if (selected.length === 0) {
    return {
      proceed: false,
      fail: false,
      reason:
        recorded !== head && isAncestor(head, recorded)
          ? `a newer release (${recorded}) is already recorded and covers every deployable Worker; this run is older and changes nothing`
          : `every deployable Worker is already recorded at ${head}; nothing to do`,
      selected,
      kept,
      notes,
    };
  }
  return {
    proceed: true,
    fail: false,
    reason: `deploying ${String(selected.length)} of ${String(names.length)} Workers at ${head}: ${selected.join(", ")}`,
    selected,
    kept,
    notes,
  };
}

/**
 * What a run actually did, read from the outcome of its own steps.
 *
 * The Deployments API fixes a deployment's payload when the deployment is
 * created, which is before the first upload, so the payload is the *plan*. This
 * is the other half: the deploy step of each selected Worker is `deploy-<name>`
 * and the migration steps are `migrate-core` and `migrate-read`, so the
 * `steps` context of the job says, per Worker, whether the upload ran, was
 * skipped, failed, or was never reached because something before it failed.
 * A failed release therefore leaves behind a readable account of what may have
 * been applied, which is what the next run prints (finding 2).
 *
 * @param {Record<string, any>} record
 * @param {Record<string, any>} steps
 * @returns {Record<string, unknown>}
 */
export function releaseProgress(record, steps = {}) {
  const outcomeOf = (id) => {
    const step = steps?.[id];
    // Actions records a step whose condition was not met as `skipped`, so a
    // planned upload that never ran because an earlier step failed shows as
    // `skipped` here; `not reached` is only an id the context does not carry.
    if (step === undefined || step === null) return "not reached";
    const outcome = String(step.outcome ?? step.conclusion ?? "unknown");
    return outcome === "success" ? "done" : outcome;
  };
  const deployOutcome = (id) => {
    const outcome = outcomeOf(id);
    if (outcome === "done") return "deployed";
    if (outcome === "failure") return "failed";
    return outcome;
  };
  const workers = normalizeRecord(record)?.workers ?? [];
  const reported = workers.map((entry) => {
    if (entry.name === null) return { ...entry, targets: "" };
    if (entry.outcome === "kept") return { ...entry, targets: "" };
    const id = `deploy-${entry.name}`;
    return {
      ...entry,
      outcome: deployOutcome(id),
      targets: String(steps?.[id]?.outputs?.["deployment-targets"] ?? ""),
    };
  });
  const planned = reported.filter((entry) => entry.outcome !== "kept");
  const deployed = planned.filter((entry) => entry.outcome === "deployed");
  const failed = planned.filter((entry) => entry.outcome === "failed");
  const core = outcomeOf("migrate-core");
  const read = record.readMigrations === null ? null : outcomeOf("migrate-read");
  return {
    progressVersion: "release-progress-v1",
    sha: record.sha ?? "",
    mode: record.mode ?? "release",
    runId: record.runId ?? "",
    runUrl: record.runUrl ?? "",
    migrations: {
      core: { database: record.coreDatabase ?? "", step: core, files: record.coreMigrations ?? [] },
      read:
        read === null
          ? null
          : { database: record.readDatabase ?? "", step: read, files: record.readMigrations ?? [] },
    },
    workers: reported,
    summary: `${String(deployed.length)}/${String(planned.length)} deployed at ${short(String(record.sha ?? ""))}, CORE migrations ${core}${failed.length === 0 ? "" : `, failed: ${failed.map((entry) => entry.name).join(",")}`}`,
  };
}

/**
 * The Workers a progress record says were planned but not deployed.
 *
 * A `success` status is what turns a record's `planned` into "live", so it may
 * only be posted when every planned Worker really uploaded. The workflow's
 * `success()` condition already says that; this is the belt to its braces, in
 * the one place that writes the status, so that no future rewiring of the
 * steps can record a run that skipped or failed a Worker as the state.
 *
 * @param {Record<string, any>} progress
 * @returns {string[]}
 */
export function undeployedWorkers(progress) {
  const workers = Array.isArray(progress?.workers) ? progress.workers : [];
  return workers
    .filter((entry) => entry?.outcome !== "deployed" && entry?.outcome !== "kept")
    .map(
      (entry) =>
        `${String(entry?.name ?? entry?.worker ?? "(unnamed)")}: ${String(entry?.outcome)}`,
    );
}

/**
 * The lines that describe a record for a human: what it claims is live, or —
 * for the record of a deployment that did not succeed — what it may have
 * applied before it stopped.
 *
 * @param {unknown} record
 * @returns {string[]}
 */
export function describeRecord(record) {
  const normalized = normalizeRecord(record);
  if (normalized === null) return ["(no release record)"];
  const migrations = normalized.coreMigrations;
  return [
    `sha ${normalized.sha || "(unknown)"} (${normalized.mode})`,
    `CORE migrations through ${migrations.at(-1) ?? "(none)"} (${String(migrations.length)} in total)`,
    ...(normalized.readMigrations === null
      ? []
      : [
          `READ migrations through ${normalized.readMigrations.at(-1) ?? "(none)"} (${String(normalized.readMigrations.length)} in total)`,
        ]),
    ...normalized.workers.map(
      (entry) =>
        `${entry.name ?? entry.worker ?? "(unnamed)"}: ${entry.outcome} at ${short(entry.sha) || "(unknown)"}`,
    ),
  ];
}

/**
 * The newest deployment of the production environment whose latest status is
 * `success`, with the release record it carried, plus the deployments newer
 * than it that did *not* succeed.
 *
 * Only the successful one is the environment's state. The others are what a
 * failed or cancelled run left behind: their record is the plan that run was
 * working from, so it says what may have been applied before it stopped, and
 * the release job prints it rather than acting on it (finding 2).
 *
 * Fails closed: a deployment list that cannot be read, or that goes on past
 * the page read here without a successful deployment in it, is an error, never
 * an empty ledger, because an empty ledger means "deploy anything".
 *
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
 * @param {{fetchImpl?: typeof fetch, limit?: number}} [options]
 * @returns {Promise<{release: {sha: string, id: number, record: unknown} | null, attempts: {sha: string, id: number, state: string, record: unknown}[]}>}
 */
export async function readLedger(client, { fetchImpl, limit = 100 } = {}) {
  const { apiUrl, owner, repo, token } = client;
  const listed = await request(
    `${apiUrl}/repos/${owner}/${repo}/deployments?environment=${ENVIRONMENT}&per_page=${String(limit)}`,
    { token, fetchImpl },
  );
  if (!Array.isArray(listed.data)) throw new Error("the deployment list did not return a list");
  const deployments = [...listed.data].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  const attempts = [];
  for (const deployment of deployments) {
    // Not ours: GitHub's own environment deployment for the job (see
    // `isReleaseRecord`). It is neither the state nor an attempt to report.
    if (!isReleaseRecord(deployment.payload)) continue;
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
        release: {
          sha: String(deployment.sha),
          id: Number(deployment.id),
          record: deployment.payload ?? null,
        },
        attempts,
      };
    }
    attempts.push({
      sha: String(deployment.sha),
      id: Number(deployment.id),
      state: String(latest?.state ?? "none"),
      record: deployment.payload ?? null,
    });
  }
  if (listed.next !== undefined) {
    throw new Error(
      `none of the newest ${String(deployments.length)} production deployments succeeded and the list goes on; refusing to treat the ledger as empty`,
    );
  }
  return { release: null, attempts };
}

/**
 * The recorded release alone, for callers that only need the environment's
 * state.
 *
 * @param {{apiUrl: string, owner: string, repo: string, token: string}} client
 * @param {{fetchImpl?: typeof fetch, limit?: number}} [options]
 * @returns {Promise<{sha: string, id: number, record: unknown} | null>}
 */
export async function latestRelease(client, options = {}) {
  return (await readLedger(client, options)).release;
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
    const { release, attempts } = await readLedger(clientFromEnv(env));
    if (options["record"]) {
      writeFileSync(options["record"], `${JSON.stringify(release?.record ?? null, null, 2)}\n`);
    }
    const attempt = attempts[0] ?? null;
    if (options["attempt"]) {
      writeFileSync(options["attempt"], `${JSON.stringify(attempt?.record ?? null, null, 2)}\n`);
    }
    writeOutputs(
      {
        found: String(release !== null),
        sha: release?.sha ?? "",
        "deployment-id": release === null ? "" : String(release.id),
        "attempt-sha": attempt?.sha ?? "",
        "attempt-state": attempt?.state ?? "",
      },
      env,
    );
    report(
      release === null
        ? "No successful production release is recorded yet."
        : `Recorded production release: ${release.sha} (deployment ${String(release.id)}).`,
      env,
    );
    // A deployment that did not succeed is never the environment's state, but
    // it did run: it may have applied migrations and uploaded some Workers, and
    // whoever reads this run needs to know that before wondering why the next
    // decision is a resume (finding 2). The newest few are described in full;
    // a long tail of them is counted, because a repository that has never
    // released successfully has one per attempt and the summary is for reading.
    const described = attempts.slice(0, 3);
    for (const entry of described) {
      report(
        `Deployment ${String(entry.id)} for ${entry.sha} is ${entry.state}, not success; it is not the environment's state, and it may have applied:`,
        env,
      );
      for (const line of describeRecord(entry.record)) report(`  ${line}`, env);
    }
    if (attempts.length > described.length) {
      report(
        `and ${String(attempts.length - described.length)} older production deployment(s) that did not succeed either.`,
        env,
      );
    }
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
    const root = options["root"] ?? process.cwd();
    const order = JSON.parse(
      readFileSync(options["order"] ?? `${root}/infra/deploy-order.json`, "utf8"),
    );
    const deployable = (order.workers ?? [])
      .filter((worker) => worker.deploy === true)
      .map((worker) => ({ name: String(worker.name), worker: String(worker.worker) }));
    const previousFile = options["previous"] ?? "";
    const previous =
      previousFile === "" || !existsSync(previousFile)
        ? null
        : JSON.parse(readFileSync(previousFile, "utf8"));
    const targets = (options["targets"] ?? "").split(/[\s,]+/u).filter((target) => target !== "");
    const decision = decideRelease({
      mode,
      head,
      recorded,
      previous,
      deployable,
      targets,
      isAncestor: (a, b) => gitIsAncestor(a, b, root),
    });
    if (options["plan"]) {
      writeFileSync(
        options["plan"],
        `${JSON.stringify(
          {
            mode,
            sha: head,
            proceed: decision.proceed,
            selected: decision.selected,
            kept: decision.kept,
          },
          null,
          2,
        )}\n`,
      );
    }
    writeOutputs(
      { proceed: String(decision.proceed), selected: JSON.stringify(decision.selected) },
      env,
    );
    report(`${decision.proceed ? "Proceeding" : "Not deploying"}: ${decision.reason}`, env);
    for (const note of decision.notes) report(`  ${note}`, env);
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
  if (command === "progress") {
    const recordFile = options["record"] ?? "release-record.json";
    if (!existsSync(recordFile)) {
      // The run stopped before the release record was written — before the
      // deployment was opened, so there is nothing to account for.
      report("No release record was written; this run changed nothing.", env);
      return 0;
    }
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    // The job passes its own `steps` context; an empty one means "no step ran",
    // which is what a run that failed before the first upload looks like.
    const steps = JSON.parse(env["STEPS_JSON"] ?? "{}");
    const progress = releaseProgress(record, steps);
    writeFileSync(
      options["out"] ?? "release-progress.json",
      `${JSON.stringify(progress, null, 2)}\n`,
    );
    writeOutputs({ summary: String(progress["summary"]) }, env);
    report(`This run: ${String(progress["summary"])}`, env);
    for (const entry of /** @type {any[]} */ (progress["workers"])) {
      // "at" only for a Worker that is really there; for one whose upload
      // failed or never ran, the sha is what this run *planned*, and saying so
      // is the difference between a log and a wrong log.
      const where =
        entry.outcome === "deployed" || entry.outcome === "kept"
          ? `at ${short(String(entry.sha))}`
          : `(planned ${short(String(entry.sha))})`;
      report(
        `  ${String(entry.name ?? entry.worker)}: ${String(entry.outcome)} ${where}${entry.targets ? ` ${String(entry.targets)}` : ""}`,
        env,
      );
    }
    return 0;
  }
  if (command === "status") {
    const id = Number(options["deployment"]);
    if (!Number.isSafeInteger(id)) throw new Error("--deployment must be a deployment id");
    // The payload of a deployment is fixed when it is created, so what the run
    // actually did goes into the status description (and, in full, into the
    // uploaded progress artefact).
    const progressFile = options["progress"] ?? "";
    const progress =
      progressFile === "" || !existsSync(progressFile)
        ? null
        : JSON.parse(readFileSync(progressFile, "utf8"));
    const state = options["state"] ?? "failure";
    if (state === "success" && progress !== null) {
      const undeployed = undeployedWorkers(progress);
      if (undeployed.length > 0) {
        throw new Error(
          `refusing to record deployment ${String(id)} as success: ${undeployed.join(", ")}`,
        );
      }
    }
    const summary = String(progress?.["summary"] ?? "");
    const description = [options["description"] ?? "", summary]
      .filter((part) => part !== "")
      .join(" — ");
    await setDeploymentStatus(clientFromEnv(env), {
      id,
      state,
      description,
      ...(options["log-url"] ? { logUrl: options["log-url"] } : {}),
    });
    report(`Deployment ${String(id)} recorded as ${state}: ${description}`, env);
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
